import type { AnalyzeBurst, AnalyzeRhythm } from "@frameshell/protocol";
import { slidingMedians } from "./median.js";
import { type Cut, MIN_CUT_GAP_FRAMES, detectCuts, frameStart } from "./shots.js";

// Rhythm of a film: how steady its shots are, how much of it holds still and where changes pile up. Pure: `picture.ts`
// measures `activity`. After HyperFrames' `measure` (Apache-2.0), ported per #478. A big change is #457's visual event
// (4x its surroundings, or 15 % mean grey change), so the metrics of `review` for a film of ours share this scale.

/** Grey levels (0 to 255, on a 64 px wide picture) of mean change between two frames under which a frame counts as still. */
export const STILL_LEVEL = 0.5;
/** Share of the grey range (255) a frame's mean change must reach to be a big change by itself: #457's 15 %, about 38 levels. */
export const BIG_CHANGE_SHARE = 0.15;
/** Grey levels of mean change between two frames from which the picture made a big change whatever is around it. */
export const BIG_CHANGE_LEVEL = 255 * BIG_CHANGE_SHARE;
/** Times the median change of the frames around it a frame's change must reach to be a big change: #457's 4x. */
export const BIG_CHANGE_RATIO = 4;
/** Grey levels below which a change is never big, so noise in a still picture is not 4x of nothing: #457's floor for visual events. */
export const BIG_CHANGE_FLOOR = 1;
/** Seconds on each side of a frame whose changes are its surroundings. #457 does not say; half a second spans a gesture, not a shot. */
export const BIG_CHANGE_SURROUND_S = 0.5;
/** Big changes in {@link BURST_WINDOW_S} that make a burst. */
export const BURST_CHANGES = 3;
/** Seconds in which {@link BURST_CHANGES} big changes make a burst. */
export const BURST_WINDOW_S = 1.5;

/** Several big changes close together: the wire type, as `analyze` returns it. */
export type Burst = AnalyzeBurst;

/** How the film moves in time: the wire type, as `analyze` returns it. */
export type Rhythm = AnalyzeRhythm;

/** Population standard deviation over the mean of `lengths`; 0 for one value or none. */
export function lengthCv(lengths: readonly number[]): number {
  if (lengths.length < 2) return 0;
  const mean = lengths.reduce((sum, value) => sum + value, 0) / lengths.length;
  if (mean === 0) return 0;
  const variance = lengths.reduce((sum, value) => sum + (value - mean) ** 2, 0) / lengths.length;
  return Math.round((Math.sqrt(variance) / mean) * 1000) / 1000;
}

/**
 * Frames where the picture made a big change: a frame whose `activity` is at least {@link BIG_CHANGE_LEVEL}, or at least
 * {@link BIG_CHANGE_FLOOR} and {@link BIG_CHANGE_RATIO} times the median of the frames within {@link BIG_CHANGE_SURROUND_S}
 * of it (a run within {@link MIN_CUT_GAP_FRAMES} frames counts once, as its strongest), and every one of `cutFrames`,
 * which always count.
 */
export function bigChanges(activity: ArrayLike<number>, cutFrames: readonly number[], fps: number): Cut[] {
  const around = slidingMedians(activity, Math.max(1, Math.round(BIG_CHANGE_SURROUND_S * fps)));
  const candidates: Cut[] = [];
  for (let frame = 1; frame < activity.length; frame++) {
    const score = activity[frame]!;
    if (score >= BIG_CHANGE_LEVEL || (score >= BIG_CHANGE_FLOOR && score >= BIG_CHANGE_RATIO * around[frame]!)) candidates.push({ frame, score });
  }
  const out = detectCuts(candidates, 0);
  for (const frame of cutFrames) {
    if (frame <= 0 || frame >= activity.length) continue;
    if (!out.some((change) => Math.abs(change.frame - frame) < MIN_CUT_GAP_FRAMES)) out.push({ frame, score: activity[frame]! });
  }
  return out.sort((a, b) => a.frame - b.frame);
}

/** Stretches of at least `minFrames` still frames: `[startFrame, endFrame)`, the first frame of the held picture included. */
export function stillRuns(activity: ArrayLike<number>, minFrames: number): { startFrame: number; endFrame: number }[] {
  const runs: { startFrame: number; endFrame: number }[] = [];
  let first = -1;
  for (let i = 1; i <= activity.length; i++) {
    const still = i < activity.length && activity[i]! < STILL_LEVEL;
    if (still && first < 0) first = i;
    if (!still && first >= 0) {
      // Frame `first - 1` is the picture that holds; `i - 1` the last frame that equals it.
      if (i - (first - 1) >= minFrames) runs.push({ startFrame: first - 1, endFrame: i });
      first = -1;
    }
  }
  return runs;
}

/** Bursts among the big `changes` of a film at `fps`: {@link BURST_CHANGES} or more within {@link BURST_WINDOW_S}, overlapping windows joined. */
export function bursts(changes: readonly Cut[], fps: number): Burst[] {
  const window = Math.round(BURST_WINDOW_S * fps);
  const spans: { first: number; last: number }[] = [];
  for (let i = 0; i < changes.length; i++) {
    let last = i;
    while (last + 1 < changes.length && changes[last + 1]!.frame < changes[i]!.frame + window) last++;
    if (last - i + 1 < BURST_CHANGES) continue;
    const previous = spans.at(-1);
    if (previous && changes[i]!.frame < changes[previous.last]!.frame + window) previous.last = Math.max(previous.last, last);
    else spans.push({ first: i, last });
  }
  return spans.map(({ first, last }) => {
    const startFrame = changes[first]!.frame;
    const endFrame = changes[last]!.frame + 1;
    return { startFrame, endFrame, start: frameStart(startFrame, fps), end: frameStart(endFrame, fps), count: last - first + 1 };
  });
}

/**
 * The rhythm of a film at `fps` from `activity[i]` (mean grey change between frame `i - 1` and frame `i`, 0 for the
 * first), the lengths in frames of its shots and the frames its shots start at; with the big changes it counted.
 */
export function rhythmOf(activity: ArrayLike<number>, fps: number, shotLengths: readonly number[], cutFrames: readonly number[]): { rhythm: Rhythm; changes: Cut[] } {
  const frames = activity.length;
  let still = 0;
  let total = 0;
  for (let i = 1; i < frames; i++) {
    if (activity[i]! < STILL_LEVEL) still++;
    total += activity[i]!;
  }
  const longest = stillRuns(activity, 1).reduce((most, run) => Math.max(most, run.endFrame - run.startFrame), 0);
  const changes = bigChanges(activity, cutFrames, fps);
  const marks = [0, ...changes.map((change) => change.frame), frames];
  let gap = 0;
  for (let i = 1; i < marks.length; i++) gap = Math.max(gap, marks[i]! - marks[i - 1]!);
  const minutes = frames / fps / 60;
  const rhythm: Rhythm = {
    shotLengthCv: lengthCv(shotLengths),
    stillShare: frames > 1 ? Math.round((still / (frames - 1)) * 1000) / 1000 : 0,
    longestStill: frameStart(longest, fps),
    changeCount: changes.length,
    changesPerMinute: minutes > 0 ? Math.round((changes.length / minutes) * 100) / 100 : 0,
    largestGap: frameStart(gap, fps),
    meanActivity: frames > 1 ? Math.round((total / (frames - 1)) * 100) / 100 : 0,
    bursts: bursts(changes, fps),
  };
  return { rhythm, changes };
}
