import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, link, mkdir, readdir, realpath, rm, stat, symlink } from "node:fs/promises";
import { basename, extname, join, relative, sep } from "node:path";
import { type FSWatcher, watch } from "chokidar";
import {
  type AssetImportResult,
  type AssetInfo,
  ErrorCode,
  type JobInfo,
  type MediaProbe,
  RpcError,
} from "@frameshell/protocol";
import type { BinaryManager } from "../binaries/manager.js";
import type { JobQueue } from "../jobs/queue.js";
import { readEnclosingProject } from "../projects.js";
import { probeMedia } from "./ffmpeg.js";
import { type MediaTools, ingestAsset } from "./ingest.js";
import { MediaStore, hashFile } from "./store.js";
import { renameRetrying } from "../fs-util.js";

/** Project-relative directory the watcher and import own. */
const ASSETS_DIR = "assets";

/** Options for {@link MediaService}. */
export interface MediaServiceOptions {
  binaries: BinaryManager;
  jobs: JobQueue;
  /** Watch `assets/` of attached projects. Default true. */
  watch?: boolean;
  /**
   * An asset's ingest state changed or its file left `assets/` (`asset` null).
   * Called in order per asset with what {@link MediaService.list} reports at that moment.
   */
  onAssetChanged?: (root: string, path: string, asset: AssetInfo | null) => void;
}

interface Attached {
  store: MediaStore;
  watcher: FSWatcher | null;
  /** Stat of each asset when its last ingest started: the watcher skips files it already tried. */
  attempted: Map<string, { size: number; mtimeMs: number }>;
}

/**
 * Asset ingestion (SPEC §6.3): import into `assets/`, a watcher that queues
 * new or changed files, and the per-asset view of derived media. Ingest runs
 * on the shared {@link JobQueue}, so it outlives the client that asked.
 */
export class MediaService {
  readonly #binaries: BinaryManager;
  readonly #jobs: JobQueue;
  readonly #watch: boolean;
  readonly #projects = new Map<string, Attached>();
  readonly #locks = new Map<string, Promise<void>>();
  /** On-demand probes keyed by root, path, size and mtime. */
  readonly #probes = new Map<string, Promise<MediaProbe>>();
  readonly #onAssetChanged: MediaServiceOptions["onAssetChanged"];
  /** Tail of each asset's report chain (root + path): reports never overtake each other. */
  readonly #reports = new Map<string, Promise<void>>();
  #closed = false;

