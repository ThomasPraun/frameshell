import { join } from "node:path";
import { ErrorCode, type MediaProbe, type MethodResult, type Progress, RpcError } from "@frameshell/protocol";
import { readFaceScan, writeFaceScan } from "./scan-cache.js";
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
  let scan: PeopleScanner | undefined;
  let ffmpeg = "";
  for (const [index, { rel, probe }] of videos.entries()) {
    deps.signal.throwIfAborted();
    const hash = await deps.hash(root, rel);
    const cached = params.force === true ? null : await readFaceScan(root, hash);
    if (cached) {
      assets.push({ asset: rel, cached: true, samples: cached.samples, tracks: cached.tracks.length, embeddings: embeddingCount(cached.tracks) });
      deps.onProgress((index + 1) / videos.length);
      continue;
    }
    scan ??= await deps.scanner();
    ffmpeg ||= await deps.ffmpeg();
    const message = `Finding faces in ${rel}`;
    const found = await scan({
      ffmpeg,
      path: join(root, ...rel.split("/")),
      width: probe.video.width,
      height: probe.video.height,
      duration: probe.duration ?? undefined,
      signal: deps.signal,
      onProgress: (fraction) => {
        deps.onProgress((index + fraction) / videos.length);
        deps.report({ message, fraction, stage: "people", values: { asset: rel } });
      },
    });
    await writeFaceScan(root, hash, found);
    assets.push({ asset: rel, cached: false, samples: found.samples, tracks: found.tracks.length, embeddings: embeddingCount(found.tracks) });
    if (found.tracks.length === 0) warnings.push(`${rel}: no face found in ${found.samples} frames.`);
  }
  return { assets, warnings };
}

function embeddingCount(tracks: readonly { embeddings: readonly unknown[] }[]): number {
  return tracks.reduce((sum, track) => sum + track.embeddings.length, 0);
}
