import { readRawFrames } from "../media/raw-frames.js";
import { frameDifference } from "../multicam/motion.js";
import { MAX_PICTURE_S, pictureSize } from "./picture.js";

/**
 * Mean grey change between consecutive frames of the film, on the picture `readPicture` measures (a long side of 64 px):
 * `activity[i]` is the change from frame `i - 1` (0 for the first), in the units of the `activity` of `analyze`, read
 * without its look, cells and shots: for the films `analyze.diff` compares. Stops at {@link MAX_PICTURE_S}; `truncated` says so.
 */
export async function readActivity(
  ffmpeg: string,
  file: string,
  film: { width: number; height: number; fps: number; frames: number },
  signal?: AbortSignal,
  progress?: (fraction: number) => void,
): Promise<{ activity: Float32Array; truncated: boolean }> {
  const { width, height } = pictureSize(film.width, film.height);
  const wanted = Math.min(film.frames, Math.floor(MAX_PICTURE_S * film.fps + 1e-6));
  const activity = new Float32Array(wanted);
  const range = wanted < film.frames ? { from: 0, to: MAX_PICTURE_S } : undefined;
  let previous: Uint8Array | undefined;
  let index = 0;
  for await (const grey of readRawFrames(ffmpeg, file, `fps=${film.fps},scale=${width}:${height}:flags=area,format=gray`, width * height, range)) {
    signal?.throwIfAborted();
    if (index >= wanted) break;
    activity[index] = previous ? frameDifference(previous, grey) : 0;
    previous = grey;
    index++;
    if (index % 60 === 0) progress?.(index / wanted);
  }
  return { activity: activity.subarray(0, index), truncated: wanted < film.frames };
}
