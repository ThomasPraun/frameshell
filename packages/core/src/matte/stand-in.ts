import { modelInput } from "./models.js";
import type { MatteInfer } from "./video.js";

/** Width of the stand-in's coarse alpha; its height keeps the frame's aspect. */
const STAND_IN_WIDTH = 128;

/**
 * Model-free {@link MatteInfer} for tests (`FRAMESHELL_MATTE_STAND_IN=1` in `frameshelld`): the subject is
 * whatever is brighter than mid-gray, so a light figure drawn on a dark background is matted. Downloads and
 * loads nothing; the rest of the job (smoothing, refinement, encoding, cache) runs as for the real model.
 */
export const standInMatte: MatteInfer = async (rgb, frame) => {
  const height = Math.max(1, Math.round((STAND_IN_WIDTH * frame.height) / frame.width));
  const spec = { id: "stand-in", inputSize: () => ({ width: STAND_IN_WIDTH, height }), input: "", output: "", mean: 0, std: 1 };
  const { data, size } = modelInput(spec, rgb, frame);
  const plane = size.width * size.height;
  const alpha = new Float32Array(plane);
  for (let i = 0; i < plane; i++) alpha[i] = 0.299 * data[i]! + 0.587 * data[plane + i]! + 0.114 * data[2 * plane + i]! >= 0.5 ? 1 : 0;
  return { alpha, size };
};