  constructor(options: MediaServiceOptions) {
    this.#binaries = options.binaries;
    this.#jobs = options.jobs;
    this.#watch = options.watch ?? true;
    this.#onAssetChanged = options.onAssetChanged;
    // Only state moves change what `list` says; progress within a state is the queue's own news.
    this.#jobs.watch(({ job, stateChanged }) => {
      if (job.kind === "ingest" && stateChanged) this.#report(job.project, job.asset);
    });
  }

  /**
   * Start watching the project rooted at `root`. Idempotent. The first scan
   * queues every asset without complete outputs, which also resumes work a
   * previous daemon did not finish.
   */
  attach(root: string): void {
    if (this.#closed || this.#projects.has(root)) return;
    const attached: Attached = { store: new MediaStore(root), watcher: null, attempted: new Map() };
    this.#projects.set(root, attached);
    if (!this.#watch) return;
    const watcher = watch(join(root, ASSETS_DIR), {
      ignored: (path) => isIgnored(basename(path)),
      awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 50 },
    });
    const onFile = (path: string) => void this.#autoIngest(root, path).catch(() => {});
    watcher.on("add", onFile).on("change", onFile);
    watcher.on("unlink", (path) => {
      const rel = toRel(root, path);
      void attached.store
        .forget(rel)
        .catch(() => {})
        .then(() => this.#report(root, rel));
    });
    // A vanished or unreadable assets/ must not crash the daemon.
    watcher.on("error", () => {});
    attached.watcher = watcher;
  }

  /**
   * Bring `files` into `assets/` and queue their ingest. Every source is
   * checked before anything is copied. Throws `AssetNotFound`.
   */
  async import(root: string, files: string[], mode: "copy" | "link"): Promise<AssetImportResult> {
    const attached = this.#attached(root);
    for (const file of files) {
      const info = await stat(file).catch(() => null);
      if (!info?.isFile()) {
        throw new RpcError(ErrorCode.AssetNotFound, `${file} is not a file. Pass the path of a media file to import.`, {
          path: file,
        });
      }
    }
    const assetsDir = join(root, ASSETS_DIR);
    await mkdir(assetsDir, { recursive: true });
    const realAssets = await realpath(assetsDir);
    const imported: AssetImportResult["imported"] = [];
    for (const source of files) {
      const real = await realpath(source);
      const inside = relative(realAssets, real);
      let rel: string;
      let copied = false;
      if (inside && !inside.startsWith("..") && !inside.startsWith(sep) && !/^[a-zA-Z]:/.test(inside)) {
        rel = `${ASSETS_DIR}/${inside.split(sep).join("/")}`;
      } else {
        ({ rel, copied } = await this.#place(attached.store, real, basename(source), mode));
      }
      const job = this.#enqueue(root, rel);
      imported.push({ source, asset: rel, copied, job });
    }
    return { dir: root, imported };
  }

  /** Every file under `assets/`, sorted, with ingest state and derived files. */
  async list(root: string): Promise<AssetInfo[]> {
    const { store } = this.#attached(root);
    const rels = await listFiles(join(root, ASSETS_DIR), ASSETS_DIR);
    const jobs = this.#jobs.list({ project: root });
    const fps = (await readEnclosingProject(root))?.config.fps ?? 30;
    const assets: AssetInfo[] = [];
    for (const rel of rels.sort()) assets.push(await describeAsset(store, rel, jobs, fps));
    return assets;
  }

  /**
   * Content hash of `rel` (reusing the index while size and mtime match) and
   * the PCM sidecar of a complete ingest of that content at the project fps.
   * `sidecar` is null when no complete manifest exists or the asset has no
   * audio. Never queues or awaits ingest.
   */
  async derivedAudio(
    root: string,
    rel: string,
    onProgress?: (fraction: number) => void,
  ): Promise<{ hash: string; sidecar: AssetInfo["sidecar"] }> {
    const { store } = this.#attached(root);
    const hash = await store.hash(rel, onProgress);
    const fps = (await readEnclosingProject(root))?.config.fps ?? 30;
    const manifest = await store.manifest(store.key(hash, fps));
    return { hash, sidecar: manifest?.sidecar ?? null };
  }

  /**
   * ffprobe summary of `rel` (project-relative). Taken from a complete ingest
   * of the current content when there is one, else probed now (sub-second)
   * and cached while size and mtime hold: timeline edits never wait for
   * proxies. Throws `AssetNotFound` when `rel` is not a file, {@link ToolError}
   * when ffprobe cannot read it.
   */
  async probe(root: string, rel: string): Promise<MediaProbe> {
    const { store } = this.#attached(root);
    const current = await stat(store.abs(rel)).catch(() => null);
    if (!current?.isFile()) {
      throw new RpcError(ErrorCode.AssetNotFound, `${rel} is not a file in ${root}. Import it first: \`frameshell import <file>\`.`, {
        path: rel,
      });
    }
    const project = await readEnclosingProject(root);
    const hash = await store.knownHash(rel);
    const manifest = hash ? await store.manifest(store.key(hash, project?.config.fps ?? 30)) : null;
    if (manifest) return manifest.media;
    const key = `${root}\0${rel}\0${current.size}\0${current.mtimeMs}`;
    let probed = this.#probes.get(key);
    if (!probed) {
      const overrides = project ? { dir: project.dir, binaries: project.config.binaries } : undefined;
      probed = this.#binaries.ensure("ffprobe", overrides).then((ffprobe) => probeMedia(ffprobe, store.abs(rel)));
      this.#probes.set(key, probed);
      probed.catch(() => this.#probes.delete(key));
    }
    return probed;
  }

  /** Stop watching. Running jobs are the queue's to stop. */
  async close(): Promise<void> {
    this.#closed = true;
    const watchers = [...this.#projects.values()].flatMap(({ watcher }) => (watcher ? [watcher] : []));
    this.#projects.clear();
    await Promise.all(watchers.map((watcher) => watcher.close()));
  }

  #attached(root: string): Attached {
    this.attach(root);
    return this.#projects.get(root) ?? { store: new MediaStore(root), watcher: null, attempted: new Map() };
  }

  /**
   * Tell `onAssetChanged` what `list` now says about `rel` (null when it is no
   * longer a file). Chained per asset, so a slow read never lands after a newer one.
   */
  #report(root: string, rel: string): void {
    const onAssetChanged = this.#onAssetChanged;
    if (!onAssetChanged || this.#closed || !this.#projects.has(root)) return;
    const key = `${root}\0${rel}`;
    const tail = (this.#reports.get(key) ?? Promise.resolve()).then(async () => {
      const { store } = this.#attached(root);
      const current = await stat(store.abs(rel)).catch(() => null);
      let asset: AssetInfo | null = null;
      if (current?.isFile()) {
        const fps = (await readEnclosingProject(root))?.config.fps ?? 30;
        asset = await describeAsset(store, rel, this.#jobs.list({ project: root }), fps);
      }
      if (!this.#closed) onAssetChanged(root, rel, asset);
    });
    const settled = tail.catch(() => {});
    this.#reports.set(key, settled);
    void settled.then(() => {
      if (this.#reports.get(key) === settled) this.#reports.delete(key);
    });
  }

  /** Watcher path: skip files already tried at this exact size and mtime. */
  async #autoIngest(root: string, path: string): Promise<void> {
    const attached = this.#projects.get(root);
    if (!attached) return;
    const rel = toRel(root, path);
    const current = await stat(path).catch(() => null);
    if (!current?.isFile()) return;
    const tried = attached.attempted.get(rel);
    if (tried && tried.size === current.size && tried.mtimeMs === current.mtimeMs) return;
    const fps = (await readEnclosingProject(root))?.config.fps ?? 30;
    const hash = await attached.store.knownHash(rel);
    if (hash && (await attached.store.manifest(attached.store.key(hash, fps)))) return;
    this.#enqueue(root, rel);
  }

  #enqueue(root: string, rel: string): JobInfo {
    return this.#jobs.enqueue({
      kind: "ingest",
      project: root,
      asset: rel,
      run: async (ctx) => {
        const attached = this.#attached(root);
        const current = await stat(attached.store.abs(rel)).catch(() => null);
        if (!current) throw new Error(`${rel} no longer exists`);
        attached.attempted.set(rel, { size: current.size, mtimeMs: current.mtimeMs });
        const project = await readEnclosingProject(root);
        if (!project) throw new Error(`${root} is no longer a Frameshell project`);
        const binaries = { dir: project.dir, binaries: project.config.binaries };
        await ingestAsset({
          store: attached.store,
          rel,
          fps: project.config.fps,
          ctx,
          tools: async (): Promise<MediaTools> => ({
            ffmpeg: await this.#binaries.ensure("ffmpeg", binaries),
            ffprobe: await this.#binaries.ensure("ffprobe", binaries),
          }),
          lock: (key) => this.#lock(key),
        });
      },
    });
  }

  /** Mutex per cache key. */
  async #lock(key: string): Promise<() => void> {
    for (let held = this.#locks.get(key); held; held = this.#locks.get(key)) await held;
    let release!: () => void;
    this.#locks.set(key, new Promise<void>((resolve) => (release = resolve)));
    return () => {
      this.#locks.delete(key);
      release();
    };
  }

  /**
   * Copy or link `source` to `assets/<name>`. A taken name with the same bytes
   * is reused; different bytes get `-2`, `-3`… Copies land under a dot name
   * first (ignored by the watcher) and appear by rename.
   */
  async #place(store: MediaStore, source: string, name: string, mode: "copy" | "link"): Promise<{ rel: string; copied: boolean }> {
    const sourceStat = await stat(source);
    let sourceHash: string | undefined;
    const ext = extname(name);
    const stem = name.slice(0, name.length - ext.length);
    for (let n = 1; ; n++) {
      const candidate = n === 1 ? name : `${stem}-${n}${ext}`;
      const rel = `${ASSETS_DIR}/${candidate}`;
      const target = store.abs(rel);
      const existing = await stat(target).catch(() => null);
      if (existing) {
        if (existing.size !== sourceStat.size) continue;
        sourceHash ??= await hashFile(source, sourceStat.size);
        const targetHash = (await store.knownHash(rel)) ?? (await store.hash(rel));
        if (targetHash === sourceHash) return { rel, copied: false };
        continue;
      }
      if (mode === "link") {
        await linkOrSymlink(source, target);
      } else {
        const temp = join(store.abs(ASSETS_DIR), `.${candidate}.importing-${randomUUID().slice(0, 8)}`);
        try {
          // Clone on APFS/Btrfs/ReFS: instant and no extra space; plain copy elsewhere.
          await copyFile(source, temp, constants.COPYFILE_FICLONE);
          await renameRetrying(temp, target);
        } finally {
          await rm(temp, { force: true });
        }
      }
      const placed = await stat(target);
      if (sourceHash) await store.remember(rel, { size: placed.size, mtimeMs: placed.mtimeMs, hash: sourceHash });
      return { rel, copied: true };
    }
  }
}

