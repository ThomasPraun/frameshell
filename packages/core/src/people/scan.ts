// Face scan of one video (ADR 0020 decision 4): sample frames, find faces with YuNet, embed them with SFace,
// and join detections over time into tracks. The models run in a worker thread (`scan-worker.ts`).
import { Worker } from "node:worker_threads";
import {
  type BgrFrame,
  type Face,
  type FaceDetector,
  faceFrameSize,
  faceOverlap,
  loadOrtSession,
  loadYunet,
  sampleFaceFrames,
} from "../multicam/faces.js";

/** Numbers SFace gives per face. */
export const FACE_EMBEDDING_DIMS = 128;

/** Widest picture decoded for embedding; YuNet looks at a {@link faceFrameSize} copy. */
const SCAN_MAX_WIDTH = 1280;

/** Faces narrower or shorter than this many pixels (of the decoded picture) are tracked but not embedded. */
export const MIN_EMBED_PX = 32;

/** SFace's input side. */
const ALIGNED_SIZE = 112;

/**
 * Where OpenCV's `FaceRecognizerSF.alignCrop` puts the five landmarks in the
 * 112×112 crop (ArcFace's template), in the order YuNet gives them.
 */
const ALIGN_TEMPLATE: readonly (readonly [number, number])[] = [
  [38.2946, 51.6963],
  [73.5318, 51.5014],
  [56.0252, 71.7366],
  [41.5493, 92.3655],
  [70.7299, 92.2041],
];

/** A landmark set in pixels of a frame. */
export type Landmarks = readonly (readonly [number, number])[];

/** `[[a, -b], [b, a]]` times a point, plus `(tx, ty)`: a rotation, uniform scale and shift. */
export interface Similarity {
  a: number;
  b: number;
  tx: number;
  ty: number;
}

/**
 * Least-squares similarity transform taking `from` onto `to` (Umeyama, 2D):
 * the one OpenCV's `alignCrop` fits from detected landmarks to the template.
 */
export function similarityTransform(from: Landmarks, to: Landmarks): Similarity {
  const n = from.length;
  const mean = (points: Landmarks, axis: 0 | 1) => points.reduce((sum, point) => sum + point[axis], 0) / n;
  const [fx, fy, tx, ty] = [mean(from, 0), mean(from, 1), mean(to, 0), mean(to, 1)];
  let norm = 0;
  let dot = 0;
  let cross = 0;
  for (let i = 0; i < n; i++) {
    const [px, py] = [from[i]![0] - fx, from[i]![1] - fy];
    const [qx, qy] = [to[i]![0] - tx, to[i]![1] - ty];
    norm += px * px + py * py;
    dot += px * qx + py * qy;
    cross += px * qy - py * qx;
  }
  if (norm === 0) throw new Error("Landmarks collapsed to a point: cannot align the face.");
  const a = dot / norm;
  const b = cross / norm;
  return { a, b, tx: tx - (a * fx - b * fy), ty: ty - (b * fx + a * fy) };
}

/**
 * The face of `frame` with `landmarks` (pixels), warped to the 112×112 SFace
 * takes as `[1, 3, 112, 112]` floats, RGB in 0..255 (OpenCV swaps BGR to RGB
 * and does no other scaling). Bilinear, outside the picture black, as
 * `warpAffine` does.
 */
export function alignFace(frame: BgrFrame, landmarks: Landmarks): Float32Array {
  const { a, b, tx, ty } = similarityTransform(landmarks, ALIGN_TEMPLATE);
  const scale = a * a + b * b;
  const { width, height, data } = frame;
  const plane = ALIGNED_SIZE * ALIGNED_SIZE;
  const out = new Float32Array(3 * plane);
  const pixel = (x: number, y: number, channel: number) => (x < 0 || y < 0 || x >= width || y >= height ? 0 : data[(y * width + x) * 3 + channel]!);
  for (let row = 0; row < ALIGNED_SIZE; row++) {
    for (let col = 0; col < ALIGNED_SIZE; col++) {
      const [dx, dy] = [col - tx, row - ty];
      const sx = (a * dx + b * dy) / scale;
      const sy = (a * dy - b * dx) / scale;
      const [x0, y0] = [Math.floor(sx), Math.floor(sy)];
      const [fx, fy] = [sx - x0, sy - y0];
      for (let channel = 0; channel < 3; channel++) {
        const value =
          pixel(x0, y0, channel) * (1 - fx) * (1 - fy) +
          pixel(x0 + 1, y0, channel) * fx * (1 - fy) +
          pixel(x0, y0 + 1, channel) * (1 - fx) * fy +
          pixel(x0 + 1, y0 + 1, channel) * fx * fy;
        // BGR in, RGB planes out.
        out[(2 - channel) * plane + row * ALIGNED_SIZE + col] = value;
      }
    }
  }
  return out;
}

