import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { ErrorCode, RpcError } from "@frameshell/protocol";
import type { InstallProgress } from "../binaries/manager.js";
import { PHOTO_SEGMENTATION_ENCODER_MODEL, PHOTO_SEGMENTATION_MODELS } from "../binaries/manifest.js";
import {
  type PhotoInput,
  type PhotoPoint,
  type PixelSize,
  type SegmentEngine,
  type SegmentResult,
  Segmenter,
  preparedSize,
} from "./segmenter.js";

const execFileAsync = promisify(execFile);

/** The pinned model as results name it: `mobilesam@<revision>`. */
export const SEGMENT_MODEL_PIN = `mobilesam@${PHOTO_SEGMENTATION_MODELS.find((model) => model.id === PHOTO_SEGMENTATION_ENCODER_MODEL)!.version.slice(0, 8)}`;

/** Called while the runtime and models install. */
export type SegmentProgress = (progress: InstallProgress) => void;

/**
 * Packed 8-bit RGB of the first picture of absolute `path`, scaled to `size`
 * (transparency dropped). Throws when ffmpeg cannot decode the file.
 */
export async function readPhotoRgb(ffmpeg: string, path: string, size: PixelSize): Promise<Uint8Array> {
  const bytes = size.width * size.height * 3;
  const args = ["-hide_banner", "-loglevel", "error", "-nostdin", "-i", path, "-frames:v", "1", "-vf", `scale=${size.width}:${size.height}:flags=bicubic,format=rgb24`, "-f", "rawvideo", "-"];
  const { stdout } = await execFileAsync(ffmpeg, args, { encoding: "buffer", maxBuffer: bytes + 1024 * 1024, windowsHide: true });
  if (stdout.length !== bytes) throw new Error(`ffmpeg gave ${stdout.length} bytes for a ${size.width}x${size.height} picture of ${path}, expected ${bytes}`);
  return new Uint8Array(stdout.buffer, stdout.byteOffset, stdout.length);
}

/** What {@link SegmentService} needs from the daemon. */
export interface SegmentServiceOptions {
  /** Picture of a project-relative asset, as the media service probes it (rotation applied). */
  probe(dir: string, asset: string): Promise<{ video: (PixelSize & { still: boolean }) | null }>;
  /** `sha256:<hex>` of the asset's content. */
  hash(dir: string, asset: string): Promise<string>;
  /** Absolute path of ffmpeg, installing it when missing. */
  ffmpeg(dir: string, onProgress?: SegmentProgress): Promise<string>;
  /** The model, installing the runtime and both model files when missing. Called once, by the first photo. */
  engine(dir: string, onProgress?: SegmentProgress): Promise<SegmentEngine & { close?(): Promise<void> }>;
  /** Photos whose embedding is kept. Default 8. */
  cacheSize?: number;
}

/** A photo made ready for clicks. */
export interface PreparedPhoto extends PixelSize {
  /** Project-relative asset path. */
  asset: string;
  /** Content hash the embedding is cached under. */
  hash: string;
  /** True when it was ready already. */
  cached: boolean;
}

/**
 * Photo segmentation of a project's still images (ADR 0022): prepares a photo
 * (the encoder, once) and answers a click in it with three masks. Embeddings
 * live in memory only, by asset content hash, across projects.
 */
export class SegmentService {
  readonly #options: SegmentServiceOptions;
  #segmenter: Promise<{ segmenter: Segmenter; engine: SegmentEngine & { close?(): Promise<void> } }> | undefined;

  constructor(options: SegmentServiceOptions) {
    this.#options = options;
  }

  /**
   * Encode the still image `asset` (project-relative) of the project at `dir`,
   * installing what the model needs first. Concurrent calls for one photo share
   * the work. Throws `AssetNotFound`, `InvalidOperation` when the asset is not a
   * still image, or the Binary* errors.
   */
  async prepare(dir: string, asset: string, onProgress?: SegmentProgress): Promise<PreparedPhoto> {
    const photo = await this.#photo(dir, asset, onProgress);
    const { segmenter } = await this.#load(dir, onProgress);
    const { cached } = await segmenter.prepare(photo.input);
    return { asset, hash: photo.input.key, width: photo.input.width, height: photo.input.height, cached };
  }

  /**
   * The three masks (smallest first) of the part of still image `asset` under
   * `point`, in pixels of the asset itself, preparing the photo when needed.
   * Throws as {@link SegmentService.prepare} does.
   */
  async segment(
    dir: string,
    asset: string,
    point: PhotoPoint,
    onProgress?: SegmentProgress,
  ): Promise<SegmentResult & { hash: string; cached: boolean }> {
    const photo = await this.#photo(dir, asset, onProgress);
    const { segmenter } = await this.#load(dir, onProgress);
    return { ...(await segmenter.segment(photo.input, point)), hash: photo.input.key };
  }

  /** Stop the worker and drop the embeddings. */
  async close(): Promise<void> {
    const loaded = await this.#segmenter?.catch(() => undefined);
    this.#segmenter = undefined;
    loaded?.segmenter.clear();
    await loaded?.engine.close?.();
  }

  #load(dir: string, onProgress?: SegmentProgress) {
    this.#segmenter ??= this.#options.engine(dir, onProgress).then((engine) => ({ engine, segmenter: new Segmenter(engine, this.#options.cacheSize) }));
    // A failed install is tried again by the next call.
    this.#segmenter.catch(() => (this.#segmenter = undefined));
    return this.#segmenter;
  }

  async #photo(dir: string, asset: string, onProgress?: SegmentProgress): Promise<{ input: PhotoInput }> {
    const { video } = await this.#options.probe(dir, asset);
    if (!video?.still) {
      throw new RpcError(ErrorCode.InvalidOperation, `segment: ${asset} is not a still image.`, { op: "segment", reason: "not a still image", field: "asset" });
    }
    const key = await this.#options.hash(dir, asset);
    const path = join(dir, ...asset.split("/"));
    return {
      input: {
        key,
        width: video.width,
        height: video.height,
        readRgb: async () => readPhotoRgb(await this.#options.ffmpeg(dir, onProgress), path, preparedSize(video.width, video.height)),
      },
    };
  }
}
