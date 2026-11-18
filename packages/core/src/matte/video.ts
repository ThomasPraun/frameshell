// Whole-asset subject matte (ADR 0032), in passes over the video so memory holds one frame at a time:
// 1. each proxy frame through the model; the coarse alpha, smoothed forward in time, appended to a scratch file;
// 2. the scratch file smoothed backward in place, last frame first (forward + backward = no lag);
// 3. each proxy frame again as the colour guide, its smoothed alpha refined (`refineFrame`) and encoded as luma video;
// 4. for a large source, each frame of the asset itself on the proxy's frame grid, refined and encoded the same way.
import { spawn } from "node:child_process";
import { dirname } from "node:path";
import { open, statfs } from "node:fs/promises";
import { readRawFrames } from "../media/raw-frames.js";
import { PROXY_GOP, fpsRational, proxyFrameGrid } from "../media/recipe.js";
import { loadOnnxModel } from "../onnx-web.js";
import { runWorkerTask } from "../worker-task.js";
import { SELFIE, coarseAlpha, modelInput } from "./models.js";
import { type PlaneSize, emaStep, emaWeight, refineFrame, resizeBilinear } from "./refine.js";

/** Coarse alpha 0..1 of one packed 8-bit RGB frame of `size`, at the model's own size. */
export type MatteInfer = (rgb: Uint8Array, size: PlaneSize) => Promise<{ alpha: Float32Array; size: PlaneSize }>;

/** One asset's matte to make. */
export interface MatteVideoRequest {
  /** Absolute path of the managed ffmpeg. */
  ffmpeg: string;
  /** Absolute path of the asset's proxy (CFR at `fps`, the frames the matte follows one to one). */
  source: string;
  /** The proxy's picture size (even sides). */
  width: number;
  /** See `width`. */
  height: number;
  /** Frame rate of the proxy, frames per second. */
  fps: number;
  /** Frames expected, for progress only. */
  frames?: number | undefined;
  /** Absolute path of the proxy-size `.mp4` to write; null when only {@link MatteVideoRequest.full} is wanted. */
  output: string | null;
  /** The full-size matte to write too (pass 4), for a source above {@link FULL_MATTE_ABOVE_SHORT_SIDE}. */
  full?: FullMatteRequest | undefined;
  /** Absolute path of the scratch file pass 1 writes and pass 2 rewrites (one byte per coarse pixel per frame, at most 128 px a side). */
  scratch: string;
}

/** The full-size matte of {@link MatteVideoRequest.full}: frame N is proxy frame N, at the asset's own size. */
export interface FullMatteRequest {
  /** Absolute path of the asset itself. */
  source: string;
  /** Matte size, {@link fullMatteSize} of the asset's picture. */
  width: number;
  /** See `width`. */
  height: number;
  /** Absolute path of the `.mp4` to write. */
  output: string;
}

/** What {@link matteVideo} made. */
export interface MatteVideoResult {
  frames: number;
  /** Milliseconds in the model (pass 1), refining and encoding at proxy size (pass 3) and at full size (pass 4). */
  inferMs: number;
  refineMs: number;
  fullMs: number;
}

/** Longest side, pixels, the coarse alpha is stored at in the scratch file (halved until it fits). */
export const COARSE_MAX_SIDE = 128;

/**
 * Sources with a short side above this get a full-size matte for export besides the proxy-size one (ADR 0032
 * decision 9 as built): 1440p and 4K. A 1080p source keeps the proxy matte scaled up 2x: refining it at 1080p would
 * add about 130 ms of CPU a frame, 1.5 times the whole proxy-size job (ADR 0032 "Slice MX1").
 */
export const FULL_MATTE_ABOVE_SHORT_SIDE = 1080;
/**
 * Short side, pixels, the full-size matte is capped at (larger sources are refined at this size and export scales
 * it up). Bounds memory per frame: 3840x2160 holds the decoded RGB frame (25 MB), the matte (8 MB), the encoder's
 * frame copy (12 MB) and the fit's planes at 1/8 size (about 10 MB), so under 100 MB with ffmpeg's pipe buffers.
 */
export const FULL_MATTE_MAX_SHORT_SIDE = 2160;

