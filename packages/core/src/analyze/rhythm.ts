import { type Cut, MIN_CUT_GAP_FRAMES, detectCuts, frameStart } from "./shots.js";

// Rhythm of a film: how steady its shots are, how much of it holds still and where changes pile up. Pure: `picture.ts`
// measures `activity`. The metrics of `review` (#457) for a film of ours are to use these constants, so both share one scale.

/** Grey levels (0 to 255, on a 64 px wide picture) of mean change between two frames under which a frame counts as still. */
export const STILL_LEVEL = 0.5;
/** Grey levels of mean change between two frames from which the picture made a big change: a cut, a flash or a layout that jumps. */
export const BIG_CHANGE_LEVEL = 6;
/** Big changes in {@link BURST_WINDOW_S} that make a burst. */
export const BURST_CHANGES = 3;
/** Seconds in which {@link BURST_CHANGES} big changes make a burst. */
export const BURST_WINDOW_S = 1.5;

/** Several big changes close together. */
export interface Burst {
  startFrame: number;
  /** The frame after the last change of the burst. */
  endFrame: number;
  start: number;
  end: number;
  /** Big changes inside. */
  count: number;
}

/** How the film moves in time. */
export interface Rhythm {
  /** Spread of the shot lengths: their standard deviation over their mean, 3 decimals. 0 is a metronome; above 0.6 the cutting is irregular. */
  shotLengthCv: number;
  /** Share of the frames (after the first) that are still: 0 to 1, 3 decimals. */
  stillShare: number;
  /** Longest hold of the picture, seconds. */
  longestStill: number;
  /** Big changes: cuts, flashes, jumps of the layout. */
  changeCount: number;
  /** `changeCount` per minute of film, 2 decimals. */
  changesPerMinute: number;
  /** Longest stretch between two big changes (or the film's ends), seconds. */
  largestGap: number;
  /** Mean change between frames, grey levels, 2 decimals. */
  meanActivity: number;
  bursts: Burst[];
}

/** Population standard deviation over the mean of `lengths`; 0 for one value or none. */
export function lengthCv(lengths: readonly number[]): number {
  if (lengths.length < 2) return 0;
  const mean = lengths.reduce((sum, value) => sum + value, 0) / lengths.length;
  if (mean === 0) return 0;
  const variance = lengths.reduce((sum, value) => sum + (value - mean) ** 2, 0) / lengths.length;
  return Math.round((Math.sqrt(variance) / mean) * 1000) / 1000;
}

/**
 * Frames where the picture made a big change: peaks of `activity` at or above {@link BIG_CHANGE_LEVEL} (a run within
 * {@link MIN_CUT_GAP_FRAMES} frames counts once, as its strongest) and every one of `cutFrames`, which always count.
 */
export function bigChanges(activity: ArrayLike<number>, cutFrames: readonly number[]): Cut[] {
  const scores = Array.from({ length: activity.length }, (_, frame) => ({ frame, score: activity[frame]! }));
  const out = detectCuts(scores, BIG_CHANGE_LEVEL);
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
 * first), the lengths in frames of its shots and the frames its shots start at.
 */
export function rhythmOf(activity: ArrayLike<number>, fps: number, shotLengths: readonly number[], cutFrames: readonly number[]): Rhythm {
  const frames = activity.length;
  let still = 0;
  let total = 0;
  for (let i = 1; i < frames; i++) {
    if (activity[i]! < STILL_LEVEL) still++;
    total += activity[i]!;
  }
  const longest = stillRuns(activity, 1).reduce((most, run) => Math.max(most, run.endFrame - run.startFrame), 0);
  const changes = bigChanges(activity, cutFrames);
  const marks = [0, ...changes.map((change) => change.frame), frames];
  let gap = 0;
  for (let i = 1; i < marks.length; i++) gap = Math.max(gap, marks[i]! - marks[i - 1]!);
  const minutes = frames / fps / 60;
  return {
    shotLengthCv: lengthCv(shotLengths),
    stillShare: frames > 1 ? Math.round((still / (frames - 1)) * 1000) / 1000 : 0,
    longestStill: frameStart(longest, fps),
    changeCount: changes.length,
    changesPerMinute: minutes > 0 ? Math.round((changes.length / minutes) * 100) / 100 : 0,
    largestGap: frameStart(gap, fps),
    meanActivity: frames > 1 ? Math.round((total / (frames - 1)) * 100) / 100 : 0,
    bursts: bursts(changes, fps),
  };
}
