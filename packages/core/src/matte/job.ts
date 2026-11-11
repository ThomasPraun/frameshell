import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Progress } from "@frameshell/protocol";
import { renameRetrying } from "../fs-util.js";
import { probeMedia } from "../media/ffmpeg.js";
import { MATTES_DIR, MATTE_VERSION, type MatteInfo, matteKey, mattePaths, writeMatteInfo } from "./cache.js";
import { type MatteFiles, type MatteVideoRequest, type MatteVideoResult, etaSeconds, matteInWorker } from "./video.js";

/** One asset's matte to compute, once its ingest is complete. */
export interface MatteTarget {
  /** Project-relative asset path. */
  asset: string;
  /** `sha256:<hex>` of its content. */
  hash: string;
  /** Project-relative proxy of that content. */
  proxy: string;
  fps: number;
  /** `<id>@<revision>` of the model, or `stand-in`. */
  model: string;
}

/** What {@link computeMatte} needs from the daemon. */
export interface MatteJobDeps {
  ffmpeg(): Promise<string>;
  ffprobe(): Promise<string>;
  /** The runtime and model files, installing them when missing (both null for the stand-in). */
  files(): Promise<MatteFiles>;
  /** Job fraction 0..1. */
  onProgress(fraction: number): void;
  /** One human progress line (`stage: "matte"`). */
  report(update: Progress): void;
  signal: AbortSignal;
  /** Runs the passes; default {@link matteInWorker}. */
  run?: (files: MatteFiles, request: MatteVideoRequest, options: { signal: AbortSignal; onProgress: (fraction: number) => void }) => Promise<MatteVideoResult>;
  /** Clock in ms. Default `Date.now`. */
  now?: () => number;
}

/** No ETA before this much work: the first frames include loading the model. */
const ETA_AFTER_MS = 3000;

/**
 * Matte `target` (ADR 0032 decision 5: the whole asset, once per content) into {@link MATTES_DIR}: the video
 * under a temp name, renamed into place, then its record. Temps are removed on failure or abort.
 */
export async function computeMatte(root: string, target: MatteTarget, deps: MatteJobDeps): Promise<MatteInfo> {
  const now = deps.now ?? Date.now;
  const key = matteKey(target.hash, target.model, target.fps);
  const dir = join(root, ...MATTES_DIR.split("/"));
  await mkdir(dir, { recursive: true });
  const proxy = join(root, ...target.proxy.split("/"));
  const ffmpeg = await deps.ffmpeg();
  const probe = await probeMedia(await deps.ffprobe(), proxy, deps.signal);
  if (!probe.video) throw new Error(`the proxy of ${target.asset} has no picture`);
  const files = await deps.files();
  const stamp = `${process.pid}-${now()}`;
  const partial = join(dir, `${key}.${stamp}.partial`);
  const scratch = join(dir, `${key}.${stamp}.coarse`);
  const started = now();
  const message = `Matting ${target.asset}`;
  deps.report({ message, stage: "matte", values: { asset: target.asset } });
  const run = deps.run ?? matteInWorker;
  try {
    const result = await run(
      files,
      {
        ffmpeg,
        source: proxy,
        width: probe.video.width,
        height: probe.video.height,
        fps: target.fps,
        frames: probe.duration ? Math.round(probe.duration * target.fps) : undefined,
        output: partial,
        scratch,
      },
      {
        signal: deps.signal,
        onProgress: (fraction) => {
          deps.onProgress(fraction);
          const elapsed = now() - started;
          const eta = elapsed >= ETA_AFTER_MS ? etaSeconds(elapsed, fraction) : null;
          deps.report({
            message: eta === null ? message : `${message}: about ${formatEta(eta)} left`,
            fraction,
            stage: "matte",
            values: eta === null ? { asset: target.asset } : { asset: target.asset, eta },
          });
        },
      },
    );
    await renameRetrying(partial, join(root, ...mattePaths(key).video.split("/")));
    const info: MatteInfo = {
      version: MATTE_VERSION,
      hash: target.hash,
      model: target.model,
      fps: target.fps,
      width: probe.video.width,
      height: probe.video.height,
      frames: result.frames,
      seconds: Math.round((now() - started) / 100) / 10,
    };
    await writeMatteInfo(root, key, info);
    return info;
  } finally {
    await rm(partial, { force: true });
    await rm(scratch, { force: true });
  }
}

/** `40 s`, `3 min`, `1 h 5 min`. */
export function formatEta(seconds: number): string {
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}
