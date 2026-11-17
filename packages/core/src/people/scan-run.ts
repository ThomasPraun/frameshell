import { join } from "node:path";
import { ErrorCode, type MediaProbe, type MethodResult, type Progress, RpcError } from "@frameshell/protocol";
import { exists } from "../fs-util.js";
import { PEOPLE_DIR, type StoredFaceScan, readFaceScan, writeFaceScan } from "./scan-cache.js";
import type { ScannedAsset } from "./face-clusters.js";
import type { PeopleScanner } from "./scan.js";
import { projectPath } from "./service.js";

/** What {@link scanProjectFaces} needs from the daemon. */
export interface ScanProjectDeps {
  /** Every file under `assets/`, project-relative. */
  listAssets(root: string): Promise<string[]>;
  probe(root: string, rel: string): Promise<MediaProbe>;
  /** Content hash of `rel`. */
  hash(root: string, rel: string): Promise<string>;
  /** Called once, when there is something to decode. */
  scanner(): Promise<PeopleScanner>;
  ffmpeg(): Promise<string>;
  /** Job fraction 0..1 over all videos. */
  onProgress(fraction: number): void;
  /** One human progress line (`stage: "people"`). */
  report(update: Progress): void;
  signal: AbortSignal;
}

/** What {@link scanFileFaces} needs: the two things a scan decodes and infers with. */
export interface ScanFileDeps {
  /** Called only when there is something to decode. */
  scanner(): Promise<PeopleScanner>;
  ffmpeg(): Promise<string>;
  signal?: AbortSignal | undefined;
}

/** The video {@link scanFileFaces} scans. */
export interface ScanFileInput {
  /** Absolute path. */
  path: string;
  /** Content hash (`sha256:<hex>`): the cache key. */
  hash: string;
  /** Picture size. */
  width: number;
  height: number;
  /** Seconds, for progress; unknown: no fraction. */
  duration?: number | null | undefined;
  /** Scan again even when the cache has it. */
  force?: boolean | undefined;
  /** 0..1 of this file looked at. */
  onProgress?: ((fraction: number) => void) | undefined;
}

/** The part of a face scan its readers use; a {@link StoredFaceScan} is one. */
export type FileFaceScan = Pick<StoredFaceScan, "samples" | "tracks">;

/**
 * The one scan step (ADR 0020 as-built): the face scan of the file with content `hash`, from the cache of
 * `root` when it is there, else decoded and cached. The file may be anywhere (`people.scan` passes an asset,
 * `analyze` a reference outside the project): the cache is keyed by content, never by path.
 */
export async function scanFileFaces(root: string, input: ScanFileInput, deps: ScanFileDeps): Promise<FileFaceScan & { cached: boolean }> {
  const cached = input.force === true ? null : await readFaceScan(root, input.hash);
  if (cached) return { samples: cached.samples, tracks: cached.tracks, cached: true };
  const scan = await deps.scanner();
  const found = await scan({
    ffmpeg: await deps.ffmpeg(),
    path: input.path,
    width: input.width,
    height: input.height,
    duration: input.duration ?? undefined,
    signal: deps.signal,
    onProgress: input.onProgress,
  });
  await writeFaceScan(root, input.hash, found);
  return { samples: found.samples, tracks: found.tracks, cached: false };
}

/** `fn` run once, on first call; later calls get the same answer. */
function once<T>(fn: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | undefined;
  return () => (pending ??= fn());
}

/**
 * `people.scan` (ADR 0020 decision 4): the face scan of each video, from the
 * cache when the content was scanned already (`force` scans again), else
 * decoded and cached in `.frameshell/people/`. Asked assets that are not
 * moving pictures are skipped with a warning; without a list, files that are
 * not media are skipped silently.
 */
export async function scanProjectFaces(
  root: string,
  params: { assets?: readonly string[] | undefined; force?: boolean | undefined },
  deps: ScanProjectDeps,
): Promise<Omit<MethodResult<"people.scan">, "dir">> {
  const explicit = params.assets !== undefined;
  const rels: string[] = [];
  for (const input of params.assets ?? (await deps.listAssets(root))) {
    const rel = explicit ? await projectPath(root, input) : input;
    if (rel === null) {
      throw new RpcError(ErrorCode.InvalidOperation, `people.scan: ${input} is not inside the project.`, { op: "people.scan", reason: "bad target" });
    }
    if (!rels.includes(rel)) rels.push(rel);
  }
  const warnings: string[] = [];
  const videos: { rel: string; probe: MediaProbe & { video: NonNullable<MediaProbe["video"]> } }[] = [];
  for (const rel of rels) {
    let probe: MediaProbe;
    try {
      probe = await deps.probe(root, rel);
    } catch (error) {
      if (explicit) throw error;
      continue;
    }
    if (!probe.video || probe.video.still) {
      if (explicit) warnings.push(`${rel} has no moving picture: skipped.`);
      continue;
    }
    videos.push({ rel, probe: { ...probe, video: probe.video } });
  }

  const assets: MethodResult<"people.scan">["assets"] = [];
  const fileDeps: ScanFileDeps = { scanner: once(deps.scanner), ffmpeg: once(deps.ffmpeg), signal: deps.signal };
  for (const [index, { rel, probe }] of videos.entries()) {
    deps.signal.throwIfAborted();
    const message = `Finding faces in ${rel}`;
    const found = await scanFileFaces(
      root,
      {
        path: join(root, ...rel.split("/")),
        hash: await deps.hash(root, rel),
        width: probe.video.width,
        height: probe.video.height,
        duration: probe.duration,
        force: params.force,
        onProgress: (fraction) => {
          deps.onProgress((index + fraction) / videos.length);
          deps.report({ message, fraction, stage: "people", values: { asset: rel } });
        },
      },
      fileDeps,
    );
    assets.push({ asset: rel, cached: found.cached, samples: found.samples, tracks: found.tracks.length, embeddings: embeddingCount(found.tracks) });
    if (found.cached) deps.onProgress((index + 1) / videos.length);
    else if (found.tracks.length === 0) warnings.push(`${rel}: no face found in ${found.samples} frames.`);
  }
  return { assets, warnings };
}

function embeddingCount(tracks: readonly { embeddings: readonly unknown[] }[]): number {
  return tracks.reduce((sum, track) => sum + track.embeddings.length, 0);
}

/**
 * The cached face scan of each of `assets` (project-relative) that has one,
 * keyed by its current content: nothing is decoded. Files that cannot be
 * hashed (gone meanwhile) are left out. Without {@link PEOPLE_DIR} nothing was
 * scanned, so no file is hashed.
 */
export async function readProjectFaceScans(root: string, assets: readonly string[], hash: ScanProjectDeps["hash"]): Promise<ScannedAsset[]> {
  const found: ScannedAsset[] = [];
  if (!(await exists(join(root, ...PEOPLE_DIR.split("/"))))) return found;
  for (const asset of assets) {
    const content = await hash(root, asset).catch(() => null);
    const scan = content === null ? null : await readFaceScan(root, content);
    if (scan) found.push({ asset, scan });
  }
  return found;
}
