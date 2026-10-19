import type { PaintedTurn } from "./timeline.js";

/** One painting gesture over the group clock; see {@link paintStretches}. */
export interface PaintChange {
  angle: string;
  /** Group-clock seconds. */
  start: number;
  /** Group-clock seconds, after `start`. */
  end: number;
  /** True: speaks. False: silent. Null: back to the measured turns. */
  speaking: boolean | null;
}

const ms = (seconds: number) => Math.round(seconds * 1000) / 1000;

/**
 * The painted stretches of a group after `change`: the part of the angle's stretches inside
 * `[start, end)` is replaced by the new one (or dropped, for `speaking: null`), the rest of
 * them and every other angle's stay. Touching stretches of the same kind merge. Sorted by
 * `order` (the group's angle ids), then start; angles not in `order` come last.
 */
export function paintStretches(painted: readonly PaintedTurn[], change: PaintChange, order: readonly string[]): PaintedTurn[] {
  const start = ms(change.start);
  const end = ms(change.end);
  const kept: PaintedTurn[] = [];
  for (const turn of painted) {
    if (turn.angle !== change.angle || turn.end <= start || turn.start >= end) {
      kept.push({ ...turn });
      continue;
    }
    if (turn.start < start) kept.push({ ...turn, end: start });
    if (turn.end > end) kept.push({ ...turn, start: end });
  }
  if (change.speaking !== null) kept.push({ angle: change.angle, start, end, speaking: change.speaking });
  const rank = (angle: string) => {
    const at = order.indexOf(angle);
    return at < 0 ? order.length : at;
  };
  kept.sort((a, b) => rank(a.angle) - rank(b.angle) || (a.angle < b.angle ? -1 : a.angle > b.angle ? 1 : 0) || a.start - b.start);
  const merged: PaintedTurn[] = [];
  for (const turn of kept) {
    const last = merged[merged.length - 1];
    if (last && last.angle === turn.angle && last.speaking === turn.speaking && last.end >= turn.start) last.end = Math.max(last.end, turn.end);
    else merged.push(turn);
  }
  return merged;
}
