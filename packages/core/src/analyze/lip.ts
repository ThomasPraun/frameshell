import type { AnalyzeSync } from "@frameshell/protocol";
import { frameDifference } from "../multicam/motion.js";
import { bestLag } from "./correlate.js";
import type { FaceTrack, TrackBox } from "../people/scan.js";

// Mouth against voice (#471): how far the picture of a talking face lags the sound. The mouth is read as the motion of
// the lower part of the face box a `people scan` cached (boxes only, twice a second: no landmarks are kept), the voice as the
// level of the sound; the offset is where the two correlate best. After HyperFrames' `measure` sync (Apache-2.0), ported per #478.

/** Most the mouth may be from the voice either way, seconds: a lip-sync error the eye accepts is far under it. */
export const SYNC_MAX_LAG_S = 0.5;
/** Shortest stretch of a face on screen, seconds, that gives an offset. */
export const SYNC_MIN_FACE_S = 3;
/** Pearson correlation under which mouth and voice are not said to follow each other. */
export const SYNC_MIN_CONFIDENCE = 0.2;
/** Width the frames the mouth is read from are scaled to, px: wide enough for a mouth of a face a third of the picture wide. */
export const MOUTH_VIEW_WIDTH = 192;
/** Quietest level, dBFS, the voice level is read at: below it the sound is silence. */
export const VOICE_FLOOR_DB = -60;
/** Share of a face box (from its bottom) the mouth is looked for in. */
const MOUTH_BOTTOM_SHARE = 0.4;
/** Share of a face box's width (centered) the mouth is looked for in. */
const MOUTH_WIDTH_SHARE = 0.7;

/** Size of the grey frames the mouth is read from, for a film `width` x `height`: even, so ffmpeg scales without a remainder. */
export function mouthViewSize(width: number, height: number): { width: number; height: number } {
  return { width: MOUTH_VIEW_WIDTH, height: Math.max(2, 2 * Math.round((MOUTH_VIEW_WIDTH * height) / width / 2)) };
}

/** The face track that is on screen longest, or null for none. */
export function longestTrack(tracks: readonly FaceTrack[]): FaceTrack | null {
  let best: FaceTrack | null = null;
  for (const track of tracks) if (best === null || track.end - track.start > best.end - best.start) best = track;
  return best;
}

/** The box of `track` nearest in time to `time`. At least one box. */
export function boxAt(track: FaceTrack, time: number): TrackBox {
  const boxes = track.boxes;
  let low = 0;
  let high = boxes.length - 1;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (boxes[mid]!.time < time) low = mid + 1;
    else high = mid;
  }
  const after = boxes[low]!;
  const before = boxes[Math.max(0, low - 1)]!;
  return Math.abs(before.time - time) <= Math.abs(after.time - time) ? before : after;
}

/** Pixels `[x0, x1) x [y0, y1)` of a `width` x `height` frame the mouth is looked for in, for `box`. Never empty. */
export function mouthPixels(box: TrackBox, width: number, height: number): { x0: number; x1: number; y0: number; y1: number } {
  const clamp = (value: number, max: number) => Math.min(max, Math.max(0, value));
  // The epsilon keeps a box edge that lands on a pixel border (0.36 x 100) from rounding to the next pixel.
  const x0 = clamp(Math.floor((box.x - (box.width * MOUTH_WIDTH_SHARE) / 2) * width + 1e-9), width - 1);
  const x1 = clamp(Math.ceil((box.x + (box.width * MOUTH_WIDTH_SHARE) / 2) * width - 1e-9), width);
  const y1 = clamp(Math.ceil((box.y + box.height / 2) * height - 1e-9), height);
  const y0 = clamp(Math.floor((box.y + box.height / 2 - box.height * MOUTH_BOTTOM_SHARE) * height + 1e-9), height - 1);
  return { x0, x1: Math.max(x0 + 1, x1), y0, y1: Math.max(y0 + 1, y1) };
}

