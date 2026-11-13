import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { runTool } from "../media/ffmpeg.js";

/** Width the frames of a seam check are compared at, px (ADR 0039). */
const SEAM_WIDTH = 160;
/** Mean absolute luma difference (0 to 255) below which two frames are the same picture, compression noise included. */
export const DUPLICATE_DIFF = 0.5;
/** Mean luma difference from frame 0 that proves the picture moves somewhere in the file: a held title is no defect. */
export const MOTION_DIFF = 2;
/** A loop of fewer frames has no middle to compare. */
const MIN_FRAMES = 3;

/** Mean absolute difference of two equal-length gray pictures, 0 to 255. */
export function meanAbsDiff(a: Uint8Array, b: Uint8Array): number {
  let sum = 0;
  for (let index = 0; index < a.length; index++) sum += Math.abs(a[index]! - b[index]!);
  return a.length === 0 ? 0 : sum / a.length;
}

/**
 * Judge the seam of a loop from four gray pictures: frame 0, frame 1, the middle frame and the last frame. The last
 * repeats frame 0 when they differ by less than {@link DUPLICATE_DIFF} while the picture moves elsewhere (a file that
 * never moves has no seam to check). Returns the difference when it does, else null.
 */
export function duplicateSeam(first: Uint8Array, second: Uint8Array, middle: Uint8Array, last: Uint8Array): number | null {
  const seam = meanAbsDiff(first, last);
  if (seam >= DUPLICATE_DIFF) return null;
  const motion = Math.max(meanAbsDiff(first, second), meanAbsDiff(first, middle));
  return motion >= MOTION_DIFF ? seam : null;
}

/**
 * Decode frame 0, frame 1, the middle and the last frame of the `frames` of the rendered `file` at {@link SEAM_WIDTH} px
 * and warn when the last repeats frame 0: played in a loop the picture would hold for two frames at the seam. The
 * message names the frame and the fix; the file and the timeline stay as they are (ADR 0039). Null when the seam is
 * fine, the file is too short to judge or the decoded frames are not the {@link frames} counted. `size` is the file's
 * width and height in px. `work` is a directory to create for the scratch picture, removed afterwards.
 */
export async function loopSeamWarning(
  ffmpeg: string,
  file: string,
  frames: number,
  size: { width: number; height: number },
  work: string,
  signal?: AbortSignal,
): Promise<string | null> {
  if (frames < MIN_FRAMES || size.width < 1 || size.height < 1) return null;
  const height = Math.max(2, 2 * Math.round((size.height * SEAM_WIDTH) / (size.width * 2)));
  const last = frames - 1;
  const wanted = [...new Set([0, 1, Math.floor(frames / 2), last])];
  const raw = join(work, "seam.gray");
  await mkdir(work, { recursive: true });
  try {
    const select = wanted.map((frame) => `eq(n\\,${frame})`).join("+");
    await runTool(
      ffmpeg,
      [
        ...["-hide_banner", "-nostdin", "-loglevel", "error", "-y", "-i", file],
        ...["-vf", `select=${select},scale=${SEAM_WIDTH}:${height},format=gray`, "-fps_mode", "passthrough", "-an", "-f", "rawvideo", raw],
      ],
      signal ? { signal } : {},
    );
    const bytes = await readFile(raw);
    // A decoder that returned another frame count (an edit list, a dropped last frame) would misalign every picture.
    const pixels = SEAM_WIDTH * height;
    if (bytes.length !== pixels * wanted.length) return null;
    const picture = (index: number) => bytes.subarray(index * pixels, (index + 1) * pixels);
    const at = (frame: number) => picture(wanted.indexOf(frame));
    const difference = duplicateSeam(at(0), at(1), at(Math.floor(frames / 2)), at(last));
    if (difference === null) return null;
    return (
      `Loop: the last frame (${last}) repeats frame 0 (difference ${difference.toFixed(2)} of 255 at ${SEAM_WIDTH} px), so the picture holds for two frames at the seam. ` +
      "End the last key one frame earlier, or trim one frame off the end of the timeline."
    );
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