/** Embeds one aligned face ({@link alignFace}) as {@link FACE_EMBEDDING_DIMS} numbers of length 1. */
export type FaceEmbedder = (aligned: Float32Array) => Promise<Float32Array>;

/** {@link FaceEmbedder} running the SFace model at `model` with the ONNX Runtime Web module at `runtime`. */
export async function loadSface(runtime: string, model: string): Promise<FaceEmbedder> {
  const { ort, session } = await loadOrtSession(runtime, model);
  const input = session.inputNames[0] ?? "data";
  return async (aligned) => {
    const outputs = await session.run({ [input]: new ort.Tensor("float32", aligned, [1, 3, ALIGNED_SIZE, ALIGNED_SIZE]) });
    const first = Object.values(outputs)[0]?.data as Float32Array | undefined;
    if (!first || first.length !== FACE_EMBEDDING_DIMS) throw new Error(`SFace gave ${first?.length ?? 0} numbers, not ${FACE_EMBEDDING_DIMS}: not the pinned model?`);
    return normalized(first);
  };
}

function normalized(vector: ArrayLike<number>): Float32Array {
  let sum = 0;
  for (let i = 0; i < vector.length; i++) sum += vector[i]! * vector[i]!;
  const length = Math.sqrt(sum) || 1;
  return Float32Array.from(vector as ArrayLike<number> & Iterable<number>, (value) => value / length);
}

/** Cosine similarity of two vectors. */
export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

/**
 * `frame` scaled down to `width`×`height` by averaging the source pixels each
 * target pixel covers (never up).
 */
export function shrinkFrame(frame: BgrFrame, width: number, height: number): BgrFrame {
  if (width >= frame.width && height >= frame.height) return frame;
  const data = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    const y0 = Math.floor((y * frame.height) / height);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * frame.height) / height));
    for (let x = 0; x < width; x++) {
      const x0 = Math.floor((x * frame.width) / width);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * frame.width) / width));
      const sums = [0, 0, 0];
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const at = (sy * frame.width + sx) * 3;
          sums[0]! += frame.data[at]!;
          sums[1]! += frame.data[at + 1]!;
          sums[2]! += frame.data[at + 2]!;
        }
      }
      const count = (y1 - y0) * (x1 - x0);
      for (let c = 0; c < 3; c++) data[(y * width + x) * 3 + c] = Math.round(sums[c]! / count);
    }
  }
  return { width, height, data };
}

/** Longest gap in seconds a track survives without a detection. */
const TRACK_GAP_S = 1;
/** A detection joins a track whose last box it overlaps by at least this (intersection over union); faces move up to a box width between samples. */
const TRACK_MIN_OVERLAP = 0.25;
/** An embedding joins a track whose mean it is at least this similar to (cosine). SFace's own same-person line is 0.363; looser here, as angle and blur lower it. */
const TRACK_MIN_SIMILARITY = 0.2;

/** One detection of a track: box center `x`, `y` and size as fractions of the picture, detector score. */
export interface TrackBox {
  time: number;
  x: number;
  y: number;
  width: number;
  height: number;
  score: number;
}

/** A face followed over time. */
export interface FaceTrack {
  /** `t1`, `t2`… in order of first sight. */
  id: string;
  /** Seconds of the first and last detection. */
  start: number;
  end: number;
  /** One per detection, in time order. */
  boxes: TrackBox[];
  /** At most one per second of the track, in time order; the vectors have length 1. */
  embeddings: { time: number; vector: Float32Array }[];
}

interface OpenTrack extends FaceTrack {
  /** Sum of the embeddings so far (for the mean's direction). */
  sum: Float32Array;
}

