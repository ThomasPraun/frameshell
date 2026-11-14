import type { AnalyzeInk } from "@frameshell/protocol";
import { CELLS, type PictureSeries } from "./events.js";
import { LOOK_COLUMNS, LOOK_ROWS } from "./look.js";
import { frameStart } from "./shots.js";

// How much of the picture graphics and text cover. Pure: `picture.ts` measures the per-cell detail. After HyperFrames'
// `measure` ink (Apache-2.0), ported per #478, but on the 8 x 6 grid of the picture pass, not a pixel box: what it finds
// is the share of grid cells and the box of cells, not the size of a letter.

/** Detail (sum of the grey steps to the pixel on the right and below, mean per pixel) a cell must gain over its quiet level to hold ink. */
export const INK_RISE = 8;
/** Which of the shot's frames a cell's quiet level is read at: the 20th percentile of its detail, so ink on screen for less than 80 % of the shot is not part of it. */
export const INK_QUIET_PERCENTILE = 0.2;
/** Fewest frames a shot needs for a quiet level to mean anything. */
export const INK_MIN_FRAMES = 6;

/** Ink of a stretch of the film with none. */
const NO_INK: AnalyzeInk = { mean: 0, peak: 0, peakAt: null, region: null };

const round3 = (value: number) => Math.round(value * 1000) / 1000;

/** What one stretch of frames holds: the inks of its frames, before they are averaged. */
interface Stretch {
  ink: AnalyzeInk;
  frames: number;
}

/** The ink of frames `[from, to)` of `series`; its quiet level is read from those frames alone. */
function stretchInk(series: Pick<PictureSeries, "cellDetail">, from: number, to: number, fps: number): Stretch {
  const frames = to - from;
  if (frames < INK_MIN_FRAMES) return { ink: NO_INK, frames: Math.max(0, frames) };
  const quiet = new Float32Array(CELLS);
  const column = new Float32Array(frames);
  for (let cell = 0; cell < CELLS; cell++) {
    for (let i = 0; i < frames; i++) column[i] = series.cellDetail[(from + i) * CELLS + cell]!;
    quiet[cell] = column.slice().sort()[Math.floor((frames - 1) * INK_QUIET_PERCENTILE)]!;
  }
  let sum = 0;
  let peak = 0;
  let peakFrame = -1;
  for (let i = 0; i < frames; i++) {
    let covered = 0;
    for (let cell = 0; cell < CELLS; cell++) if (series.cellDetail[(from + i) * CELLS + cell]! - quiet[cell]! >= INK_RISE) covered++;
    sum += covered;
    if (covered > peak) {
      peak = covered;
      peakFrame = from + i;
    }
  }
  if (peakFrame < 0) return { ink: NO_INK, frames };
  let left: number = LOOK_COLUMNS;
  let right = -1;
  let top: number = LOOK_ROWS;
  let bottom = -1;
  for (let cell = 0; cell < CELLS; cell++) {
    if (series.cellDetail[peakFrame * CELLS + cell]! - quiet[cell]! < INK_RISE) continue;
    const [x, y] = [cell % LOOK_COLUMNS, Math.floor(cell / LOOK_COLUMNS)];
    [left, right, top, bottom] = [Math.min(left, x), Math.max(right, x), Math.min(top, y), Math.max(bottom, y)];
  }
  return {
    ink: {
      mean: round3(sum / frames / CELLS),
      peak: round3(peak / CELLS),
      peakAt: frameStart(peakFrame, fps),
      region: { x: round3(left / LOOK_COLUMNS), y: round3(top / LOOK_ROWS), width: round3((right - left + 1) / LOOK_COLUMNS), height: round3((bottom - top + 1) / LOOK_ROWS) },
    },
    frames,
  };
}

/**
 * Ink of each of `shots` (frames `[startFrame, endFrame)`, cut at the frames measured) and of the whole film: the share of the
 * grid cells whose detail is at least {@link INK_RISE} above their quiet level in the shot. Text and graphics that stay on a
 * whole shot are its quiet level, so not found; a talking head's moving detail is. An estimate: look at `peakAt`.
 */
export function inkOf(series: Pick<PictureSeries, "frames" | "cellDetail">, shots: readonly { startFrame: number; endFrame: number }[], fps: number): { film: AnalyzeInk; shots: AnalyzeInk[] } {
  const stretches = shots.map((shot) => stretchInk(series, Math.min(shot.startFrame, series.frames), Math.min(shot.endFrame, series.frames), fps));
  const measured = stretches.reduce((sum, stretch) => sum + stretch.frames, 0);
  let leader: AnalyzeInk = NO_INK;
  let weighted = 0;
  for (const { ink, frames } of stretches) {
    weighted += ink.mean * frames;
    if (ink.peak > leader.peak) leader = ink;
  }
  return { film: { ...leader, mean: measured > 0 ? round3(weighted / measured) : 0 }, shots: stretches.map((stretch) => stretch.ink) };
}