/** Mean absolute grey change of the pixels of `area` between two frames `width` wide. */
function areaChange(previous: Uint8Array, current: Uint8Array, width: number, area: ReturnType<typeof mouthPixels>): number {
  let sum = 0;
  for (let y = area.y0; y < area.y1; y++) {
    const row = y * width;
    sum += frameDifference(previous.subarray(row + area.x0, row + area.x1), current.subarray(row + area.x0, row + area.x1)) * (area.x1 - area.x0);
  }
  return sum / ((area.x1 - area.x0) * (area.y1 - area.y0));
}

/**
 * Motion of the mouth of `track` in every frame of a film at `fps`: `motion[i]` is how much the mouth area changed between
 * frame `i - 1` and `i` (0 for the first and for a frame outside the track). `frames` are grey, `width` x `height`, one per
 * film frame in order. Throws when `signal` aborts.
 */
export async function mouthMotion(frames: AsyncIterable<Uint8Array>, size: { width: number; height: number }, fps: number, track: FaceTrack, count: number, signal?: AbortSignal): Promise<Float32Array> {
  const motion = new Float32Array(count);
  let previous: Uint8Array | undefined;
  let index = 0;
  for await (const frame of frames) {
    signal?.throwIfAborted();
    if (index >= count) break;
    const time = index / fps;
    if (previous && time >= track.start && time <= track.end) motion[index] = areaChange(previous, frame, size.width, mouthPixels(boxAt(track, time), size.width, size.height));
    previous = frame;
    index++;
  }
  return motion;
}

/** The level of the sound in each of `frames` frames of a film at `fps`: the mean of `db` (dBFS per `hop` seconds, from 0), floored at {@link VOICE_FLOOR_DB}. */
export function voiceLevel(db: ArrayLike<number>, hop: number, fps: number, frames: number): Float32Array {
  const level = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    const from = Math.floor((i / fps) / hop + 1e-9);
    const to = Math.max(from + 1, Math.floor(((i + 1) / fps) / hop + 1e-9));
    let sum = 0;
    let n = 0;
    for (let h = from; h < Math.min(to, db.length); h++) {
      sum += Math.max(VOICE_FLOOR_DB, db[h]!);
      n++;
    }
    level[i] = n > 0 ? sum / n : VOICE_FLOOR_DB;
  }
  return level;
}

/** The result of {@link syncOffset}. */
export interface SyncFound {
  /** Frames the mouth is after the voice (negative: before it). */
  lagFrames: number;
  /** Pearson correlation at that lag. */
  confidence: number;
}

/**
 * Where `mouth` and `voice` (one value per frame) line up best: the lag in frames, within `maxLag`, at which the mouth
 * motion `mouth[i]` follows the voice level `voice[i - lag]` most closely, over frames `[from, to)`. Null when either is flat there.
 * A lag of 3 means the mouth moves 3 frames after the voice.
 */
export function syncOffset(mouth: ArrayLike<number>, voice: ArrayLike<number>, maxLag: number, from: number, to: number): SyncFound | null {
  const range = { from, to };
  const best = bestLag(mouth, voice, maxLag, range, range);
  return best && { lagFrames: best.lag, confidence: best.correlation };
}

/** An {@link AnalyzeSync} that says why nothing was measured. */
export function skippedSync(reason: string, frames = 0): AnalyzeSync {
  return { offset: null, confidence: null, track: null, frames, reason };
}

/** The {@link AnalyzeSync} of a {@link SyncFound} at `fps` read from `track` over `frames` frames; skipped when the match is weaker than {@link SYNC_MIN_CONFIDENCE}. */
export function syncResult(found: SyncFound | null, fps: number, track: string, frames: number): AnalyzeSync {
  if (found === null) return skippedSync("mouth or voice does not change over the face's time on screen, so there is nothing to compare.", frames);
  const confidence = Math.round(Math.max(0, found.confidence) * 100) / 100;
  if (found.confidence < SYNC_MIN_CONFIDENCE) {
    return skippedSync(`mouth motion and voice do not follow each other (best match ${confidence}): the face is not the one talking, or music covers the voice.`, frames);
  }
  return { offset: Math.round((found.lagFrames * 1000) / fps) / 1000, confidence, track, frames, reason: null };
}
