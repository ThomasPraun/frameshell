// Whole-asset subject matte (ADR 0032), in three passes over the proxy so memory holds one frame at a time:
// 1. each frame through the model; the coarse alpha, smoothed forward in time, appended to a scratch file;
// 2. the scratch file smoothed backward in place, last frame first (forward + backward = no lag);
// 3. each frame again as the gray guide, its smoothed alpha refined (`refineFrame`) and encoded as luma video.
import { spawn } from "node:child_process";
import { open } from "node:fs/promises";
import { readRawFrames } from "../media/raw-frames.js";
import { PROXY_GOP, fpsRational } from "../media/recipe.js";
import { loadOnnxModel } from "../onnx-web.js";
import { runWorkerTask } from "../worker-task.js";
import { SELFIE, coarseAlpha, modelInput } from "./models.js";
import { type PlaneSize, emaStep, emaWeight, refineFrame } from "./refine.js";

/** Coarse alpha 0..1 of one packed 8-bit RGB frame of `size`, at the model's own size. */
export type MatteInfer = (rgb: Uint8Array, size: PlaneSize) => Promise<{ alpha: Float32Array; size: PlaneSize }>;

/** One asset's matte to make. */
export interface MatteVideoRequest {
  ffmpeg: string;
  /** Absolute path of the asset's proxy (CFR at `fps`, the frames the matte follows one to one). */
  source: string;
  /** The proxy's picture size (even sides). */
  width: number;
  height: number;
  fps: number;
  /** Frames expected, for progress only. */
  frames?: number | undefined;
  /** Absolute path of the `.mp4` to write. */
  output: string;
  /** Absolute path of the scratch file pass 1 writes and pass 2 rewrites (one byte per coarse pixel per frame). */
  scratch: string;
}

/** What {@link matteVideo} made. */
export interface MatteVideoResult {
  frames: number;
  /** Milliseconds in the model (pass 1) and in refining and encoding (pass 3). */
  inferMs: number;
  refineMs: number;
}

/** Share of the progress fraction of pass 1 (model); pass 3 (refine, encode) takes the rest. From the spike. */
const INFER_SHARE = 0.4;

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
  try {
    let state: Float32Array | null = null;
    for await (const rgb of readRawFrames(request.ffmpeg, request.source, "format=rgb24", size.width * size.height * 3)) {
      const started = performance.now();
      const { alpha, size: at } = await infer(rgb, size);
      inferMs += performance.now() - started;
      if (!coarse) {
        coarse = at;
        plane = at.width * at.height;
      } else if (at.width !== coarse.width || at.height !== coarse.height) {
        throw new Error(`the matte model changed its output size from ${coarse.width}x${coarse.height} to ${at.width}x${at.height}`);
      }
      state = emaStep(state, alpha, weight);
      await scratch.write(toBytes(state), 0, plane, frames * plane);
      frames++;
      if (request.frames) onProgress?.(INFER_SHARE * Math.min(1, frames / request.frames));
    }
    if (!coarse || frames === 0) throw new Error(`${request.source} has no frames to matte`);

    const bytes = Buffer.alloc(plane);
    let back: Float32Array | null = null;
    for (let t = frames - 1; t >= 0; t--) {
      await scratch.read(bytes, 0, plane, t * plane);
      back = emaStep(back, Float32Array.from(bytes, (value) => value / 255), weight);
      await scratch.write(toBytes(back), 0, plane, t * plane);
    }

    const encoder = startEncoder(request.ffmpeg, matteEncodeArgs(request.output, size, request.fps));
    const chroma = Buffer.alloc((size.width / 2) * (size.height / 2) * 2, 128);
    let written = 0;
    try {
      for await (const gray of readRawFrames(request.ffmpeg, request.source, "format=gray", size.width * size.height)) {
        if (written >= frames) throw new Error(`${request.source} gave more frames on its second read than its first (${frames})`);
        const started = performance.now();
        await scratch.read(bytes, 0, plane, written * plane);
        const alpha = Float32Array.from(bytes, (value) => value / 255);
        const luma = refineFrame(alpha, coarse, Float32Array.from(gray, (value) => value / 255), size);
        await encoder.write(luma);
        await encoder.write(chroma);
        refineMs += performance.now() - started;
        written++;
        onProgress?.(INFER_SHARE + (1 - INFER_SHARE) * (written / frames));
      }
      if (written !== frames) throw new Error(`${request.source} gave ${written} frames on its second read, ${frames} on its first`);
    } catch (error) {
      encoder.kill();
      throw error;
    }
    await encoder.finish();
  } finally {
    await scratch.close();
  }
  return { frames, inferMs: Math.round(inferMs), refineMs: Math.round(refineMs) };
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
  runtime: string | null;
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
