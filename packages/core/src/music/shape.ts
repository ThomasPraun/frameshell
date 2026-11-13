import type { ShapeSettings } from "@frameshell/schema";
import { type DipPoint, dipAt } from "../media/duck.js";

/**
 * The arithmetic of `music.shape` (ADR 0037 slice 4): the dip curve the music follows around a hit and at its ending.
 * Pure: `shape-run.ts` finds the clip and resolves the times, the `music.shape` operation writes the keys.
 */

/** What a shaping uses when the call leaves a number out. */
export const SHAPE_DEFAULTS = { lead: 0.4, depth: 9, hold: 0.3, release: 0.6, fade: 2.5 } as const;

/** Seconds the step down itself takes, ending `lead` before the hit: a step, not a slow duck. */
export const SHAPE_STEP_S = 0.06;

/** dB below its level the music sits once its closing fade is over: inaudible, and a real gain key rather than silence. */
export const SHAPE_FLOOR_DB = 60;

/**
 * Dip over time: for each hit `d`, down by `depth` over {@link SHAPE_STEP_S} so it is complete `lead` before `d`, held
 * until `hold` after it, back over `release`; from `ending` a straight fade over `fade` that stays down to the end of the
 * clip (`clipEnd`). Where two shapes overlap the deeper one wins at each point. Times before 0 are cut to a ramp that
 * starts part way down, as the duck does. Sorted by time, 3 decimals.
 */
export function shapeCurve(values: ShapeSettings, clipEnd: number): DipPoint[] {
  const parts: DipPoint[][] = (values.drops ?? []).map((d) => [
    { time: d - values.lead - SHAPE_STEP_S, dip: 0 },
    { time: d - values.lead, dip: values.depth },
    { time: d + values.hold, dip: values.depth },
    { time: d + values.hold + values.release, dip: 0 },
  ]);
  const fadeEnd = values.ending === undefined ? undefined : values.ending + values.fade;
  const dipOf = (time: number): number => {
    let dip = 0;
    for (const part of parts) dip = Math.max(dip, dipAt(part, time));
    if (values.ending !== undefined && fadeEnd !== undefined && time > values.ending) {
      dip = Math.max(dip, time >= fadeEnd ? SHAPE_FLOOR_DB : (SHAPE_FLOOR_DB * (time - values.ending)) / values.fade);
    }
    return dip;
  };
  const times = new Set<number>(parts.flat().map((point) => point.time));
  if (values.ending !== undefined && fadeEnd !== undefined) {
    times.add(values.ending);
    times.add(fadeEnd);
    // Held to the end of the clip: the curve has to reach it, or the music would come back up there.
    times.add(Math.max(clipEnd, fadeEnd) + 1);
  }
  const sorted = [...times].sort((a, b) => a - b);
  const points = sorted.filter((time) => time >= 0).map((time) => ({ time, dip: dipOf(time) }));
  // The first point before 0 goes to 0 with the dip it has there.
  if (sorted.some((time) => time < 0) && !points.some((point) => point.time === 0)) points.unshift({ time: 0, dip: dipOf(0) });
  return points.map((point) => ({ time: Math.round(point.time * 1000) / 1000, dip: Math.round(point.dip * 10000) / 10000 }));
}
