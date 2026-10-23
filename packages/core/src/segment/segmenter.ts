// Photo segmentation (ADR 0022): MobileSAM on ONNX Runtime Web. The encoder runs once per photo and its
// embedding is cached; each click only runs the small decoder and is turned into three masks in photo pixels.
import { readFile } from "node:fs/promises";
import { importOrt } from "../multicam/faces.js";

/** Long side, in pixels, of the picture the encoder sees; the model's native input size. */
export const SEGMENT_LONG_SIDE = 1024;

/** Photos whose embedding is kept (4 MB each), least recently used dropped first. */
export const SEGMENT_CACHE_SIZE = 8;

/** Side of the embedding grid (`image_embeddings` is `[1, 256, 64, 64]`). */
const EMBEDDING_FLOATS = 256 * 64 * 64;

/** Side of the low-resolution mask prior the decoder takes. */
const MASK_PRIOR_SIDE = 256;

/** Masks the decoder answers one point with, smallest first. */
export const SEGMENT_MASKS = 3;

/** Picture size, in pixels. */
export interface PixelSize {
  width: number;
  height: number;
}

/** Size a `width`×`height` photo is scaled to for the encoder: long side {@link SEGMENT_LONG_SIDE}, aspect kept. */
export function preparedSize(width: number, height: number): PixelSize {
  const scale = SEGMENT_LONG_SIDE / Math.max(width, height);
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** Encoder input: packed 8-bit RGB as float32 in 0..255 (the graph normalizes and pads itself). */
export function encoderInput(rgb: Uint8Array): Float32Array {
  return Float32Array.from(rgb);
}

/** A click, in pixels of the photo itself (top-left origin, fractions allowed). */
export interface PhotoPoint {
  x: number;
  y: number;
}

/**
 * The click in the encoder's pixel space (`prepared` is {@link preparedSize} of
 * `photo`), clamped to the picture.
 */
export function clickInPreparedSpace(point: PhotoPoint, photo: PixelSize, prepared: PixelSize): PhotoPoint {
  const x = (point.x * prepared.width) / photo.width;
  const y = (point.y * prepared.height) / photo.height;
  return { x: Math.min(prepared.width, Math.max(0, x)), y: Math.min(prepared.height, Math.max(0, y)) };
}

/** What the decoder said about one click, at the encoder's picture size. */
export interface DecoderOutput {
  /** Four masks of `width * height` logits one after another; above 0 is inside. Masks 1 to 3 are the answers. */
  logits: Float32Array;
  /** The model's quality estimate of each of the four masks. */
  scores: Float32Array;
  width: number;
  height: number;
}

/** The two halves of the model: what a worker, or a test, provides. */
export interface SegmentEngine {
  /** Embedding of packed RGB `rgb` (`size` pixels). */
  encode(rgb: Uint8Array, size: PixelSize): Promise<Float32Array>;
  /** Decoder run for one included point in the encoder's pixel space. */
  decode(embedding: Float32Array, point: PhotoPoint, size: PixelSize): Promise<DecoderOutput>;
}

/** The part of the photo under a click, as a mask over the whole photo. */
export interface PhotoMask {
  /** One byte per photo pixel, rows top to bottom: 255 inside, 0 outside. */
  mask: Uint8Array;
  /** `[x, y, width, height]` of the smallest box holding the mask, in photo pixels; all 0 for an empty mask. */
  bbox: [number, number, number, number];
  /** Share of the photo the mask covers, 0..1. */
  area: number;
  /** The model's own estimate of the mask's quality, 0..1. */
  score: number;
}

/** The three answers to one click. */
export interface SegmentResult extends PixelSize {
  /** Smallest first (a part of a part, a part, the whole thing). */
  masks: PhotoMask[];
  /** Index in `masks` of the best score. */
  chosen: number;
}

/**
 * Mask from logits of `from` pixels, bilinearly upscaled to `to` pixels and
 * thresholded at 0, so the edge follows the model's soft boundary instead of
 * its blocky pixels.
 */
export function upscaleMask(logits: Float32Array, from: PixelSize, to: PixelSize, score: number): PhotoMask {
  const mask = new Uint8Array(to.width * to.height);
  const stepX = from.width / to.width;
  const stepY = from.height / to.height;
  let minX = to.width;
  let minY = to.height;
  let maxX = -1;
  let maxY = -1;
  let count = 0;
  for (let y = 0; y < to.height; y++) {
    const sy = Math.min(from.height - 1, Math.max(0, (y + 0.5) * stepY - 0.5));
    const y0 = Math.floor(sy);
    const y1 = Math.min(from.height - 1, y0 + 1);
    const fy = sy - y0;
    for (let x = 0; x < to.width; x++) {
      const sx = Math.min(from.width - 1, Math.max(0, (x + 0.5) * stepX - 0.5));
      const x0 = Math.floor(sx);
      const x1 = Math.min(from.width - 1, x0 + 1);
      const fx = sx - x0;
      const top = logits[y0 * from.width + x0]! * (1 - fx) + logits[y0 * from.width + x1]! * fx;
      const bottom = logits[y1 * from.width + x0]! * (1 - fx) + logits[y1 * from.width + x1]! * fx;
      if (top * (1 - fy) + bottom * fy <= 0) continue;
      mask[y * to.width + x] = 255;
      count++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  return {
    mask,
    bbox: count === 0 ? [0, 0, 0, 0] : [minX, minY, maxX - minX + 1, maxY - minY + 1],
    area: count / (to.width * to.height),
    score: Math.min(1, Math.max(0, score)),
  };
}

/** Masks 1 to 3 of a decoder answer, in photo pixels, smallest first. */
export function masksOfAnswer(answer: DecoderOutput, photo: PixelSize): SegmentResult {
  const plane = answer.width * answer.height;
  const masks = Array.from({ length: SEGMENT_MASKS }, (_, k) =>
    upscaleMask(answer.logits.subarray((k + 1) * plane, (k + 2) * plane), answer, photo, answer.scores[k + 1] ?? 0),
  ).sort((a, b) => a.area - b.area);
  let chosen = 0;
  masks.forEach((mask, i) => {
    if (mask.score > masks[chosen]!.score) chosen = i;
  });
  return { ...photo, masks, chosen };
}

/** A photo to segment. */
export interface PhotoInput extends PixelSize {
  /** Identity of the content (its hash): the embedding is cached under it. */
  key: string;
  /** Packed 8-bit RGB of the photo scaled to {@link preparedSize}. Called only when the embedding is not cached. */
  readRgb(): Promise<Uint8Array>;
}

/**
 * Segments photos with a {@link SegmentEngine}: keeps the embeddings of the
 * last {@link SEGMENT_CACHE_SIZE} photos, joins callers that ask for one while
 * it is being encoded, and decodes clicks into masks.
 */
export class Segmenter {
  readonly #engine: SegmentEngine;
  readonly #capacity: number;
  /** Insertion order is recency: a hit moves its entry to the end. */
  readonly #embeddings = new Map<string, Promise<Float32Array>>();

  constructor(engine: SegmentEngine, capacity = SEGMENT_CACHE_SIZE) {
    this.#engine = engine;
    this.#capacity = capacity;
  }

  /** Photos whose embedding is held or being computed. */
  get cached(): number {
    return this.#embeddings.size;
  }

  /** Encode `photo` unless its embedding is held; `cached` says whether it was. */
  async prepare(photo: PhotoInput): Promise<{ cached: boolean }> {
    const known = this.#embeddings.get(photo.key);
    if (known) {
      this.#embeddings.delete(photo.key);
      this.#embeddings.set(photo.key, known);
      await known;
      return { cached: true };
    }
    const size = preparedSize(photo.width, photo.height);
    const embedding = photo.readRgb().then((rgb) => this.#engine.encode(rgb, size));
    this.#embeddings.set(photo.key, embedding);
    // A failed encode is not cached: the next call tries again.
    embedding.catch(() => {
      if (this.#embeddings.get(photo.key) === embedding) this.#embeddings.delete(photo.key);
    });
    while (this.#embeddings.size > this.#capacity) this.#embeddings.delete(this.#embeddings.keys().next().value!);
    await embedding;
    return { cached: false };
  }

  /** The three masks of the part under `point` (photo pixels), preparing the photo first when needed. */
  async segment(photo: PhotoInput, point: PhotoPoint): Promise<SegmentResult & { cached: boolean }> {
    const { cached } = await this.prepare(photo);
    const embedding = await this.#embeddings.get(photo.key)!;
    const prepared = preparedSize(photo.width, photo.height);
    const answer = await this.#engine.decode(embedding, clickInPreparedSpace(point, photo, prepared), prepared);
    return { ...masksOfAnswer(answer, photo), cached };
  }

  /** Drop every embedding. */
  clear(): void {
    this.#embeddings.clear();
  }
}

/**
 * {@link SegmentEngine} running MobileSAM's encoder and decoder at `encoder` and
 * `decoder` with the ONNX Runtime Web module at `runtime`, single-threaded in
 * this process. Inputs and outputs are those of Acly/MobileSAM's export.
 */
export async function loadMobileSam(runtime: string, encoder: string, decoder: string): Promise<SegmentEngine> {
  const ort = await importOrt(runtime);
  const create = async (path: string) => ort.InferenceSession.create(new Uint8Array(await readFile(path)));
  const [encoderSession, decoderSession] = await Promise.all([create(encoder), create(decoder)]);
  const tensor = (data: Float32Array, dims: readonly number[]) => new ort.Tensor("float32", data, dims);
  return {
    async encode(rgb, size) {
      const outputs = await encoderSession.run({ input_image: tensor(encoderInput(rgb), [size.height, size.width, 3]) });
      const embedding = outputs["image_embeddings"]?.data as Float32Array | undefined;
      if (embedding?.length !== EMBEDDING_FLOATS) throw new Error("MobileSAM's encoder gave no image_embeddings of 256x64x64: not the pinned model?");
      return embedding;
    },
    async decode(embedding, point, size) {
      const outputs = await decoderSession.run({
        image_embeddings: tensor(embedding, [1, 256, 64, 64]),
        // The included point, then the padding point (label -1) the export expects when there is no box.
        point_coords: tensor(Float32Array.of(point.x, point.y, 0, 0), [1, 2, 2]),
        point_labels: tensor(Float32Array.of(1, -1), [1, 2]),
        mask_input: tensor(new Float32Array(MASK_PRIOR_SIDE * MASK_PRIOR_SIDE), [1, 1, MASK_PRIOR_SIDE, MASK_PRIOR_SIDE]),
        has_mask_input: tensor(Float32Array.of(0), [1]),
        orig_im_size: tensor(Float32Array.of(size.height, size.width), [2]),
      });
      const logits = outputs["masks"]?.data as Float32Array | undefined;
      const scores = outputs["iou_predictions"]?.data as Float32Array | undefined;
      if (logits?.length !== 4 * size.width * size.height || !scores) throw new Error("MobileSAM's decoder gave no masks and iou_predictions: not the pinned model?");
      return { logits, scores, width: size.width, height: size.height };
    },
  };
}
