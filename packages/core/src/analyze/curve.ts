import type { AnalyzeCurve, AnalyzeMove } from "@frameshell/protocol";
import { STILL_LEVEL } from "./rhythm.js";
import { frameStart } from "./shots.js";

// How much the picture changes over time, and the steady moves in it. Pure: `picture.ts` measures `activity`.
// The ease fit compares a move's speed profile with the standard ease curves (cubic), after HyperFrames' `measure` curve
// (Apache-2.0), ported per #478. The change between frames has no sign, so a move's direction and any overshoot are not found.

/** Most values the curve holds: a longer film gets a longer step. */
export const CURVE_MAX_VALUES = 1200;
/** Shortest step of the curve, seconds. */
export const CURVE_MIN_STEP_S = 0.1;
/** Grey levels (64 px wide picture) of change between two frames from which a frame is in motion: what is not a still frame. */
export const MOVE_LEVEL = STILL_LEVEL;
/** Frames below {@link MOVE_LEVEL} that still belong to one move. */
export const MOVE_GAP_FRAMES = 2;
/** Fewest frames of a move. */
export const MOVE_MIN_FRAMES = 3;
/** Fewest frames a move needs for its ease to be fitted. */
export const EASE_MIN_FRAMES = 4;
/** Longest move whose ease is fitted, seconds: longer is camera work or a subject walking, not an animated move. */
export const EASE_MAX_S = 3;
/** Most moves listed. */
export const MAX_MOVES = 200;
/** Points a move's speed is resampled to before it is compared with an ease. */
const PROFILE_POINTS = 16;

type Ease = NonNullable<AnalyzeMove["ease"]>;

/** Speed of each ease at progress `t` of the move (0 to 1), as a multiple of the mean speed: the derivative of the cubic ease. */
const SPEED: Record<Ease, (t: number) => number> = {
  linear: () => 1,
  in: (t) => 3 * t * t,
  out: (t) => 3 * (1 - t) * (1 - t),
  inOut: (t) => (t < 0.5 ? 12 * t * t : 12 * (1 - t) * (1 - t)),
};

const round = (value: number, digits: number) => Math.round(value * 10 ** digits) / 10 ** digits;

/** Seconds each value of the curve of a film of `duration` seconds covers. */
export function curveStep(duration: number): number {
  return Math.max(CURVE_MIN_STEP_S, Math.ceil((duration / CURVE_MAX_VALUES) * 10 - 1e-9) / 10);
}

/**
 * The ease whose speed profile is closest to `speeds` (one value per frame of a move, at least {@link EASE_MIN_FRAMES}):
 * the profile is resampled to {@link PROFILE_POINTS}, scaled to a mean of 1 and compared by root-mean-square gap.
 * Null for a move that does not move.
 */
export function closestEase(speeds: ArrayLike<number>): { ease: Ease; fit: number } | null {
  const profile: number[] = [];
  for (let k = 0; k < PROFILE_POINTS; k++) {
    const lo = Math.floor((k * speeds.length) / PROFILE_POINTS);
    const hi = Math.max(lo + 1, Math.floor(((k + 1) * speeds.length) / PROFILE_POINTS));
    let sum = 0;
    for (let i = lo; i < hi; i++) sum += speeds[i]!;
    profile.push(sum / (hi - lo));
  }
  const mean = profile.reduce((a, b) => a + b, 0) / PROFILE_POINTS;
  if (mean <= 0) return null;
  let best: { ease: Ease; fit: number } | null = null;
  for (const ease of Object.keys(SPEED) as Ease[]) {
    let squares = 0;
    for (let k = 0; k < PROFILE_POINTS; k++) squares += (profile[k]! / mean - SPEED[ease]((k + 0.5) / PROFILE_POINTS)) ** 2;
    const fit = Math.sqrt(squares / PROFILE_POINTS);
    if (best === null || fit < best.fit) best = { ease, fit };
  }
  return best && { ease: best.ease, fit: round(best.fit, 3) };
}

/**
 * Stretches of steady motion: runs of frames whose change is at least {@link MOVE_LEVEL} (gaps of up to
 * {@link MOVE_GAP_FRAMES} frames join), at least {@link MOVE_MIN_FRAMES} long, not counting the frames of `breaks` (the big
 * changes: a cut or a flash is not a move, and ends the one around it).
 */
export function movesOf(activity: ArrayLike<number>, fps: number, breaks: readonly number[]): AnalyzeMove[] {
  const frames = activity.length;
  const broken = new Set(breaks);
  const level = (i: number) => (broken.has(i) ? 0 : activity[i]!);
  const moves: AnalyzeMove[] = [];
  const longest = Math.floor(EASE_MAX_S * fps + 1e-6);
  const close = (first: number, last: number) => {
    const length = last - first + 1;
    if (length < MOVE_MIN_FRAMES) return;
    let peakFrame = first;
    for (let i = first; i <= last; i++) if (level(i) > level(peakFrame)) peakFrame = i;
    const fitted = length >= EASE_MIN_FRAMES && length <= longest ? closestEase(Array.from({ length }, (_, k) => level(first + k))) : null;
    moves.push({
      startFrame: first,
      endFrame: last + 1,
      start: frameStart(first, fps),
      end: frameStart(last + 1, fps),
      duration: frameStart(length, fps),
      peak: round(level(peakFrame), 2),
      peakAt: frameStart(peakFrame, fps),
      ease: fitted?.ease ?? null,
      fit: fitted?.fit ?? null,
    });
  };
  let first = -1;
  let last = -1;
  for (let i = 1; i < frames; i++) {
    if (broken.has(i)) {
      if (first >= 0) close(first, last);
      first = -1;
      continue;
    }
    if (level(i) < MOVE_LEVEL) continue;
    if (first >= 0 && i - last - 1 > MOVE_GAP_FRAMES) {
      close(first, last);
      first = -1;
    }
    if (first < 0) first = i;
    last = i;
  }
  if (first >= 0) close(first, last);
  return moves;
}

/**
 * The activity curve of a film at `fps` from `activity[i]` (mean grey change between frame `i - 1` and frame `i`, 0 for the
 * first): values every {@link curveStep}, the film's mean and largest change, and its moves between the big changes at `breaks`.
 */
export function curveOf(activity: ArrayLike<number>, fps: number, breaks: readonly number[]): { curve: AnalyzeCurve; truncated: boolean } {
  const frames = activity.length;
  const step = curveStep(frames / fps);
  const bins = Math.max(1, Math.ceil((frames / fps) / step - 1e-9));
  const sums = new Float64Array(bins);
  const counts = new Float64Array(bins);
  let total = 0;
  let peakFrame = 0;
  for (let i = 0; i < frames; i++) {
    const bin = Math.min(bins - 1, Math.floor(i / fps / step + 1e-9));
    sums[bin] = sums[bin]! + activity[i]!;
    counts[bin] = counts[bin]! + 1;
    total += activity[i]!;
    if (activity[i]! > activity[peakFrame]!) peakFrame = i;
  }
  const all = movesOf(activity, fps, breaks);
  return {
    curve: {
      step,
      values: Array.from(sums, (sum, bin) => round(sum / Math.max(1, counts[bin]!), 2)),
      mean: frames > 0 ? round(total / frames, 2) : 0,
      peak: frames > 0 ? round(activity[peakFrame]!, 2) : 0,
      peakAt: frameStart(peakFrame, fps),
      moves: all.slice(0, MAX_MOVES),
    },
    truncated: all.length > MAX_MOVES,
  };
}