/** Size of the full-size matte of a picture of `size` (even sides, short side capped), or null when it needs none. */
export function fullMatteSize(size: PlaneSize): PlaneSize | null {
  const short = Math.min(size.width, size.height);
  if (short <= FULL_MATTE_ABOVE_SHORT_SIDE) return null;
  const target = Math.min(short, FULL_MATTE_MAX_SHORT_SIDE);
  const even = (side: number) => Math.max(2, Math.floor((side * target) / short / 2) * 2);
  return { width: even(size.width), height: even(size.height) };
}

/** Free bytes of `path`'s volume, or null when the platform cannot say. */
async function freeBytes(path: string): Promise<number | null> {
  try {
    const stats = await statfs(path);
    return stats.bavail * stats.bsize;
  } catch {
    return null;
  }
}

/**
 * ffmpeg arguments encoding raw yuv420p frames of `size` from stdin as the matte video at `output`: H.264 on
 * the proxy's grid (CFR `fps`, GOP {@link PROXY_GOP}, no B-frames: frame index = sample index), full range
 * in and out so the luma bytes are the matte (0 background, 255 subject) with no range conversion.
 */
export function matteEncodeArgs(output: string, size: PlaneSize, fps: number): string[] {
  return [
    ...["-hide_banner", "-loglevel", "error", "-nostdin", "-y"],
    ...["-f", "rawvideo", "-pix_fmt", "yuv420p", "-color_range", "pc", "-s", `${size.width}x${size.height}`, "-r", fpsRational(fps), "-i", "-"],
    ...["-c:v", "libx264", "-preset", "veryfast", "-crf", "16", "-profile:v", "high", "-pix_fmt", "yuv420p", "-color_range", "pc"],
    ...["-g", String(PROXY_GOP), "-keyint_min", String(PROXY_GOP), "-sc_threshold", "0", "-bf", "0"],
    ...["-force_key_frames", `expr:eq(mod(n,${PROXY_GOP}),0)`, "-movflags", "+faststart", "-f", "mp4", output],
  ];
}

/** Seconds left of a job `fraction` done after `elapsedMs`; null before anything is done. */
export function etaSeconds(elapsedMs: number, fraction: number): number | null {
  if (!(fraction > 0)) return null;
  return Math.max(0, Math.round((elapsedMs * (1 - Math.min(1, fraction))) / fraction / 1000));
}

/** Matte every frame of `request.source` with `infer` into `request.output`. See the file header for the passes. */
export async function matteVideo(request: MatteVideoRequest, infer: MatteInfer, onProgress?: (fraction: number) => void): Promise<MatteVideoResult> {
  const size = { width: request.width, height: request.height };
  const weight = emaWeight(request.fps);
  const scratch = await open(request.scratch, "w+");
  let coarse: PlaneSize | undefined;
  let plane = 0;
  let frames = 0;
  let inferMs = 0;
  let refineMs = 0;
  let fullMs = 0;
  const proxyCost = request.output === null ? 0 : refineCost(size);
  const fullCost = request.full ? refineCost(request.full) : 0;
  const total = inferCost + proxyCost + fullCost;
  try {
    let state: Float32Array | null = null;
    for await (const rgb of readRawFrames(request.ffmpeg, request.source, "format=rgb24", size.width * size.height * 3)) {
      const started = performance.now();
      const inferred = await infer(rgb, size);
      inferMs += performance.now() - started;
      const stored = shrinkCoarse(inferred.alpha, inferred.size);
      const at = stored.size;
      if (!coarse) {
        coarse = at;
        plane = at.width * at.height;
        const need = plane * (request.frames ?? 0);
        const free = await freeBytes(dirname(request.scratch));
        if (free !== null && need > free * 0.9) {
          throw new Error(`not enough free disk for the matte: about ${Math.ceil(need / 1e6)} MB of scratch space needed, ${Math.floor(free / 1e6)} MB free`);
        }
      } else if (at.width !== coarse.width || at.height !== coarse.height) {
        throw new Error(`the matte model changed its output size from ${coarse.width}x${coarse.height} to ${at.width}x${at.height}`);
      }
      state = emaStep(state, stored.alpha, weight);
      await scratch.write(toBytes(state), 0, plane, frames * plane);
      frames++;
      if (request.frames) onProgress?.((inferCost / total) * Math.min(1, frames / request.frames));
    }
    if (!coarse || frames === 0) throw new Error(`${request.source} has no frames to matte`);

    const bytes = Buffer.alloc(plane);
    let back: Float32Array | null = null;
    for (let t = frames - 1; t >= 0; t--) {
      await scratch.read(bytes, 0, plane, t * plane);
      back = emaStep(back, Float32Array.from(bytes, (value) => value / 255), weight);
      await scratch.write(toBytes(back), 0, plane, t * plane);
    }

    const smoothed = async (t: number) => {
      await scratch.read(bytes, 0, plane, t * plane);
      return Float32Array.from(bytes, (value) => value / 255);
    };
    if (request.output !== null) {
      const output = request.output;
      const share = (done: number) => onProgress?.((inferCost + proxyCost * (done / frames)) / total);
      refineMs = await refinePass(request.ffmpeg, request.source, "format=rgb24", size, output, request.fps, frames, coarse, smoothed, share, true);
    }
    if (request.full) {
      const full = request.full;
      const share = (done: number) => onProgress?.((inferCost + proxyCost + fullCost * (done / frames)) / total);
      // The proxy's own frame grid, so frame N is proxy frame N; ffmpeg applies the rotation as it does for the proxy.
      const filter = `${proxyFrameGrid(request.fps)},scale=${full.width}:${full.height},format=rgb24`;
      fullMs = await refinePass(request.ffmpeg, full.source, filter, full, full.output, request.fps, frames, coarse, smoothed, share, false);
    }
  } finally {
    await scratch.close();
  }
  return { frames, inferMs: Math.round(inferMs), refineMs: Math.round(refineMs), fullMs: Math.round(fullMs) };
}