/** One asset as `asset.list` reports it; `jobs` are the project's, oldest first. */
async function describeAsset(store: MediaStore, rel: string, jobs: JobInfo[], fps: number): Promise<AssetInfo> {
  const last = jobs.filter((job) => job.kind === "ingest" && job.asset === rel).at(-1);
  const hash = await store.knownHash(rel);
  const manifest = hash ? await store.manifest(store.key(hash, fps)) : null;
  const active = last?.state === "queued" || last?.state === "running";
  const state: AssetInfo["state"] = active ? "processing" : manifest ? "ready" : last?.state === "failed" ? "failed" : "pending";
  return {
    path: rel,
    hash,
    state,
    error: state === "failed" ? (last?.error ?? null) : null,
    media: manifest?.media ?? null,
    proxy: manifest?.proxy ?? null,
    sidecar: manifest?.sidecar ?? null,
    waveform: manifest?.waveform ?? null,
    thumbnails: manifest?.thumbnails ?? null,
  };
}

/** Hard link; across volumes (EXDEV) a symlink, which needs the source to stay. */
async function linkOrSymlink(source: string, target: string): Promise<void> {
  try {
    await link(source, target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    try {
      await symlink(source, target);
    } catch (inner) {
      throw new Error(
        `Cannot link ${source} into assets/ (${(inner as Error).message}). Import with mode "copy" instead.`,
        { cause: inner },
      );
    }
  }
}

/** Dotfiles (our own import temps included) and browser/partial downloads are never assets. */
function isIgnored(name: string): boolean {
  return name.startsWith(".") || /\.(part|partial|tmp|crdownload|download)$/i.test(name);
}

function toRel(root: string, path: string): string {
  return relative(root, path).split(sep).join("/");
}

async function listFiles(dir: string, rel: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const files: string[] = [];
  for (const entry of entries) {
    if (isIgnored(entry.name)) continue;
    const childRel = `${rel}/${entry.name}`;
    if (entry.isDirectory()) files.push(...(await listFiles(join(dir, entry.name), childRel)));
    else if (entry.isFile() || entry.isSymbolicLink()) files.push(childRel);
  }
  return files;
}
