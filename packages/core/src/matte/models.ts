// Matting model of the video subject matte (ADR 0032): how a frame becomes the model's input tensor and its
// output a coarse alpha. Pure: the worker runs the session, tests feed these directly.
import { VIDEO_MATTE_MODEL, VIDEO_MATTE_MODELS } from "../binaries/manifest.js";
import type { PlaneSize } from "./refine.js";

/** The pinned model as results and cache keys name it: `mediapipe-selfie@<revision>`. */
export const MATTE_MODEL_PIN = `${VIDEO_MATTE_MODEL}@${VIDEO_MATTE_MODELS[0]!.version}`;

/** What one model needs to be fed and read. */
export interface MatteModelSpec {
  /** Model id of the pin in the binaries manifest. */
  id: string;
  /** Input tensor size for a frame of `frame` size. */
  inputSize(frame: PlaneSize): PlaneSize;
  /** Name of the input tensor. */
  input: string;
  /** Name of the output tensor. */
  output: string;
  /** Per-channel mean in `(v / 255 - mean) / std` applied to RGB bytes. */
  mean: number;
  /** Per-channel divisor in `(v / 255 - mean) / std`. */
  std: number;
}

/**
 * MediaPipe selfie segmenter, general model (Apache-2.0, Google's model card): fixed 256×256 RGB 0..1 in,
 * person probability 0..1 out at the same size. Frames of any aspect are squeezed to the square; the spike
 * found it steadier than the 256×144 landscape model even on 16:9 (`docs/research/video-subject-matte.md`).
 */
export const SELFIE: MatteModelSpec = {
  id: VIDEO_MATTE_MODEL,
  inputSize: () => ({ width: 256, height: 256 }),
  input: "pixel_values",
  output: "alphas",
  mean: 0,
  std: 1,
};

/**
 * NCHW float input of `spec` from packed 8-bit RGB of `frame` size, each input pixel the mean of the frame
 * pixels it covers (no aliasing when shrinking 540p to 256 px).
 */
export function modelInput(spec: MatteModelSpec, rgb: Uint8Array, frame: PlaneSize): { data: Float32Array; size: PlaneSize } {
  const size = spec.inputSize(frame);
  const plane = size.width * size.height;
  const data = new Float32Array(3 * plane);
  const sx = frame.width / size.width;
  const sy = frame.height / size.height;
  for (let y = 0; y < size.height; y++) {
    const y0 = Math.min(frame.height - 1, Math.floor(y * sy));
    const y1 = Math.max(y0 + 1, Math.min(frame.height, Math.floor((y + 1) * sy)));
    for (let x = 0; x < size.width; x++) {
      const x0 = Math.min(frame.width - 1, Math.floor(x * sx));
      const x1 = Math.max(x0 + 1, Math.min(frame.width, Math.floor((x + 1) * sx)));
      let r = 0;
      let g = 0;
      let b = 0;
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const i = (yy * frame.width + xx) * 3;
          r += rgb[i]!;
          g += rgb[i + 1]!;
          b += rgb[i + 2]!;
        }
      }
      const count = 255 * (y1 - y0) * (x1 - x0);
      const at = y * size.width + x;
      data[at] = (r / count - spec.mean) / spec.std;
      data[plane + at] = (g / count - spec.mean) / spec.std;
      data[2 * plane + at] = (b / count - spec.mean) / spec.std;
    }
  }
  return { data, size };
}

/** Coarse alpha 0..1 from a model's output plane (clamped: fp rounding goes slightly past either end). */
export function coarseAlpha(output: ArrayLike<number>, size: PlaneSize): Float32Array {
  const plane = size.width * size.height;
  if (output.length !== plane) throw new Error(`matte model gave ${output.length} values for a ${size.width}x${size.height} input: not the pinned model?`);
  const out = new Float32Array(plane);
  for (let i = 0; i < plane; i++) out[i] = Math.min(1, Math.max(0, output[i]!));
  return out;
}
