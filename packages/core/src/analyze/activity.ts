import { readRawFrames } from "../media/raw-frames.js";
import { frameDifference } from "../multicam/motion.js";
import { MAX_PICTURE_S, pictureSize } from "./picture.js";

/** Standard deviation of the grey levels of `frame`: 0 for a flat picture, up to 128. */
export function lumaSpread(frame: Uint8Array): number {
  let sum = 0;
  let squares = 0;
  for (const value of frame) {
    sum += value;
    squares += value * value;
  }
  const mean = sum / frame.length;
  return Math.sqrt(Math.max(0, squares / frame.length - mean * mean));
}

/** What {@link readActivity} read: `activity[i]` and `spread[i]` belong to frame `first + i` of the film. */
export interface ActivityRead {
  activity: Float32Array;
  /** {@link lumaSpread} of each frame read. */
  spread: Float32Array;
  /** The frames asked for went on past {@link MAX_PICTURE_S} and were not read there. */
  truncated: boolean;
}

/**
 * Mean grey change between consecutive frames of the film, on the picture `readPicture` measures (a long side of 64 px):
 * `activity[i]` is the change from frame `i - 1` (0 for the first), in the units of the `activity` of `analyze`, read
 * without its look, cells and shots: for the films `analyze.diff` compares and the files `review` measures. `frames`
 * limits it to frames `first` to `end - 1`. Stops at {@link MAX_PICTURE_S}; `truncated` says so.
 */
export async function readActivity(
  ffmpeg: string,
  file: string,
  film: { width: number; height: number; fps: number; frames: number },
  signal?: AbortSignal,
  progress?: (fraction: number) => void,
  frames?: { first: number; end: number },
): Promise<ActivityRead> {
  const { width, height } = pictureSize(film.width, film.height);
  const first = frames?.first ?? 0;
  const limit = Math.floor(MAX_PICTURE_S * film.fps + 1e-6);
  const asked = Math.min(frames?.end ?? film.frames, film.frames);
  const last = Math.min(asked, limit);
  const wanted = Math.max(0, last - first);
  const activity = new Float32Array(wanted);
  const spread = new Float32Array(wanted);
  const range = first > 0 || last < film.frames ? { from: first / film.fps, to: last / film.fps } : undefined;
  let previous: Uint8Array | undefined;
  let index = 0;
  for await (const grey of readRawFrames(ffmpeg, file, `fps=${film.fps},scale=${width}:${height}:flags=area,format=gray`, width * height, range)) {
    signal?.throwIfAborted();
    if (index >= wanted) break;
    activity[index] = previous ? frameDifference(previous, grey) : 0;
    spread[index] = lumaSpread(grey);
    previous = grey;
    index++;
    if (index % 60 === 0) progress?.(index / wanted);
  }
  return { activity: activity.subarray(0, index), spread: spread.subarray(0, index), truncated: last < asked };
}