// Progress weights: CPU milliseconds per frame on an Apple M3 (ADR 0032 "Slice MX1"). Pass 1 is the model with its input;
// a refine pass costs a fixed part (the fit runs at the same size whatever the frame) plus decoding, refining and
// encoding per megapixel: about 60 ms at 960x540, 127 ms at 1920x1080 and 355 ms at 3840x2160.
const inferCost = 20;
function refineCost(size: PlaneSize): number {
  return 50 + (37 * size.width * size.height) / 1e6;
}

/**
 * Pass 3 or 4: every frame of `source` through `filter` (ending in `format=rgb24`, at `size`), its smoothed coarse
 * alpha refined against it and encoded into `output`. `exact`: the source must give exactly `frames` frames (the
 * proxy, read twice); else extra frames at its end are left out (the asset itself, through the same grid, may round
 * its last frame differently) and a missing last frame repeats the one before. Returns the milliseconds spent.
 */
async function refinePass(
  ffmpeg: string,
  source: string,
  filter: string,
  size: PlaneSize,
  output: string,
  fps: number,
  frames: number,
  coarse: PlaneSize,
  smoothed: (t: number) => Promise<Float32Array>,
  onProgress: (done: number) => void,
  exact: boolean,
): Promise<number> {
  const encoder = startEncoder(ffmpeg, matteEncodeArgs(output, size, fps));
  const chroma = Buffer.alloc((size.width / 2) * (size.height / 2) * 2, 128);
  let written = 0;
  let spent = 0;
  let last: Uint8Array | null = null;
  try {
    for await (const rgb of readRawFrames(ffmpeg, source, filter, size.width * size.height * 3)) {
      if (written >= frames) {
        if (exact) throw new Error(`${source} gave more frames on its second read than its first (${frames})`);
        break;
      }
      const started = performance.now();
      last = refineFrame(await smoothed(written), coarse, rgb, size);
      await encoder.write(last);
      await encoder.write(chroma);
      spent += performance.now() - started;
      written++;
      onProgress(written);
    }
    if (!exact && last && written === frames - 1) {
      await encoder.write(last);
      await encoder.write(chroma);
      written++;
    }
    if (written !== frames) throw new Error(`${source} gave ${written} frames for the matte, the proxy ${frames}`);
  } catch (error) {
    encoder.kill();
    throw error;
  }
  await encoder.finish();
  return spent;
}

