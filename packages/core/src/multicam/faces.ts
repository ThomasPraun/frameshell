// Face-driven reframe keys (ADR 0016): sample frames with ffmpeg, find faces with YuNet on ONNX Runtime Web
// (WebAssembly, in a worker thread), follow the main face, then keep only the keys where it moves.
import { spawn } from "node:child_process";
import { Worker } from "node:worker_threads";
import type { AngleCrop } from "@frameshell/schema";
import { loadOnnxModel } from "../onnx-web.js";

/** One face in a frame, in fractions of the frame: center `x`, `y` and size, plus the detector's score (0..1). */
export interface Face {
  x: number;
  y: number;
  width: number;
  height: number;
  score: number;
}

/** A frame as packed 8-bit BGR, rows top to bottom. */
export interface BgrFrame {
  width: number;
  height: number;
  data: Uint8Array;
}

/** Faces found in one frame. */
export type FaceDetector = (frame: BgrFrame) => Promise<Face[]>;

/** Frames looked at per second of an angle's file. */
export const FACE_SAMPLE_HZ = 2;

/** Width frames are scaled to before detection: faces down to ~1/50 of the picture width stay above YuNet's 10 px floor. */
const FACE_FRAME_WIDTH = 512;

/** YuNet's coarsest stride: input sides must be multiples of it. */
const YUNET_STRIDE = 32;

/**
 * Size frames of a `width`×`height` picture are scaled to: {@link FACE_FRAME_WIDTH}
 * wide, the height keeping the aspect, both multiples of 32.
 */
export function faceFrameSize(width: number, height: number): { width: number; height: number } {
  const scaled = Math.round((FACE_FRAME_WIDTH * height) / Math.max(1, width) / YUNET_STRIDE) * YUNET_STRIDE;
  return { width: FACE_FRAME_WIDTH, height: Math.min(4 * FACE_FRAME_WIDTH, Math.max(YUNET_STRIDE, scaled)) };
}

/**
 * Frames of the first video stream of absolute `path`, {@link FACE_SAMPLE_HZ}
 * per second scaled to `size`, with their source time. Reading waits for the
 * consumer, so a slow detector never piles frames up in memory. Throws when
 * ffmpeg cannot decode the file.
 */
export async function* sampleFaceFrames(
  ffmpeg: string,
  path: string,
  size: { width: number; height: number },
): AsyncGenerator<{ time: number; frame: BgrFrame }> {
  const frameBytes = size.width * size.height * 3;
  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-nostdin",
    "-i",
    path,
    "-map",
    "0:v:0",
    "-an",
    "-vf",
    `fps=${FACE_SAMPLE_HZ},scale=${size.width}:${size.height}:flags=area,format=bgr24`,
    "-f",
    "rawvideo",
    "-",
  ];
  const child = spawn(ffmpeg, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => (stderr = (stderr + chunk).slice(-4000)));
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  let pending: Buffer = Buffer.alloc(0);
  let index = 0;
  let finished = false;
  try {
    for await (const chunk of child.stdout as AsyncIterable<Buffer>) {
      pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
      let at = 0;
      for (; at + frameBytes <= pending.length; at += frameBytes) {
        const data = Uint8Array.from(pending.subarray(at, at + frameBytes));
        yield { time: Math.round((index++ / FACE_SAMPLE_HZ) * 1000) / 1000, frame: { ...size, data } };
      }
      pending = pending.subarray(at);
    }
    const code = await exited;
    finished = true;
    if (code !== 0) throw new Error(`ffmpeg could not read the picture of ${path} (exit ${code}): ${stderr.trim()}`);
  } finally {
    // The consumer stopped early (an error, a closed connection): do not leave ffmpeg decoding.
    if (!finished) child.kill();
  }
}

/** Below this score a YuNet candidate is not a face (OpenCV's demo uses 0.9; lower keeps turned heads). */
const FACE_SCORE = 0.6;
/** Candidates overlapping a better one by more than this (intersection over union) are the same face. */
const FACE_OVERLAP = 0.3;

/**
 * {@link FaceDetector} running the YuNet model at `model` with the ONNX
 * Runtime Web module at `runtime` (its `.wasm` beside it), single-threaded in
 * this process.
 */
