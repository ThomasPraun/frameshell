import type { ReviewSpeedSpan } from "@frameshell/protocol";
import { SPEED_LINEAR_FRAMES, SPEED_LINEAR_SHARE, SPEED_LINEAR_SPREAD, SPEED_STOP_FRAMES, SPEED_STOP_PX } from "./thresholds.js";

// The speed graph of `review --speed` (#457). Pure: hero-point samples in, the speed between them and the stretches
// that read mechanical (a constant speed: no ease; a dead stop mid-move) out. Frames are timeline frame indexes.

/** Where a clip's hero point is at one timeline frame: film px. */
export interface HeroSample {
  frame: number;
  x: number;
  y: number;
  /** Square root of the area the hero covers, film px: a size that grows and shrinks with scale. */
  size: number;
}

/** The speed between two samples, the same over every frame of `[from, to)`. */
export interface SpeedInterval {
  from: number;
  to: number;
  /** Film px per frame: the centre's travel plus half the change of the size (how far an edge moves on a pure zoom). */
  speed: number;
}

/** The speed between each pair of consecutive `samples` (in frame order, distinct frames), per frame. */
export function speedOf(samples: readonly HeroSample[]): SpeedInterval[] {
  const intervals: SpeedInterval[] = [];
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1]!;
    const b = samples[i]!;
    const frames = b.frame - a.frame;
    if (frames <= 0) continue;
    const travel = Math.hypot(b.x - a.x, b.y - a.y) + Math.abs(b.size - a.size) / 2;
    intervals.push({ from: a.frame, to: b.frame, speed: travel / frames });
  }
  return intervals;
}

/** The thresholds {@link spansOf} judges by; the defaults are review's (`thresholds.ts`). */
export interface SpeedThresholds {
  linearSpread: number;
  linearFrames: number;
  linearShare: number;
  stopPx: number;
  stopFrames: number;
}

/** Review's {@link SpeedThresholds}. */
export const SPEED_THRESHOLDS: SpeedThresholds = {
  linearSpread: SPEED_LINEAR_SPREAD,
  linearFrames: SPEED_LINEAR_FRAMES,
  linearShare: SPEED_LINEAR_SHARE,
  stopPx: SPEED_STOP_PX,
  stopFrames: SPEED_STOP_FRAMES,
};

/** A {@link ReviewSpeedSpan} in frames. */
export interface FrameSpan {
  from: number;
  to: number;
  kind: ReviewSpeedSpan["kind"];
  speed: number;
}

/**
 * The stretches of a move that read mechanical. The move runs from the first to the last interval at or above
 * `stopPx`. `stop`: intervals under it, `stopFrames` or more, between two moving ones. `linear`: moving intervals whose
 * speed stays within `linearSpread` (fastest minus slowest over the mean) over `linearFrames` frames or more and
 * `linearShare` of the move or more; found greedily left to right, each as long as it holds, never overlapping.
 */
export function spansOf(intervals: readonly SpeedInterval[], thresholds: SpeedThresholds = SPEED_THRESHOLDS): FrameSpan[] {
  const moving = (interval: SpeedInterval) => interval.speed >= thresholds.stopPx;
  const first = intervals.findIndex(moving);
  if (first < 0) return [];
  let last = intervals.length - 1;
  while (!moving(intervals[last]!)) last--;
  const moveFrames = intervals[last]!.to - intervals[first]!.from;
  const minLinear = Math.max(thresholds.linearFrames, thresholds.linearShare * moveFrames);
  const spans: FrameSpan[] = [];
  // Travel up to each interval, so the mean speed of any run is one subtraction.
  const travelTo = [0];
  for (const interval of intervals) travelTo.push(travelTo.at(-1)! + interval.speed * (interval.to - interval.from));
  const mean = (from: number, to: number) => (travelTo[to + 1]! - travelTo[from]!) / (intervals[to]!.to - intervals[from]!.from);

  // Dead stops: runs of still intervals inside the move.
  for (let i = first; i <= last; ) {
    if (moving(intervals[i]!)) {
      i++;
      continue;
    }
    let j = i;
    while (j + 1 <= last && !moving(intervals[j + 1]!)) j++;
    if (intervals[j]!.to - intervals[i]!.from >= thresholds.stopFrames) spans.push({ from: intervals[i]!.from, to: intervals[j]!.to, kind: "stop", speed: mean(i, j) });
    i = j + 1;
  }

  // Linear stretches: from each moving interval, grow while the speed holds; a long enough run is taken and the search
  // goes on after it, a short one moves the start by one interval.
  for (let i = first; i <= last; ) {
    if (!moving(intervals[i]!)) {
      i++;
      continue;
    }
    let low = intervals[i]!.speed;
    let high = low;
    let j = i;
    while (j + 1 <= last && moving(intervals[j + 1]!)) {
      const nextLow = Math.min(low, intervals[j + 1]!.speed);
      const nextHigh = Math.max(high, intervals[j + 1]!.speed);
      if ((nextHigh - nextLow) / mean(i, j + 1) >= thresholds.linearSpread) break;
      low = nextLow;
      high = nextHigh;
      j++;
    }
    if (intervals[j]!.to - intervals[i]!.from >= minLinear) {
      spans.push({ from: intervals[i]!.from, to: intervals[j]!.to, kind: "linear", speed: mean(i, j) });
      i = j + 1;
    } else i++;
  }
  return spans.sort((a, b) => a.from - b.from || a.to - b.to);
}