/** `alpha` halved (2x2 mean) until its longest side is at most {@link COARSE_MAX_SIDE}. */
function shrinkCoarse(alpha: Float32Array, size: PlaneSize): { alpha: Float32Array; size: PlaneSize } {
  let current = { alpha, size };
  while (Math.max(current.size.width, current.size.height) > COARSE_MAX_SIDE && current.size.width >= 2 && current.size.height >= 2) {
    const next = { width: Math.floor(current.size.width / 2), height: Math.floor(current.size.height / 2) };
    current = { alpha: resizeBilinear(current.alpha, current.size, next), size: next };
  }
  return current;
}

function toBytes(alpha: Float32Array): Uint8Array {
  const out = new Uint8Array(alpha.length);
  for (let i = 0; i < alpha.length; i++) out[i] = Math.round(Math.min(1, Math.max(0, alpha[i]!)) * 255);
  return out;
}

/** ffmpeg reading frames on stdin; `write` waits while its pipe is full, `finish` for its exit. */
function startEncoder(ffmpeg: string, args: string[]): { write(chunk: Uint8Array): Promise<void>; finish(): Promise<void>; kill(): void } {
  const child = spawn(ffmpeg, args, { stdio: ["pipe", "ignore", "pipe"], windowsHide: true });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => (stderr = (stderr + chunk).slice(-4000)));
  let broken: Error | null = null;
  // A closed pipe is reported by `finish` with ffmpeg's own message.
  child.stdin.on("error", (error) => (broken = error));
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  const failed = (code: number | null) => new Error(`ffmpeg could not encode the matte (exit ${code}): ${stderr.trim() || broken?.message}`);
  return {
    write: (chunk) =>
      new Promise<void>((resolve, reject) => {
        if (broken || child.exitCode !== null) return reject(failed(child.exitCode));
        if (child.stdin.write(chunk)) return resolve();
        child.stdin.once("drain", resolve);
        // ffmpeg gone while its pipe was full: no drain will come.
        void exited.then((code) => reject(failed(code)));
      }),
    async finish() {
      child.stdin.end();
      const code = await exited;
      if (code !== 0) throw failed(code);
    },
    kill: () => void child.kill(),
  };
}

/** {@link MatteInfer} running the pinned selfie segmenter at `model` with the ONNX Runtime Web module at `runtime`, in this thread. */
export async function loadSelfieMatte(runtime: string, model: string): Promise<MatteInfer> {
  const { ort, session } = await loadOnnxModel(runtime, model);
  return async (rgb, frame) => {
    const { data, size } = modelInput(SELFIE, rgb, frame);
    const outputs = await session.run({ [SELFIE.input]: new ort.Tensor("float32", data, [1, 3, size.height, size.width]) });
    const output = outputs[SELFIE.output]?.data as Float32Array | undefined;
    if (!output) throw new Error(`the matte model gave no "${SELFIE.output}": not the pinned model?`);
    return { alpha: coarseAlpha(output, size), size };
  };
}

/** Files the matte worker loads; both null = the model-free stand-in (`FRAMESHELL_MATTE_STAND_IN=1`). */
export interface MatteFiles {
  /** Absolute path of the ONNX Runtime Web module. */
  runtime: string | null;
  /** Absolute path of the model file. */
  model: string | null;
}

/**
 * Worker script beside this module. Under the test runner this module is the
 * TypeScript source, so the worker runs from the build (`pnpm test` builds first).
 */
const MATTE_WORKER = import.meta.url.endsWith(".ts") ? new URL("../../dist/matte/matte-worker.js", import.meta.url) : new URL("./matte-worker.js", import.meta.url);

/**
 * {@link matteVideo} in a worker thread, so decoding, inference and refinement never block the daemon's
 * event loop. Aborting terminates it; the caller removes `output` and `scratch`.
 */
export function matteInWorker(
  files: MatteFiles,
  request: MatteVideoRequest,
  options: { signal?: AbortSignal | undefined; onProgress?: ((fraction: number) => void) | undefined },
): Promise<MatteVideoResult> {
  return runWorkerTask<MatteVideoResult>(MATTE_WORKER, { ...files, ...request }, "subject matte", options);
}