export async function loadYunet(runtime: string, model: string): Promise<FaceDetector> {
  const { ort, session } = await loadOnnxModel(runtime, model);
  const input = session.inputNames[0] ?? "input";
  return async (frame) => {
    const { width, height, data } = frame;
    const plane = width * height;
    // YuNet takes NCHW BGR in 0..255, no mean or scale.
    const tensor = new Float32Array(3 * plane);
    for (let i = 0; i < plane; i++) {
      tensor[i] = data[i * 3]!;
      tensor[plane + i] = data[i * 3 + 1]!;
      tensor[2 * plane + i] = data[i * 3 + 2]!;
    }
    const outputs = await session.run({ [input]: new ort.Tensor("float32", tensor, [1, 3, height, width]) });
    const read = (name: string) => outputs[name]?.data as Float32Array | undefined;
    return decodeYunet(read, width, height);
  };
}

/**
 * Faces from YuNet's outputs (`cls_<s>`, `obj_<s>`, `bbox_<s>` per stride
 * 8, 16, 32), decoded as OpenCV's `FaceDetectorYN` does: one candidate per
 * grid cell, score `sqrt(cls * obj)`, box center offset from the cell and size
 * `exp` of the output, both in strides; then non-maximum suppression.
 */
export function decodeYunet(output: (name: string) => Float32Array | undefined, width: number, height: number): Face[] {
  const candidates: Face[] = [];
  for (const stride of [8, 16, 32]) {
    const cls = output(`cls_${stride}`);
    const obj = output(`obj_${stride}`);
    const bbox = output(`bbox_${stride}`);
    if (!cls || !obj || !bbox) throw new Error(`YuNet gave no outputs for stride ${stride}: not the pinned model?`);
    const cols = Math.floor(width / stride);
    const rows = Math.floor(height / stride);
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const i = row * cols + col;
        const score = Math.sqrt(clamp01(cls[i]!) * clamp01(obj[i]!));
        if (score < FACE_SCORE) continue;
        candidates.push({
          x: ((col + bbox[i * 4]!) * stride) / width,
          y: ((row + bbox[i * 4 + 1]!) * stride) / height,
          width: (Math.exp(bbox[i * 4 + 2]!) * stride) / width,
          height: (Math.exp(bbox[i * 4 + 3]!) * stride) / height,
          score,
        });
      }
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  const faces: Face[] = [];
  for (const candidate of candidates) if (faces.every((face) => overlap(face, candidate) <= FACE_OVERLAP)) faces.push(candidate);
  return faces;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** Intersection over union of two boxes. */
function overlap(a: Face, b: Face): number {
  const w = Math.min(a.x + a.width / 2, b.x + b.width / 2) - Math.max(a.x - a.width / 2, b.x - b.width / 2);
  const h = Math.min(a.y + a.height / 2, b.y + b.height / 2) - Math.max(a.y - a.height / 2, b.y - b.height / 2);
  if (w <= 0 || h <= 0) return 0;
  const inter = w * h;
  return inter / (a.width * a.height + b.width * b.height - inter);
}

/** Faces of one sampled frame at source second `time`. */
export interface FaceSample {
  time: number;
  faces: Face[];
}

/** Where the main face is at source second `time`, in fractions of the picture. */
export interface FacePoint {
  time: number;
  x: number;
  y: number;
}

/** A face this close to the last one followed (fraction of the picture) is the same person. */
const SAME_PERSON = 0.08;
/** The followed person stays chosen while their face is at least this share of the largest one's area. */
const KEEP_FOLLOWING = 0.6;

/**
 * The main face of every sample that has one: the largest whose center lies
 * inside `crop`, except that the face followed so far stays chosen while it
 * is nearly as large, so two people of one size do not make the cut jump.
 */
export function mainFaceTrack(samples: readonly FaceSample[], crop?: AngleCrop): FacePoint[] {
  const left = crop?.left ?? 0;
  const top = crop?.top ?? 0;
  const right = 1 - (crop?.right ?? 0);
  const bottom = 1 - (crop?.bottom ?? 0);
  const points: FacePoint[] = [];
  for (const { time, faces } of samples) {
    const inside = faces.filter((face) => face.x >= left && face.x <= right && face.y >= top && face.y <= bottom);
    if (inside.length === 0) continue;
    const area = (face: Face) => face.width * face.height;
    let chosen = inside.reduce((best, face) => (area(face) > area(best) ? face : best));
    const last = points.at(-1);
    if (last) {
      const same = inside.find((face) => Math.hypot(face.x - last.x, face.y - last.y) <= SAME_PERSON && area(face) >= KEEP_FOLLOWING * area(chosen));
      if (same) chosen = same;
    }
    points.push({ time, x: chosen.x, y: chosen.y });
  }
  return points;
}

/** Tuning of {@link proposeReframeKeys}; every field has a default. */
export interface ReframeKeyOptions {
  /** Moves smaller than this (fraction of the picture, per axis) are held still. Default 0.05. */
  deadband?: number;
  /** A position held for less than this many seconds is part of a move, not a stop. Default 1. */
  minHold?: number;
  /** Seconds a move takes after a gap without faces. Default 0.5. */
  glide?: number;
  /** Samples a median smooths over. Default 5 (2.5 s at 2 per second). */
  window?: number;
}

interface Stretch {
  start: number;
  end: number;
  x: number;
  y: number;
  count: number;
}

/**
 * Reframe keys (source seconds) that follow `points`: smoothed by a centered
 * median (detection is offline, so no lag), cut into stretches where the face
 * stays within `deadband`, short stretches dropped as part of a move. Each
 * stretch is held by a key at its start and end (the first only at its end,
 * the last only at its start: keys hold outside them). The move to the next
 * spans the faces seen moving between them, or the last `glide` seconds of a
 * gap where no face was seen.
 */
export function proposeReframeKeys(points: readonly FacePoint[], options: ReframeKeyOptions = {}): FacePoint[] {
  const { deadband = 0.05, minHold = 1, glide = 0.5, window = 5 } = options;
  if (points.length === 0) return [];
  const smooth = medianSmooth(points, window);
  let stretches: Stretch[] = [];
  for (const point of smooth) {
    const current = stretches.at(-1);
    if (current && Math.abs(point.x - current.x) <= deadband && Math.abs(point.y - current.y) <= deadband) {
      current.x = (current.x * current.count + point.x) / (current.count + 1);
      current.y = (current.y * current.count + point.y) / (current.count + 1);
      current.count++;
      current.end = point.time;
    } else {
      stretches.push({ start: point.time, end: point.time, x: point.x, y: point.y, count: 1 });
    }
  }
  const held = stretches.filter((stretch) => stretch.end - stretch.start >= minHold);
  stretches = held.length > 0 ? held : [stretches.reduce((best, stretch) => (stretch.count > best.count ? stretch : best))];
  // Dropping a move can leave two stops at one place side by side: one stop.
  const merged: Stretch[] = [];
  for (const stretch of stretches) {
    const previous = merged.at(-1);
    if (previous && Math.abs(stretch.x - previous.x) <= deadband && Math.abs(stretch.y - previous.y) <= deadband) {
      const count = previous.count + stretch.count;
      previous.x = (previous.x * previous.count + stretch.x * stretch.count) / count;
      previous.y = (previous.y * previous.count + stretch.y * stretch.count) / count;
      previous.count = count;
      previous.end = stretch.end;
    } else {
      merged.push({ ...stretch });
    }
  }
  const keys: FacePoint[] = [];
  // Faces seen between two stops (dropped as too short) are the move itself: glide over their span.
  const moving = (from: Stretch, to: Stretch) => smooth.some((point) => point.time > from.end && point.time < to.start);
  const key = (time: number, stretch: Stretch) => {
    const point = { time: Math.round(time * 1000) / 1000, x: round4(stretch.x), y: round4(stretch.y) };
    if (keys.at(-1)?.time === point.time) keys[keys.length - 1] = point;
    else keys.push(point);
  };
  merged.forEach((stretch, i) => {
    const previous = merged[i - 1];
    if (previous) {
      const moveFrom = moving(previous, stretch) ? previous.end : Math.max(previous.end, stretch.start - glide);
      if (moveFrom > previous.end) key(moveFrom, previous);
      key(stretch.start, stretch);
    }
    if (i < merged.length - 1 || merged.length === 1) key(merged.length === 1 ? stretch.start : stretch.end, stretch);
  });
  return keys;
}

/** Each point's `x` and `y` replaced by the median over the `window` points centered on it. */
function medianSmooth(points: readonly FacePoint[], window: number): FacePoint[] {
  const half = Math.floor(Math.max(1, window) / 2);
  const median = (values: number[]) => {
    const sorted = values.sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
  };
  return points.map((point, i) => {
    const around = points.slice(Math.max(0, i - half), i + half + 1);
    return { time: point.time, x: median(around.map((p) => p.x)), y: median(around.map((p) => p.y)) };
  });
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

/** What a {@link FaceScanner} looks at: one angle's file. */
export interface FaceScanRequest {
  ffmpeg: string;
  /** Absolute path of the angle's file. */
  path: string;
  /** Its picture size, for the aspect frames keep. */
  width: number;
  height: number;
  /** Seconds of the file, for progress; unknown: no fraction. */
  duration?: number | undefined;
  crop?: AngleCrop | undefined;
  /** 0..1 of the file looked at. */
  onProgress?: ((fraction: number) => void) | undefined;
  /** Stops the scan; it then rejects. */
  signal?: AbortSignal | undefined;
}

/** Input of {@link angleFaceKeys}. */
export interface AngleFaceOptions extends FaceScanRequest {
  detect: FaceDetector;
}

/** Samples, detects, follows and proposes keys for one angle's file. */
export type FaceScanner = (request: FaceScanRequest) => Promise<AngleFaces>;

/** What {@link angleFaceKeys} found in one angle's file. */
export interface AngleFaces {
  /** Frames looked at. */
  samples: number;
  /** Of those, frames with a face inside the crop. */
  faces: number;
  /** Proposed keys, source seconds. */
  keys: FacePoint[];
}

/** Sample, detect, follow and propose keys for one angle's file. */
export async function angleFaceKeys(options: AngleFaceOptions): Promise<AngleFaces> {
  const size = faceFrameSize(options.width, options.height);
  const samples: FaceSample[] = [];
  for await (const { time, frame } of sampleFaceFrames(options.ffmpeg, options.path, size)) {
    options.signal?.throwIfAborted();
    samples.push({ time, faces: await options.detect(frame) });
    if (options.duration && options.duration > 0) options.onProgress?.(Math.min(1, time / options.duration));
  }
  const track = mainFaceTrack(samples, options.crop);
  return { samples: samples.length, faces: track.length, keys: proposeReframeKeys(track) };
}

/** Files the face worker loads: ONNX Runtime Web's module and the YuNet model. */
export interface YunetFiles {
  runtime: string;
  model: string;
}

/** Messages from `faces-worker.js`. */
export type FaceWorkerMessage =
  | { type: "progress"; fraction: number }
  | { type: "done"; result: AngleFaces }
  | { type: "error"; message: string };

/**
 * Worker script beside this module. Under the test runner this module is the
 * TypeScript source, so the worker runs from the build (`pnpm test` builds first).
 */
const FACE_WORKER = import.meta.url.endsWith(".ts")
  ? new URL("../../dist/multicam/faces-worker.js", import.meta.url)
  : new URL("./faces-worker.js", import.meta.url);

/**
 * {@link FaceScanner} running YuNet in a worker thread per scan, so decoding
 * and inference never block the daemon's event loop. Aborting terminates it.
 */
export function yunetWorkerScanner(files: YunetFiles): FaceScanner {
  return ({ onProgress, signal, ...request }) =>
    new Promise<AngleFaces>((resolve, reject) => {
      signal?.throwIfAborted();
      const worker = new Worker(FACE_WORKER, { workerData: { ...files, ...request } });
      const abort = () => {
        void worker.terminate();
        reject(signal!.reason as Error);
      };
      signal?.addEventListener("abort", abort, { once: true });
      const settle = () => signal?.removeEventListener("abort", abort);
      worker.on("message", (message: FaceWorkerMessage) => {
        if (message.type === "progress") return onProgress?.(message.fraction);
        settle();
        void worker.terminate();
        if (message.type === "done") resolve(message.result);
        else reject(new Error(message.message));
      });
      worker.once("error", (error) => {
        settle();
        reject(error);
      });
      // A promise settles once: after a result this rejection is ignored.
      worker.once("exit", (code) => {
        settle();
        reject(new Error(`face detection worker exited (code ${code}) without a result`));
      });
    });
}
