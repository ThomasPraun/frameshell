import type { AnalyzeDiffEnergy, AnalyzeDiffSample, AnalyzeDiffWindow } from "@frameshell/protocol";
import { bestLag, correlationAtLag } from "./correlate.js";

// Two films lined up in time, and their activity and SSIM compared at matching moments. Pure: `diff.ts` reads the films.
// By activity-curve alignment, not a pass or fail (#471, third pass of the #451 research): a film in the style of a reference
// moves where it moves, so the two curves match without the frames being alike.

/** Samples per second the activity of both films is resampled to before they are correlated; also the resolution of the lag, 50 ms. */
export const ALIGN_HZ = 20;
/** Default most the search looks for the lag either way, seconds. */
export const DEFAULT_MAX_LAG_S = 3;
/** Fewest seconds of the two films that must overlap at a lag for it to be tried. */
export const ALIGN_MIN_OVERLAP_S = 2;
/** Pearson correlation under which the two activity curves are not said to match: the lag is then 0. */
export const ALIGN_MIN_CORRELATION = 0.3;
/** Most windows of the energy listing. */
export const MAX_WINDOWS = 600;

const round = (value: number, digits: number) => Math.round(value * 10 ** digits) / 10 ** digits;

/** Mean activity of the frames of each `1 / hz` second of a film at `fps` (a bin with no frame holds the last one's). */
export function activityGrid(activity: ArrayLike<number>, fps: number, hz = ALIGN_HZ): Float64Array {
  const bins = Math.max(1, Math.ceil(activity.length / fps * hz - 1e-9));
  const sums = new Float64Array(bins);
  const counts = new Float64Array(bins);
  for (let i = 0; i < activity.length; i++) {
    const bin = Math.min(bins - 1, Math.floor((i / fps) * hz + 1e-9));
    sums[bin] = sums[bin]! + activity[i]!;
    counts[bin] = counts[bin]! + 1;
  }
  const grid = new Float64Array(bins);
  for (let bin = 0; bin < bins; bin++) grid[bin] = counts[bin]! > 0 ? sums[bin]! / counts[bin]! : bin > 0 ? grid[bin - 1]! : 0;
  return grid;
}

/** How two films line up. */
export interface Alignment {
  /** Seconds to add to a time of the film to find the same moment of the reference. */
  lag: number;
  source: "activity" | "forced" | "none";
  /** Correlation of the two activity curves at `lag`; null when one is flat or the films share too little at it. */
  correlation: number | null;
}

/**
 * The lag that lines the activity of `film` up with `reference` (both from {@link activityGrid}), within `maxLag` seconds
 * either way, or `forced` seconds when the caller gives one. Without a lag whose curves correlate to at least
 * {@link ALIGN_MIN_CORRELATION} the films are lined up at 0 with source `none`.
 */
export function alignFilms(film: ArrayLike<number>, reference: ArrayLike<number>, maxLag: number, forced?: number): Alignment {
  const aRange = { from: 0, to: film.length };
  const bRange = { from: 0, to: reference.length };
  const minSamples = ALIGN_MIN_OVERLAP_S * ALIGN_HZ;
  const at = (lagSeconds: number) => {
    const r = correlationAtLag(film, reference, -Math.round(lagSeconds * ALIGN_HZ), aRange, bRange, minSamples);
    return r === null ? null : round(r, 3);
  };
  if (forced !== undefined) return { lag: round(forced, 3), source: "forced", correlation: at(forced) };
  const best = bestLag(film, reference, Math.round(maxLag * ALIGN_HZ), aRange, bRange, minSamples);
  if (best === null || best.correlation < ALIGN_MIN_CORRELATION) return { lag: 0, source: "none", correlation: at(0) };
  // `bestLag` pairs film[i] with reference[i - lag]: a reference that is later has a negative lag.
  return { lag: round(-best.lag / ALIGN_HZ, 3) + 0, source: "activity", correlation: round(best.correlation, 3) };
}

/** The stretch of our film (seconds) that has a match in the reference when the reference is `lag` seconds later; `to <= from` when they share none. */
export function matchedStretch(filmDuration: number, referenceDuration: number, lag: number): { from: number; to: number } {
  return { from: Math.max(0, -lag), to: Math.min(filmDuration, referenceDuration - lag) };
}