/**
 * Joins the faces of successive samples into {@link FaceTrack}s: a face
 * continues the track its box overlaps most (best pairs first), unless its
 * embedding, taken once per track per second, is nowhere near the track's
 * mean: two people crossing keep their own tracks. Faces nobody continues
 * start tracks; a track nobody continues for {@link TRACK_GAP_S} ends.
 */
export class FaceTracker {
  readonly #open: OpenTrack[] = [];
  readonly #done: OpenTrack[] = [];
  #count = 0;

  /**
   * Take the faces of the sample at `time` (seconds, increasing). `embed`
   * gives a face's embedding, or null when it cannot have one (too small, no
   * landmarks); it is called at most once per face, and only when a track
   * has none yet for this second.
   */
  async add(time: number, faces: readonly Face[], embed: (face: Face) => Promise<Float32Array | null>): Promise<void> {
    for (let i = this.#open.length - 1; i >= 0; i--) {
      if (time - this.#open[i]!.end > TRACK_GAP_S) this.#done.push(...this.#open.splice(i, 1));
    }
    const embeddings = new Map<Face, Promise<Float32Array | null>>();
    const embedOnce = (face: Face) => {
      let found = embeddings.get(face);
      if (!found) embeddings.set(face, (found = embed(face)));
      return found;
    };
    const pairs = this.#open
      .flatMap((track) => faces.map((face) => ({ track, face, score: faceOverlap(lastBox(track), face) })))
      .filter((pair) => pair.score >= TRACK_MIN_OVERLAP)
      .sort((a, b) => b.score - a.score);
    const taken = new Set<Face>();
    const used = new Set<OpenTrack>();
    for (const { track, face } of pairs) {
      if (taken.has(face) || used.has(track)) continue;
      const due = this.#embeddingDue(track, time);
      const vector = due ? await embedOnce(face) : null;
      if (vector && track.embeddings.length > 0 && cosine(vector, track.sum) < TRACK_MIN_SIMILARITY) continue;
      taken.add(face);
      used.add(track);
      this.#extend(track, time, face, vector);
    }
    for (const face of faces) {
      if (taken.has(face)) continue;
      const track: OpenTrack = { id: `t${++this.#count}`, start: time, end: time, boxes: [], embeddings: [], sum: new Float32Array(FACE_EMBEDDING_DIMS) };
      this.#open.push(track);
      this.#extend(track, time, face, await embedOnce(face));
    }
  }

  /** Every track, ended or not, by first sight. */
  finish(): FaceTrack[] {
    const all = [...this.#done, ...this.#open].sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)));
    return all.map(({ sum: _sum, ...track }) => track);
  }

  #embeddingDue(track: OpenTrack, time: number): boolean {
    const last = track.embeddings.at(-1);
    return !last || Math.floor(time) !== Math.floor(last.time);
  }

  #extend(track: OpenTrack, time: number, face: Face, vector: Float32Array | null): void {
    track.end = time;
    track.boxes.push({ time, x: face.x, y: face.y, width: face.width, height: face.height, score: face.score });
    if (!vector) return;
    track.embeddings.push({ time, vector });
    for (let i = 0; i < vector.length; i++) track.sum[i]! += vector[i]!;
  }
}

function lastBox(track: OpenTrack): Face {
  return track.boxes.at(-1)!;
}

/** What {@link scanPeopleFaces} looks at: one video file. */
export interface PeopleScanRequest {
  ffmpeg: string;
  /** Absolute path of the file. */
  path: string;
  /** Its picture size, for the aspect frames keep. */
  width: number;
  height: number;
  /** Seconds of the file, for progress; unknown: no fraction. */
  duration?: number | undefined;
  /** 0..1 of the file looked at. */
  onProgress?: ((fraction: number) => void) | undefined;
  /** Stops the scan; it then rejects. */
  signal?: AbortSignal | undefined;
}

/** What a scan found in one video. */
export interface PeopleScanResult {
  /** Size of the pictures faces were embedded from, pixels. */
  width: number;
  height: number;
  /** Frames looked at, 2 per second (`FACE_SAMPLE_HZ`). */
  samples: number;
  /** Faces followed, by first sight. */
  tracks: FaceTrack[];
}

