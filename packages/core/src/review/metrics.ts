import type { ReviewFinding, ReviewDelivery, ReviewLoudness, ReviewMetrics, ReviewSafeFlag, ReviewSeam, ReviewShortCue, ReviewSpan, ReviewSync } from "@frameshell/protocol";
import type { ResolvedSubtitleTrack } from "@frameshell/schema";
import { deliveryWarnings } from "./delivery.js";
import { seamWarnings } from "./loop.js";
import { safeWarnings } from "./safe.js";
import type { MotionSeries } from "./source.js";
import { syncWarnings } from "./sync.js";

// The numbers of `review` (#457): what a picture sheet cannot tell. Pure: a motion series and cues in, metrics out.
// Thresholds are the owner's launch-film checklist in #457's comments (the HyperFrames `check` and earshot ranges it
// cites); they are judgments with a number, so every one is a warning, never a failure.

/** Mean grey change between samples under which the picture counts as still. */
export const STILL_ENERGY = 0.35;
/** Still stretches longer than this (seconds) are craft warnings. */
export const STILL_WARN_S = 3;
/** A visual event is a peak of change above the larger of this (grey levels) and {@link EVENT_MEDIAN_FACTOR} times the median change. */
export const EVENT_FLOOR = 1;
/** See {@link EVENT_FLOOR}. */
export const EVENT_MEDIAN_FACTOR = 2.5;
/** Grey-level standard deviation under which a picture is near-blank. */
export const BLANK_SPREAD = 4;
/** Films longer than this (seconds) with no sound are a craft warning. */
export const SILENT_FILM_S = 15;
/** True peak (dBTP) above which an encode for a platform may clip; the AAC encode of an export adds about 0.9 dB. */
export const TRUE_PEAK_LIMIT = -1;
/** LU the phone band may be under the whole mix before it is a warning; one reviewed mix lost 9 LU with 80 % of its energy under 60 Hz. */
export const PHONE_BAND_GAP_LU = 6;
/** Cues of one or two words need this long (seconds) on screen. */
export const SHORT_CUE_FLOOR_S = 0.4;
/** Seconds a viewer needs per word after the first half second, before the 0.75 allowance. */
const READ_S_PER_WORD = 0.3;

/** Least seconds a subtitle cue of `words` words stays on screen: 0.4 for one or two, else 0.75 x (0.5 + 0.3 per word). */
export function readingFloor(words: number): number {
  return words <= 2 ? SHORT_CUE_FLOOR_S : 0.75 * (0.5 + READ_S_PER_WORD * words);
}

const round = (value: number) => Math.round(value * 1000) / 1000;

const span = (from: number, to: number): ReviewSpan => ({ from: round(from), to: round(to), seconds: round(to - from) });

/** What {@link reviewMetrics} reads. */
export interface MetricsInput {
  /** The film's frame rate. */
  fps: number;
  /** Seconds reviewed. */
  range: { from: number; to: number };
  series: MotionSeries;
  /** The timeline's subtitle tracks; null for a file. */
  tracks: readonly ResolvedSubtitleTrack[] | null;
  /** The file's loudness; null for a timeline or a file with no sound. */
  loudness: ReviewLoudness | null;
  /** Whether the film has a sound track: false for a file without one, null when unknown (a timeline). */
  hasSound: boolean | null;
  /** Sounds against picture events; absent: not measured. */
  sync?: ReviewSync | null;
  /** The last frame against the first; absent: not measured. */
  seam?: ReviewSeam | null;
  /** The film is meant to repeat: a seam that holds a frame or jumps is a warning. */
  loop?: boolean;
  /** The file against its export plan; absent: not checked. */
  delivery?: ReviewDelivery | null;
  /** Graphics and faces that cross each platform's zones. */
  safe?: readonly { platform: string; flags: readonly ReviewSafeFlag[] }[];
}

/** Runs of consecutive samples (first and last index) where `test` holds, starting at index `from`. */
function runs(length: number, from: number, test: (i: number) => boolean): { first: number; last: number }[] {
  const found: { first: number; last: number }[] = [];
  let first = -1;
  for (let i = from; i <= length; i++) {
    const inside = i < length && test(i);
    if (inside && first < 0) first = i;
    if (!inside && first >= 0) {
      found.push({ first, last: i - 1 });
      first = -1;
    }
  }
  return found;
}

/** The median of `values` (0 for none). */
function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Seconds of the visual events of `series`: peaks of change, each at the middle of the two samples it lies between. */
export function visualEvents(series: MotionSeries): number[] {
  const { times, energy } = series;
  const floor = Math.max(EVENT_FLOOR, EVENT_MEDIAN_FACTOR * median(energy.slice(1)));
  const found: number[] = [];
  for (let i = 1; i < energy.length; i++) {
    // Strictly above the sample before and not below the one after: a plateau is one event.
    if (energy[i]! > floor && energy[i]! > energy[i - 1]! && energy[i]! >= (energy[i + 1] ?? -Infinity)) found.push((times[i - 1]! + times[i]!) / 2);
  }
  return found;
}

/** Subtitle cues of `tracks` inside the range that are on screen for less than their words take to read. */
export function shortCues(tracks: readonly ResolvedSubtitleTrack[], range: { from: number; to: number }): { cues: number; short: ReviewShortCue[] } {
  let cues = 0;
  const short: ReviewShortCue[] = [];
  for (const track of tracks) {
    for (const cue of track.cues) {
      const from = cue.start / track.fps;
      const to = cue.end / track.fps;
      if (to <= range.from || from >= range.to) continue;
      cues++;
      const words = cue.words.length;
      const floor = readingFloor(words);
      if (to - from < floor - 1e-9) short.push({ track: track.track, from: round(from), to: round(to), words, floor: round(floor) });
    }
  }
  return { cues, short };
}