/** Mean of the activity of the frames of a film at `fps` that start in `[from, to)` seconds; 0 when none do. */
export function meanActivity(activity: ArrayLike<number>, fps: number, from: number, to: number): number {
  const first = Math.max(0, Math.ceil(from * fps - 1e-6));
  const last = Math.min(activity.length, Math.ceil(to * fps - 1e-6));
  if (last <= first) return 0;
  let sum = 0;
  for (let i = first; i < last; i++) sum += activity[i]!;
  return sum / (last - first);
}

/** Mean and 95th percentile of the activity of the frames of a film at `fps` that start in `[from, to)` seconds. */
export function energyOf(activity: ArrayLike<number>, fps: number, from: number, to: number): AnalyzeDiffEnergy {
  const first = Math.max(0, Math.ceil(from * fps - 1e-6));
  const last = Math.min(activity.length, Math.ceil(to * fps - 1e-6));
  if (last <= first) return { mean: 0, p95: 0 };
  const sorted = Array.from({ length: last - first }, (_, i) => activity[first + i]!).sort((a, b) => a - b);
  return { mean: round(meanActivity(activity, fps, from, to), 2), p95: round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]!, 2) };
}

/** Seconds each window of the energy listing covers for a matched stretch of `duration` seconds: 1 s, or longer so there are at most {@link MAX_WINDOWS}. */
export function windowStep(duration: number): number {
  return Math.max(1, Math.ceil(duration / MAX_WINDOWS));
}

/** Activity of both films in each `step` of the stretch `[from, to)` of our film; the reference is read `lag` seconds later. */
export function energyWindows(film: { activity: ArrayLike<number>; fps: number }, reference: { activity: ArrayLike<number>; fps: number }, lag: number, from: number, to: number, step: number): AnalyzeDiffWindow[] {
  const windows: AnalyzeDiffWindow[] = [];
  for (let at = from; at < to - 1e-9; at += step) {
    const end = Math.min(to, at + step);
    windows.push({
      at: round(at, 3),
      film: round(meanActivity(film.activity, film.fps, at, end), 2),
      reference: round(meanActivity(reference.activity, reference.fps, at + lag, end + lag), 2),
    });
  }
  return windows;
}

/**
 * SSIM readings from the stats file of ffmpeg's `ssim` filter (`n:<k> Y:… U:… V:… All:<ssim> (<db>)` per frame, `k` from 1),
 * at `from + (k - 1) * every` seconds of our film; the reference is read `lag` later. A reading that is not a number is left out.
 */
export function parseSsim(text: string, from: number, every: number, lag: number): AnalyzeDiffSample[] {
  const samples: AnalyzeDiffSample[] = [];
  for (const line of text.split("\n")) {
    const found = /^n:(\d+)\b.*\bAll:(-?[0-9.]+)/.exec(line);
    if (!found) continue;
    const ssim = Number(found[2]);
    if (!Number.isFinite(ssim)) continue;
    const at = from + (Number(found[1]) - 1) * every;
    samples.push({ at: round(at, 3), referenceAt: round(at + lag, 3), ssim: round(ssim, 3) });
  }
  return samples;
}

/**
 * The times of our film to put on the side-by-side sheet: up to `count` of them, `Math.ceil(count / 2)` the lowest SSIM
 * readings at least `apart` seconds from each other and the rest evenly spread over the samples, in time order.
 */
export function pickSnapshots(samples: readonly AnalyzeDiffSample[], count: number, apart: number): AnalyzeDiffSample[] {
  if (samples.length <= count) return [...samples];
  const chosen: AnalyzeDiffSample[] = [];
  const far = (sample: AnalyzeDiffSample) => chosen.every((other) => Math.abs(other.at - sample.at) >= apart);
  for (const sample of [...samples].sort((a, b) => a.ssim - b.ssim || a.at - b.at)) {
    if (chosen.length >= Math.ceil(count / 2)) break;
    if (far(sample)) chosen.push(sample);
  }
  const rest = count - chosen.length;
  for (let k = 0; k < rest; k++) {
    // Evenly spread; a spot already taken moves to the next free sample.
    let index = Math.min(samples.length - 1, Math.floor(((k + 0.5) * samples.length) / rest));
    while (chosen.includes(samples[index]!) && index < samples.length - 1) index++;
    while (chosen.includes(samples[index]!) && index > 0) index--;
    if (!chosen.includes(samples[index]!)) chosen.push(samples[index]!);
  }
  return chosen.sort((a, b) => a.at - b.at);
}