/** Scans one video for faces and their tracks. */
export type PeopleScanner = (request: PeopleScanRequest) => Promise<PeopleScanResult>;

/** Input of {@link scanPeopleFaces}. */
export interface PeopleScanOptions extends PeopleScanRequest {
  /** Finds faces and their landmarks in a frame of {@link faceFrameSize}. */
  detect: FaceDetector;
  /** Embeds an aligned face. */
  embed: FaceEmbedder;
}

/**
 * Size pictures are decoded at: the file's own up to {@link SCAN_MAX_WIDTH} wide,
 * even sides, the aspect kept.
 */
export function scanFrameSize(width: number, height: number): { width: number; height: number } {
  const scaled = Math.min(SCAN_MAX_WIDTH, width);
  const even = (value: number) => Math.max(2, Math.round(value / 2) * 2);
  return { width: even(scaled), height: even((scaled * height) / Math.max(1, width)) };
}

/**
 * Sample the video, find faces on a {@link faceFrameSize} copy of each frame,
 * embed those of at least {@link MIN_EMBED_PX} pixels from the full-size
 * picture and follow them with a {@link FaceTracker}.
 */
export async function scanPeopleFaces(options: PeopleScanOptions): Promise<PeopleScanResult> {
  const size = scanFrameSize(options.width, options.height);
  const small = faceFrameSize(options.width, options.height);
  const tracker = new FaceTracker();
  let samples = 0;
  for await (const { time, frame } of sampleFaceFrames(options.ffmpeg, options.path, size)) {
    options.signal?.throwIfAborted();
    samples++;
    const faces = await options.detect(shrinkFrame(frame, small.width, small.height));
    await tracker.add(time, faces, async (face) => {
      const { landmarks } = face;
      if (!landmarks || landmarks.length !== ALIGN_TEMPLATE.length) return null;
      if (face.width * frame.width < MIN_EMBED_PX || face.height * frame.height < MIN_EMBED_PX) return null;
      const points = landmarks.map(([x, y]): [number, number] => [x * frame.width, y * frame.height]);
      return options.embed(alignFace(frame, points));
    });
    if (options.duration && options.duration > 0) options.onProgress?.(Math.min(1, time / options.duration));
  }
  return { ...size, samples, tracks: tracker.finish() };
}

/** Files the scan worker loads: ONNX Runtime Web's module and the two models. */
export interface PeopleScanFiles {
  runtime: string;
  detector: string;
  recognizer: string;
}

/** Messages from `scan-worker.js`. */
export type PeopleScanWorkerMessage =
  | { type: "progress"; fraction: number }
  | { type: "done"; result: PeopleScanResult }
  | { type: "error"; message: string };

/** Loads both models: what the worker does before scanning. */
export async function loadScanModels(files: PeopleScanFiles): Promise<{ detect: FaceDetector; embed: FaceEmbedder }> {
  return { detect: await loadYunet(files.runtime, files.detector), embed: await loadSface(files.runtime, files.recognizer) };
}

/**
 * Worker script beside this module. Under the test runner this module is the
 * TypeScript source, so the worker runs from the build (`pnpm test` builds first).
 */
const SCAN_WORKER = import.meta.url.endsWith(".ts")
  ? new URL("../../dist/people/scan-worker.js", import.meta.url)
  : new URL("./scan-worker.js", import.meta.url);

/**
 * {@link PeopleScanner} running YuNet and SFace in a worker thread per scan, so
 * decoding and inference never block the daemon's event loop. Aborting terminates it.
 */
export function peopleScanWorker(files: PeopleScanFiles): PeopleScanner {
  return ({ onProgress, signal, ...request }) =>
    new Promise<PeopleScanResult>((resolve, reject) => {
      signal?.throwIfAborted();
      const worker = new Worker(SCAN_WORKER, { workerData: { ...files, ...request } });
      const abort = () => {
        void worker.terminate();
        reject(signal!.reason as Error);
      };
      signal?.addEventListener("abort", abort, { once: true });
      const settle = () => signal?.removeEventListener("abort", abort);
      worker.on("message", (message: PeopleScanWorkerMessage) => {
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
        reject(new Error(`face scan worker exited (code ${code}) without a result`));
      });
    });
}
