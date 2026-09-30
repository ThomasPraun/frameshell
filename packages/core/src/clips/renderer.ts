import { randomBytes } from "node:crypto";
import { copyFile, mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { type FSWatcher, watch } from "chokidar";
import { type ClipRenderInfo, type ClipRendersResult, ErrorCode, type JobInfo, RpcError } from "@frameshell/protocol";
import type { ClipAdapter } from "@frameshell/plugin-api";
import type { AdapterClip, Timeline } from "@frameshell/schema";
import { readJsonIfExists, writeJsonAtomic } from "../fs-util.js";
import type { JobContext, JobQueue } from "../jobs/queue.js";
import { hashFile } from "../media/store.js";
import { clipCacheKey } from "./cache-key.js";

/** Project-relative directory of the clip render cache (SPEC §5.1, §6.5). */
export const CLIP_CACHE_DIR = ".frameshell/cache/clips";

/** An adapter with the plugin that registered it: its name and version are part of the cache key. */
export interface RegisteredClipType {
  adapter: ClipAdapter;
  plugin: { name: string; version: string };
}

/** Project format a render is made for. */
export interface ClipFormat {
  fps: number;
  width: number;
  height: number;
}

/** A cached render, ready to play or overlay. */
export interface RenderedClip {
  /** Absolute file. */
  path: string;
  /** Project-relative, `/`-separated. */
  file: string;
  hasAlpha: boolean;
  width: number;
  height: number;
  /** Seconds; null when the container does not say. */
  duration: number | null;
}

/** What the renderer learns from ffprobe about a finished render. */
export interface RenderProbe {
  width: number;
  height: number;
  duration: number | null;
}

/** Options for {@link ClipRenderer}. */
export interface ClipRendererOptions {
  /** Queue the `clip` jobs run on. Its own queue: an export job waits for clip jobs, so they must never share slots. */
  jobs: JobQueue;
  /** Adapters of the project's loaded plugins, by clip type; empty when untrusted. See `PluginHost.clipAdapters`. */
  adapters(root: string): Promise<ReadonlyMap<string, RegisteredClipType>>;
  /** Why no adapter renders `type` in `root` (not installed, not trusted), for `unavailable` states. */
  unavailable?(root: string, type: string): Promise<string>;
  /** Timeline ids of the project (`timelines/<id>.json`). */
  timelines(root: string): Promise<string[]>;
  /** Parsed timeline; see `TimelineService.load`. */
  load(root: string, id: string): Promise<{ timeline: Timeline }>;
  /**
   * Timeline file as on disk, read without side effects: background scans
   * must never race the timeline service taking in a direct edit. Throws when
   * missing or invalid.
   */
  peek(root: string, id: string): Promise<Timeline>;
  /** Project fps and resolution from `frameshell.json`. */
  format(root: string): Promise<ClipFormat>;
  /** Size and length of a finished render (ffprobe). */
  probe(root: string, file: string, signal: AbortSignal): Promise<RenderProbe>;
  /** Managed or overridden native tool for adapters; see `RenderContext.ensureBinary`. */
  ensureBinary(root: string, name: string): Promise<string>;
  /** Watch attached projects for composition edits. Default true. */
  watch?: boolean;
  /** Quiet time after the last file event before re-checking keys. Default 200 ms. */
  debounceMs?: number;
}

/** A generated clip as found on a timeline. */
interface Placed {
  clip: AdapterClip;
  track: string;
}

/** Key of a clip, or why it has none. */
type Keyed = { key: string; registered: RegisteredClipType } | { key: null; error: string };

interface Pending {
  job: string;
  done: Promise<RenderedClip>;
}

/** Cache entry metadata, written after the media file: its presence marks a complete entry. */
interface EntryMeta {
  file: string;
  hasAlpha: boolean;
  width: number;
  height: number;
  duration: number | null;
  plugin: string;
  version: string;
  type: string;
  source: string | null;
  renderedAt: string;
}

/**
 * Clip render cache (SPEC §6.5): renders every generated clip (adapter
 * clips: `hyperframes`, …) of a project in the background into
 * `.frameshell/cache/clips/<key>.<ext>`, keyed by {@link clipCacheKey}.
 * Unchanged clips reuse their entry; a changed composition, props or project
 * format gives a new key and so a new render. Entries are regenerable.
 *
 * Renders start when a project is attached, when {@link refresh} runs (the
 * daemon calls it on every timeline change), and when a file under the
 * project changes (composition edits). A failed key is not retried by
 * refreshes until its inputs change; {@link ensure} (export) retries it.
 */
export class ClipRenderer {
  readonly #options: ClipRendererOptions;
  readonly #pending = new Map<string, Pending>();
  readonly #failed = new Map<string, string>();
  readonly #watchers = new Map<string, FSWatcher>();
  readonly #timers = new Map<string, NodeJS.Timeout>();
  /** Per root: the running refresh, and whether another was asked for meanwhile. */
  readonly #refreshing = new Map<string, { run: Promise<void>; again: boolean }>();
  /** Input file hashes by absolute path, valid while size and mtime match. */
  readonly #hashes = new Map<string, { size: number; mtimeMs: number; hash: string }>();
  /** Settles the promise of each job the renderer queued, by job id. */
  readonly #settle = new Map<string, (job: JobInfo) => void>();
  #closed = false;

  constructor(options: ClipRendererOptions) {
    this.#options = options;
    options.jobs.watch(({ job, stateChanged }) => {
      if (!stateChanged || job.state === "queued" || job.state === "running") return;
      this.#settle.get(job.id)?.(job);
      this.#settle.delete(job.id);
    });
  }

  /** Watch `root` for composition edits and render what is missing. Idempotent. */
  attach(root: string): void {
    if (this.#closed || this.#watchers.has(root)) return;
    if (this.#options.watch !== false) {
      const watcher = watch(root, {
        ignoreInitial: true,
        // Only files and folders: watching a FIFO or socket can block a libuv thread forever.
        ignored: (path, stats) =>
          IGNORED.has(relative(root, path).split(sep)[0] ?? "") || (stats !== undefined && !stats.isFile() && !stats.isDirectory()),
      });
      watcher.on("all", () => this.#schedule(root));
      // A vanished project must not crash the daemon.
      watcher.on("error", () => {});
      this.#watchers.set(root, watcher);
    }
    void this.refresh(root).catch(() => {});
  }

  /**
   * Queue a render for every generated clip of every timeline whose key has
   * no cache entry yet. Never waits for renders. Concurrent calls coalesce.
   */
  refresh(root: string): Promise<void> {
    const current = this.#refreshing.get(root);
    if (current) {
      current.again = true;
      return current.run;
    }
    const state = { run: Promise.resolve(), again: false };
    state.run = (async () => {
      try {
        do {
          state.again = false;
          await this.#refreshOnce(root);
        } while (state.again && !this.#closed);
      } finally {
        this.#refreshing.delete(root);
      }
    })();
    this.#refreshing.set(root, state);
    return state.run;
  }

  /** Render state of every generated clip of timeline `id`; queues renders that are due. */
  async status(root: string, id: string): Promise<ClipRendersResult> {
    const { timeline } = await this.#options.load(root, id);
    const placed = generatedClips(timeline);
    const adapters = placed.length > 0 ? await this.#options.adapters(root) : new Map<string, RegisteredClipType>();
    const format = await this.#options.format(root);
    const clips: ClipRenderInfo[] = [];
    for (const { clip, track } of placed) {
      const keyed = await this.#keyOf(root, clip, adapters, format);
      const info: ClipRenderInfo = {
        clip: clip.id,
        track,
        type: clip.type,
        source: clip.source ?? null,
        state: "unavailable",
        key: keyed.key,
        file: null,
        hasAlpha: null,
        width: null,
        height: null,
        duration: null,
        job: null,
        progress: 0,
        error: null,
      };
      if (keyed.key === null) {
        info.error = keyed.error;
        clips.push(info);
        continue;
      }
      const ready = await this.#ready(root, keyed.key);
      if (ready) {
        clips.push({ ...info, state: "ready", file: ready.file, hasAlpha: ready.hasAlpha, width: ready.width, height: ready.height, duration: ready.duration, progress: 1 });
        continue;
      }
      const failed = this.#failed.get(entryId(root, keyed.key));
      if (failed !== undefined) {
        clips.push({ ...info, state: "failed", error: failed });
        continue;
      }
      const pending = this.#render(root, keyed.key, clip, keyed.registered, format);
      const job = this.#options.jobs.get(pending.job);
      clips.push({ ...info, state: job?.state === "running" ? "rendering" : "queued", job: pending.job, progress: job?.progress ?? 0 });
    }
    return { timeline: timeline.id, revision: timeline.revision, clips };
  }

  /**
   * Cached render of every generated clip on a video track of `timeline`,
   * by clip id, rendering missing ones first (SPEC §3.5 step 2). Retries
   * failed keys. Throws `ClipRenderFailed` for the first clip that cannot be
   * rendered, or has no adapter. `onProgress` gets the share of clips done.
   */
  async ensure(root: string, timeline: Timeline, onProgress?: (fraction: number) => void): Promise<Map<string, RenderedClip>> {
    const placed = generatedClips(timeline);
    const rendered = new Map<string, RenderedClip>();
    if (placed.length === 0) return rendered;
    const adapters = await this.#options.adapters(root);
    const format = await this.#options.format(root);
    const waits: { clip: AdapterClip; done: Promise<RenderedClip> }[] = [];
    for (const { clip } of placed) {
      const keyed = await this.#keyOf(root, clip, adapters, format);
      if (keyed.key === null) throw renderFailed(timeline.id, clip, keyed.error);
      const ready = await this.#ready(root, keyed.key);
      if (ready) {
        rendered.set(clip.id, ready);
        continue;
      }
      this.#failed.delete(entryId(root, keyed.key));
      waits.push({ clip, done: this.#render(root, keyed.key, clip, keyed.registered, format).done });
    }
    let done = rendered.size;
    onProgress?.(done / placed.length);
    for (const { clip, done: render } of waits) {
      try {
        rendered.set(clip.id, await render);
      } catch (error) {
        throw renderFailed(timeline.id, clip, (error as Error).message);
      }
      onProgress?.(++done / placed.length);
    }
    return rendered;
  }

  /**
   * Keys the checks of {@link ensure} without rendering: throws
   * `ClipRenderFailed` when a generated clip of `timeline` has no adapter.
   */
  async check(root: string, timeline: Timeline): Promise<void> {
    const placed = generatedClips(timeline);
    if (placed.length === 0) return;
    const adapters = await this.#options.adapters(root);
    const format = await this.#options.format(root);
    for (const { clip } of placed) {
      const keyed = await this.#keyOf(root, clip, adapters, format);
      if (keyed.key === null) throw renderFailed(timeline.id, clip, keyed.error);
    }
  }

  /** Stop watching. Running renders are the queue's to stop. */
  async close(): Promise<void> {
    this.#closed = true;
    for (const timer of this.#timers.values()) clearTimeout(timer);
    this.#timers.clear();
    const watchers = [...this.#watchers.values()];
    this.#watchers.clear();
    await Promise.all(watchers.map((watcher) => watcher.close()));
  }

  #schedule(root: string): void {
    if (this.#closed) return;
    clearTimeout(this.#timers.get(root));
    const timer = setTimeout(() => {
      this.#timers.delete(root);
      void this.refresh(root).catch(() => {});
    }, this.#options.debounceMs ?? 200);
    timer.unref?.();
    this.#timers.set(root, timer);
  }

  async #refreshOnce(root: string): Promise<void> {
    const placed: Placed[] = [];
    for (const id of await this.#options.timelines(root)) {
      try {
        placed.push(...generatedClips(await this.#options.peek(root, id)));
      } catch {
        // Invalid or vanished timeline: its own errors surface where it is used.
      }
    }
    // No generated clips: never load plugins (an untrusted project stays untouched).
    if (placed.length === 0) return;
    const adapters = await this.#options.adapters(root);
    const format = await this.#options.format(root);
    for (const { clip } of placed) {
      if (this.#closed) return;
      const keyed = await this.#keyOf(root, clip, adapters, format);
      if (keyed.key === null || this.#failed.has(entryId(root, keyed.key))) continue;
      if (await this.#ready(root, keyed.key)) continue;
      this.#render(root, keyed.key, clip, keyed.registered, format);
    }
  }

  async #keyOf(root: string, clip: AdapterClip, adapters: ReadonlyMap<string, RegisteredClipType>, format: ClipFormat): Promise<Keyed> {
    const registered = adapters.get(clip.type);
    if (!registered) {
      const reason = (await this.#options.unavailable?.(root, clip.type)) ?? `No loaded plugin renders \`${clip.type}\` clips.`;
      return { key: null, error: reason };
    }
    let paths: string[];
    try {
      paths = registered.adapter.inputs ? await registered.adapter.inputs(structuredClone(clip)) : [];
    } catch (error) {
      return { key: null, error: `${registered.plugin.name} could not list the inputs of ${clip.id}: ${(error as Error)?.message ?? error}` };
    }
    const inputs = await Promise.all(paths.map(async (path) => ({ path, hash: await this.#hashInput(root, path) })));
    return { key: clipCacheKey({ plugin: registered.plugin, clip, inputs, format }), registered };
  }

  /** Content hash of a project-relative input; null when missing or outside the project. */
  async #hashInput(root: string, rel: string): Promise<string | null> {
    const path = resolve(root, ...rel.split("/"));
    const inside = relative(root, path);
    if (inside === "" || inside.startsWith("..") || isAbsolute(inside)) return null;
    try {
      const info = await stat(path);
      if (!info.isFile()) return null;
      const known = this.#hashes.get(path);
      if (known && known.size === info.size && known.mtimeMs === info.mtimeMs) return known.hash;
      const hash = await hashFile(path, info.size);
      this.#hashes.set(path, { size: info.size, mtimeMs: info.mtimeMs, hash });
      return hash;
    } catch {
      return null;
    }
  }

  /** Complete cache entry of `key`, or null. */
  async #ready(root: string, key: string): Promise<RenderedClip | null> {
    const dir = join(root, ...CLIP_CACHE_DIR.split("/"));
    const meta = (await readJsonIfExists(join(dir, `${key}.json`)).catch(() => undefined)) as EntryMeta | undefined;
    if (!meta || typeof meta.file !== "string" || meta.file.includes("/") || meta.file.includes("\\")) return null;
    const path = join(dir, meta.file);
    if (!(await stat(path).then((info) => info.isFile(), () => false))) return null;
    return { path, file: `${CLIP_CACHE_DIR}/${meta.file}`, hasAlpha: meta.hasAlpha, width: meta.width, height: meta.height, duration: meta.duration };
  }

  /** The pending render of `key`, queueing one when none runs. */
  #render(root: string, key: string, clip: AdapterClip, registered: RegisteredClipType, format: ClipFormat): Pending {
    const id = entryId(root, key);
    const running = this.#pending.get(id);
    if (running) return running;
    const dir = join(root, ...CLIP_CACHE_DIR.split("/"));
    let settle!: (job: JobInfo) => void;
    const finished = new Promise<JobInfo>((resolve) => (settle = resolve));
    const snapshot = structuredClone(clip);
    const info = this.#options.jobs.enqueue({
      kind: "clip",
      project: root,
      asset: clip.source ?? `${clip.type}:${clip.id}`,
      output: join(dir, key),
      run: (ctx) => this.#run(root, dir, key, snapshot, registered, format, ctx),
    });
    const done = (async () => {
      const job = info.state === "canceled" ? info : await finished;
      if (job.state === "done") {
        const ready = await this.#ready(root, key);
        if (ready) return ready;
        throw new Error(`the render of ${clip.id} finished but left no cache entry`);
      }
      throw new Error(job.error ?? `the render of ${clip.id} was canceled`);
    })();
    if (info.state !== "canceled") this.#settle.set(info.id, settle);
    const pending: Pending = { job: info.id, done };
    this.#pending.set(id, pending);
    // Kept for status until settled; a failure is remembered so refreshes do not loop on it.
    done.then(
      () => this.#pending.delete(id),
      (error: unknown) => {
        this.#pending.delete(id);
        if (info.state !== "canceled" && !this.#closed) this.#failed.set(id, (error as Error).message);
      },
    );
    return pending;
  }

  async #run(
    root: string,
    dir: string,
    key: string,
    clip: AdapterClip,
    registered: RegisteredClipType,
    format: ClipFormat,
    ctx: JobContext,
  ): Promise<void> {
    ctx.update({ step: "render", progress: 0 });
    const outDir = join(dir, `.tmp-${key}-${randomBytes(4).toString("hex")}`);
    await mkdir(outDir, { recursive: true });
    try {
      const result = await registered.adapter.render(clip, {
        projectDir: root,
        outDir,
        ...format,
        signal: ctx.signal,
        ensureBinary: (name) => this.#options.ensureBinary(root, name),
        progress: ({ fraction }) => {
          if (Number.isFinite(fraction)) ctx.update({ progress: Math.min(0.99, Math.max(0, fraction)) });
        },
      });
      if (typeof result?.file !== "string" || typeof result.hasAlpha !== "boolean") {
        throw new Error(`${registered.plugin.name} returned no { file, hasAlpha } for ${clip.id}`);
      }
      const produced = resolve(outDir, result.file);
      const ext = extname(produced).toLowerCase();
      if (!(await stat(produced).then((info) => info.isFile() && info.size > 0, () => false))) {
        throw new Error(`${registered.plugin.name} reported ${result.file}, but it is missing or empty`);
      }
      // ADR 0002: alpha only survives as VP9 WebM, the one alpha format Chromium's <video> plays.
      if (result.hasAlpha ? ext !== ".webm" : ext !== ".mp4" && ext !== ".webm") {
        throw new Error(
          `${registered.plugin.name} rendered ${ext || "a file without extension"}; ` +
            (result.hasAlpha ? "renders with alpha must be VP9 WebM (.webm)." : "opaque renders must be .mp4 (H.264) or .webm."),
        );
      }
      const probed = await this.#options.probe(root, produced, ctx.signal);
      const file = `${key}${ext}`;
      await moveFile(produced, join(dir, file));
      const meta: EntryMeta = {
        file,
        hasAlpha: result.hasAlpha,
        width: probed.width,
        height: probed.height,
        duration: probed.duration,
        plugin: registered.plugin.name,
        version: registered.plugin.version,
        type: clip.type,
        source: clip.source ?? null,
        renderedAt: new Date().toISOString(),
      };
      await writeJsonAtomic(join(dir, `${key}.json`), meta);
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  }
}

/** Top-level project entries whose changes never feed a render: daemon state, timelines (refreshed on change), VCS, exports. */
const IGNORED = new Set([".frameshell", ".git", "node_modules", "timelines", "exports"]);

function entryId(root: string, key: string): string {
  return `${root}\0${key}`;
}

/** Adapter clips on video tracks, in track then time order. */
export function generatedClips(timeline: Timeline): Placed[] {
  const placed: Placed[] = [];
  for (const track of timeline.tracks) {
    if (track.kind !== "video") continue;
    for (const clip of track.clips) {
      if (clip.type !== "media" && clip.type !== "timeline") placed.push({ clip: clip as AdapterClip, track: track.id });
    }
  }
  return placed;
}

function renderFailed(timeline: string, clip: AdapterClip, details: string): RpcError {
  return new RpcError(
    ErrorCode.ClipRenderFailed,
    `Could not render ${clip.type} clip ${clip.id} of timeline ${timeline}: ${details} ` +
      "Fix the composition (or install and trust the plugin that renders it), then retry; " +
      `\`frameshell clip remove ${clip.id}\` drops the clip.`,
    { clip: clip.id, type: clip.type, timeline, details },
  );
}

/** Rename, or copy when the adapter wrote across devices. */
async function moveFile(from: string, to: string): Promise<void> {
  try {
    await rename(from, to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    await copyFile(from, to);
    await rm(from, { force: true });
  }
}

/** Timeline ids of `root`: `timelines/<id>.json`. */
export async function listTimelineIds(root: string): Promise<string[]> {
  const names = await readdir(join(root, "timelines")).catch(() => [] as string[]);
  return names.flatMap((name) => {
    const id = /^([A-Za-z0-9][A-Za-z0-9_-]*)\.json$/.exec(name)?.[1];
    return id ? [id] : [];
  });
}
