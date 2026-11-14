import type { ReviewFinding, ReviewSeam } from "@frameshell/protocol";
import { duplicateSeam, meanAbsDiff, seamPictureSize } from "../export/seam.js";
import { readRawFrames } from "../media/raw-frames.js";
import { SEAM_CONTINUOUS } from "./thresholds.js";

// The seam of a loop as a number (#457, ADR 0039 slice 3). The duplicate test is the render's loop check
// itself (`duplicateSeam` in `export/seam.ts`); this adds the jump between the last and the first frame.

/** The verdict on a jump of `jump` grey levels; `duplicate`: the last frame repeats the first while the picture moves ({@link duplicateSeam}). */
export function seamVerdict(jump: number, duplicate: boolean): ReviewSeam["verdict"] {
  if (duplicate) return "duplicate";
  return jump < SEAM_CONTINUOUS ? "continuous" : "cut";
}

/** The jump between the first and last of four grey pictures, and whether the render's loop check calls the last a duplicate of the first. */
export function judgeSeam(first: Uint8Array, second: Uint8Array, middle: Uint8Array, last: Uint8Array): { jump: number; duplicate: boolean } {
  return { jump: meanAbsDiff(first, last), duplicate: duplicateSeam(first, second, middle, last) !== null };
}

/** The picture of the PNG at `path` as grey pixels at the seam's size, scaled as `export/seam.ts` does. */
async function grey(ffmpeg: string, path: string, size: { width: number; height: number }): Promise<Uint8Array> {
  const { width, height } = seamPictureSize(size);
  for await (const frame of readRawFrames(ffmpeg, path, `scale=${width}:${height},format=gray`, width * height)) return frame;
  throw new Error(`ffmpeg decoded no picture from ${path}`);
}

/** The seam of a film of `size` px from the PNGs of its first, second, middle and last frame (the pictures `loopSeamWarning` compares). */
export async function seamOf(
  ffmpeg: string,
  paths: { first: string; second: string; middle: string; last: string },
  size: { width: number; height: number },
): Promise<{ jump: number; duplicate: boolean }> {
  const [first, second, middle, last] = await Promise.all([paths.first, paths.second, paths.middle, paths.last].map((path) => grey(ffmpeg, path, size)));
  return judgeSeam(first!, second!, middle!, last!);
}

/** The craft warning of a seam for a film meant to repeat: it holds a frame twice or jumps. */
export function seamWarnings(seam: ReviewSeam): ReviewFinding[] {
  if (seam.verdict === "continuous") return [];
  const message =
    seam.verdict === "duplicate"
      ? `the loop holds a frame twice at the seam: the last frame (${seam.last} s) repeats the first (difference ${seam.jump} of 255). End the last key one frame earlier, or trim one frame off the end.`
      : `the loop jumps at the seam: the last frame (${seam.last} s) differs from the first by ${seam.jump} of 255 (a hard cut reads 40 to 80, under ${SEAM_CONTINUOUS} reads as continuous). ` +
        "Let the last key return to the first, or fade across the seam.";
  return [{ check: "loop-seam", from: seam.last, to: seam.last, message }];
}
