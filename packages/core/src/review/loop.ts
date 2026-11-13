import type { ReviewCraftWarning, ReviewSeam } from "@frameshell/protocol";
import { DUPLICATE_DIFF, MOTION_DIFF, meanAbsDiff, seamPictureSize } from "../export/seam.js";
import { readRawFrames } from "../media/raw-frames.js";
import { SEAM_CONTINUOUS } from "./thresholds.js";

// The seam of a loop as a number (#457, ADR 0039 slice 3). The measure is the one the render's loop check uses
// (`export/seam.ts`: mean absolute grey difference of two pictures at 160 px); this adds the jump between the last and the first frame.

/** The verdict on a jump of `jump` grey levels; `moves`: the picture moves elsewhere in the film (a held title has no seam to repeat). */
export function seamVerdict(jump: number, moves: boolean): ReviewSeam["verdict"] {
  if (jump < DUPLICATE_DIFF && moves) return "duplicate";
  return jump < SEAM_CONTINUOUS ? "continuous" : "cut";
}

/** Whether a series of mean grey changes holds one of {@link MOTION_DIFF} levels or more. */
export function pictureMoves(energy: readonly number[]): boolean {
  return energy.some((value) => value >= MOTION_DIFF);
}

/** The picture of the PNG at `path` as grey pixels at the seam's size. */
async function grey(ffmpeg: string, path: string, size: { width: number; height: number }): Promise<Uint8Array> {
  const { width, height } = seamPictureSize(size);
  for await (const frame of readRawFrames(ffmpeg, path, `scale=${width}:${height}:flags=area,format=gray`, width * height)) return frame;
  throw new Error(`ffmpeg decoded no picture from ${path}`);
}

/** Mean grey difference, 0 to 255, between the pictures in the PNGs `first` and `last` of a film of `size` px. */
export async function seamJump(ffmpeg: string, first: string, last: string, size: { width: number; height: number }): Promise<number> {
  return meanAbsDiff(await grey(ffmpeg, first, size), await grey(ffmpeg, last, size));
}

/** The craft warning of a seam for a film meant to repeat: it holds a frame twice or jumps. */
export function seamWarnings(seam: ReviewSeam): ReviewCraftWarning[] {
  if (seam.verdict === "continuous") return [];
  const message =
    seam.verdict === "duplicate"
      ? `the loop holds a frame twice at the seam: the last frame (${seam.last} s) repeats the first (difference ${seam.jump} of 255). End the last key one frame earlier, or trim one frame off the end.`
      : `the loop jumps at the seam: the last frame (${seam.last} s) differs from the first by ${seam.jump} of 255 (a hard cut reads 40 to 80, under ${SEAM_CONTINUOUS} reads as continuous). ` +
        "Let the last key return to the first, or fade across the seam.";
  return [{ check: "loop-seam", from: seam.last, to: seam.last, message }];
}