/**
 * The stretches where the picture holds still: a run of samples `i..j` whose change since the sample before is under
 * {@link STILL_ENERGY} is a still picture from sample `i - 1` to `j`.
 */
export function stillSpans(series: MotionSeries): ReviewSpan[] {
  const { times, energy } = series;
  return runs(times.length, 1, (i) => energy[i]! < STILL_ENERGY).map(({ first, last }) => span(times[first - 1]!, times[last]!));
}

/** The metrics of one run; see `ReviewMetricsSchema`. */
export function reviewMetrics(input: MetricsInput): ReviewMetrics {
  const { series, range } = input;
  const { times, spread } = series;
  const samples = times.length;
  const spacing = samples > 1 ? (times[samples - 1]! - times[0]!) / (samples - 1) : 0;
  const end = (last: number) => Math.min(range.to, times[last]! + (spacing || 1 / input.fps));
  const craft: ReviewFinding[] = [];

  const still = stillSpans(series);
  const staticRuns = still.filter((run) => run.seconds > STILL_WARN_S);
  const longestStatic = still.reduce<ReviewSpan | null>((best, run) => (best === null || run.seconds > best.seconds ? run : best), null);
  for (const run of staticRuns) craft.push({ check: "static", from: run.from, to: run.to, message: `nothing changes in the picture for ${run.seconds} s (from ${run.from} to ${run.to} s).` });

  const events = visualEvents(series);
  let largestGap: ReviewSpan | null = null;
  if (samples > 1) {
    const marks = [range.from, ...events, range.to];
    for (let i = 1; i < marks.length; i++) {
      if (largestGap === null || marks[i]! - marks[i - 1]! > largestGap.seconds) largestGap = span(marks[i - 1]!, marks[i]!);
    }
  }

  const blankRuns = runs(samples, 0, (i) => spread[i]! < BLANK_SPREAD);
  const blank = blankRuns.map(({ first, last }) => span(times[first]!, end(last)));
  const firstFrameEmpty = range.from === 0 && samples > 0 ? spread[0]! < BLANK_SPREAD : null;
  if (firstFrameEmpty) craft.push({ check: "frame-0", from: 0, to: round(1 / input.fps), message: "the first frame is empty, and it is the thumbnail." });
  for (const [i, run] of blankRuns.entries()) {
    if (run.first === 0 && firstFrameEmpty) continue;
    craft.push({ check: "blank", from: blank[i]!.from, to: blank[i]!.to, message: `the picture is near-blank from ${blank[i]!.from} to ${blank[i]!.to} s.` });
  }

  let subtitles: ReviewMetrics["subtitles"] = null;
  if (input.tracks && input.tracks.length > 0) {
    const found = shortCues(input.tracks, range);
    subtitles = { cues: found.cues, shortCues: found.short };
    for (const cue of found.short) {
      craft.push({
        check: "reading",
        from: cue.from,
        to: cue.to,
        message: `a subtitle cue of ${cue.words} ${cue.words === 1 ? "word" : "words"} is on screen for ${round(cue.to - cue.from)} s, under the ${cue.floor} s it takes to read (track ${cue.track}).`,
      });
    }
  }

  const { loudness } = input;
  if (loudness?.truePeak != null && loudness.truePeak > TRUE_PEAK_LIMIT) {
    craft.push({ check: "peak", from: null, to: null, message: `the true peak is ${loudness.truePeak} dBTP, above ${TRUE_PEAK_LIMIT} dBTP: a platform's encode can clip it.` });
  }
  if (loudness?.integrated != null && loudness.phoneBand != null && loudness.integrated - loudness.phoneBand >= PHONE_BAND_GAP_LU) {
    craft.push({
      check: "phone-band",
      from: null,
      to: null,
      message: `the phone band (200 Hz to 6 kHz) is ${round(loudness.integrated - loudness.phoneBand)} LU under the whole mix (${loudness.phoneBand} against ${loudness.integrated} LUFS): on a phone speaker it will sound quiet or thin.`,
    });
  }
  const silent = input.hasSound === false || (input.hasSound === true && loudness !== null && loudness.integrated === null);
  if (silent && range.to - range.from > SILENT_FILM_S) {
    craft.push({ check: "silent", from: null, to: null, message: `the film runs ${round(range.to - range.from)} s with no sound.` });
  }

  const { sync = null, seam = null, delivery = null } = input;
  if (sync) craft.push(...syncWarnings(sync));
  if (seam && input.loop) craft.push(...seamWarnings(seam));
  if (delivery) craft.push(...deliveryWarnings(delivery));
  for (const { platform, flags } of input.safe ?? []) craft.push(...safeWarnings(platform, flags));

  craft.sort((a, b) => (a.from ?? -1) - (b.from ?? -1));
  // Every finding is a warning until `requirements.json` is applied (`judgeRequirements`).
  return {
    picture: { samples, spacing: round(spacing), longestStatic, staticRuns, events: events.length, largestGap, blank, firstFrameEmpty },
    subtitles,
    loudness,
    sync,
    seam,
    delivery,
    craft: craft.map((finding) => ({ ...finding, severity: "warn" as const })),
    waived: [],
    requirements: null,
  };
}
