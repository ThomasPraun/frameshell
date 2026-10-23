import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PhotoMask } from "../src/index.js";
import { run } from "./media-tools.js";

/** A filled disc, in photo pixels. */
export interface Disc {
  cx: number;
  cy: number;
  r: number;
}

/** PNG of a bright red disc on a dark blue-grey background: what a segmenter must cut out. */
export async function makeDiscPhoto(ffmpeg: string, path: string, width: number, height: number, disc: Disc): Promise<void> {
  const inside = `lt(hypot(X-${disc.cx},Y-${disc.cy}),${disc.r})`;
  const graph = `color=c=black:s=${width}x${height}:d=1,format=rgb24,geq=r='if(${inside},235,40)':g='if(${inside},60,50)':b='if(${inside},50,70)'`;
  await run(ffmpeg, ["-v", "error", "-f", "lavfi", "-i", graph, "-frames:v", "1", "-y", path]);
}

/** Intersection over union of a mask with a disc, over a `width`×`height` photo. */
export function overlapWithDisc(mask: PhotoMask, width: number, height: number, disc: Disc): number {
  let inter = 0;
  let union = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const a = mask.mask[y * width + x] === 255;
      const b = Math.hypot(x + 0.5 - disc.cx, y + 0.5 - disc.cy) < disc.r;
      if (a && b) inter++;
      if (a || b) union++;
    }
  }
  return inter / union;
}

/** Source of a fake ONNX Runtime Web module that tells its two "models" apart by their bytes: the words `encoder` and `decoder`. */
export function fakeRuntimeSource(): string {
  return `
export const env = { wasm: {} };
export class Tensor {
  constructor(type, data, dims) { this.type = type; this.data = data; this.dims = dims; }
}
export const InferenceSession = {
  async create(bytes) {
    const kind = new TextDecoder().decode(bytes);
    if (kind === "encoder") {
      return {
        inputNames: ["input_image"],
        async run(feeds) {
          const image = feeds.input_image;
          if (image.dims.length !== 3 || image.dims[2] !== 3) throw new Error("bad encoder dims " + image.dims);
          return { image_embeddings: { data: new Float32Array(256 * 64 * 64).fill(image.data[0]) } };
        },
      };
    }
    return {
      inputNames: [],
      async run(feeds) {
        const [h, w] = feeds.orig_im_size.data;
        const [px, py] = feeds.point_coords.data;
        const plane = h * w;
        const logits = new Float32Array(4 * plane).fill(-1);
        // Mask k is the pixels left of the click plus 10 * k, so each is larger than the one before.
        for (let k = 1; k <= 3; k++) for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (x < px + 10 * k) logits[k * plane + y * w + x] = 1;
        const first = feeds.image_embeddings.data[0];
        return {
          masks: { data: logits },
          iou_predictions: { data: Float32Array.of(0.1, first / 255, 0.9, 0.5) },
        };
      },
    };
  },
};
`;
}

/** Writes the fake runtime and its two fake model files into `dir`. */
export async function writeFakeModel(dir: string): Promise<{ runtime: string; encoder: string; decoder: string }> {
  const files = { runtime: join(dir, "runtime.mjs"), encoder: join(dir, "encoder.onnx"), decoder: join(dir, "decoder.onnx") };
  await writeFile(files.runtime, fakeRuntimeSource());
  await writeFile(files.encoder, "encoder");
  await writeFile(files.decoder, "decoder");
  return files;
}
