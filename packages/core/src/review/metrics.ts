import type { ReviewBehind, ReviewFinding, ReviewDelivery, ReviewLoudness, ReviewMetrics, ReviewSafeFlag, ReviewSeam, ReviewShortCue, ReviewSound, ReviewSpan, ReviewSpeed, ReviewSync } from "@frameshell/protocol";
import type { ResolvedSubtitleTrack } from "@frameshell/schema";
import { bigChanges, rhythmOf, stillRuns } from "../analyze/rhythm.js";
import { type Cut, frameStart, shotLengthsRead, shotsOf } from "../analyze/shots.js";
import { behindWarnings } from "./behind.js";
import { deliveryWarnings } from "./delivery.js";
import { seamWarnings } from "./loop.js";
import { safeWarnings } from "./safe.js";
import { soundListWarnings } from "./sound.js";
import type { MotionSeries } from "./source.js";
import { syncWarnings } from "./sync.js";

// The numbers of `review`: what a picture sheet cannot tell. Pure: a motion series and cues in, metrics out.
// Thresholds are the owner's launch-film checklist (the HyperFrames `check` and earshot ranges it
// cites; sources in `docs/research/review-thresholds.md`); they are judgments with a number, so every one is a warning, never a failure. Still pictures, big changes
// and bursts are `analyze`'s (`analyze/rhythm.ts`): one scale for a reference and our film. On a sampled
// series every threshold applies per sample interval, as if each sample were a frame.

/** Still stretches longer than this (seconds) are craft warnings. */
export const STILL_WARN_S = 3;
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
  /** What was reviewed: a file's rhythm is measured on every frame, a timeline's estimated on samples. */
  source: "file" | "timeline";
  series: MotionSeries;
  /** Frames of the film where a shot starts: a file's scene cuts, a timeline's clip cuts; absent: none. */
  cuts?: readonly number[];
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
  /** The sound review list; absent: not measured. */
  sound?: ReviewSound | null;
  /** Graphics and faces that cross each platform's zones. */
  safe?: readonly { platform: string; flags: readonly ReviewSafeFlag[] }[];
  /** The speed graphs `speed` asked for; absent: none. */
  speed?: readonly ReviewSpeed[];
  /** Words on tracks behind a plate (ADR 0032); absent: the timeline has none. */
  behind?: readonly ReviewBehind[];
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

/** Indexes of the samples of `series` that first show the shot each of `cuts` (film frames) opens; inside the series only. */
function cutSamples(series: MotionSeries, cuts: readonly number[]): number[] {
  const found = new Set<number>();
  for (const frame of cuts) {
    const i = Math.ceil((frame - series.first) / series.step);
    if (i >= 1 && i < series.energy.length) found.add(i);
  }
  return [...found].sort((a, b) => a - b);
}

/** Seconds of the change at sample `i`: the frame it shows (every frame measured), else the middle of the two samples. */
function changeTime(series: MotionSeries, i: number): number {
  return series.step === 1 ? series.times[i]! : (series.times[i - 1]! + series.times[i]!) / 2;
}

/**
 * Seconds of the visual events of `series` of a film at `fps`: the big changes of `analyze` (`bigChanges`) on its
 * samples, every one of `cuts` (film frames) included.
 */
export function visualEvents(series: MotionSeries, fps: number, cuts: readonly number[] = []): number[] {
  return bigChanges(series.energy, cutSamples(series, cuts), fps / series.step).map((change) => changeTime(series, change.frame));
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
 * The stretches where the picture of a film at `fps` holds still (`stillRuns` of `analyze`): from the sample before
 * the first still change to the end of the frame of the last still sample, so a hold of `n` frames lasts `n / fps`.
 */
export function stillSpans(series: MotionSeries, fps: number): ReviewSpan[] {
  const { times } = series;
  return stillRuns(series.energy, 1).map(({ startFrame, endFrame }) => span(times[startFrame]!, times[endFrame - 1]! + 1 / fps));
}

/** Lengths in frames of the shots of frames `first` to `end - 1` cut at `cuts` (film frames; those outside ignored). */
function shotLengths(first: number, end: number, cuts: readonly number[]): number[] {
  const sorted = [...new Set(cuts)].sort((a, b) => a - b).map((frame) => ({ frame, score: 0 }));
  return shotLengthsRead(shotsOf(sorted, end), end, first);
}

/**
 * The rhythm of `series` on the scale of `analyze` (`rhythmOf`) up to second `pictureTo`: shot-length CV, still share
 * and bursts. On a file measured from frame 0 to its end these are the numbers `analyze` reports for it.
 */
function rhythmMetrics(input: MetricsInput, pictureTo: number): { rhythm: ReviewMetrics["rhythm"]; changes: Cut[] } {
  const { series, fps } = input;
  const cuts = input.cuts ?? [];
  const end = Math.max(series.first + 1, Math.round(pictureTo * fps));
  // A file's cuts are seen in its picture, so they are big changes as in `analyze`; a timeline's clip cuts only split
  // shots: a cut between two clips of one take shows nothing.
  const forced = input.source === "file" ? cutSamples(series, cuts) : [];
  const { rhythm, changes } = rhythmOf(series.energy, fps / series.step, shotLengths(series.first, end, cuts), forced);
  const frameOf = (sample: number) => series.first + sample * series.step;
  return {
    rhythm: {
      label: input.source === "file" ? "MEASURED" : "ESTIMATED",
      shotLengthCv: rhythm.shotLengthCv,
      stillShare: rhythm.stillShare,
      bursts: rhythm.bursts.map((burst) => ({ from: frameStart(frameOf(burst.startFrame), fps), to: frameStart(frameOf(burst.endFrame - 1) + 1, fps), count: burst.count })),
    },
    changes,
  };
}

/** The metrics of one run; see `ReviewMetricsSchema`. */
export function reviewMetrics(input: MetricsInput): ReviewMetrics {
  const { series, range } = input;
  const { times, spread } = series;
  const samples = times.length;
  const spacing = samples > 1 ? (times[samples - 1]! - times[0]!) / (samples - 1) : 0;
  // A file read only up to `MAX_PICTURE_S`: the picture's numbers stop where the series does, as `analyze`'s do.
  const pictureTo = series.truncated && samples > 0 ? Math.min(range.to, frameStart(series.first + samples * series.step, input.fps)) : range.to;
  const end = (last: number) => Math.min(pictureTo, times[last]! + (spacing || 1 / input.fps));
  const craft: ReviewFinding[] = [];

  const still = stillSpans(series, input.fps);
  const staticRuns = still.filter((run) => run.seconds > STILL_WARN_S);
  const longestStatic = still.reduce<ReviewSpan | null>((best, run) => (best === null || run.seconds > best.seconds ? run : best), null);
  for (const run of staticRuns) craft.push({ check: "static", from: run.from, to: run.to, message: `nothing changes in the picture for ${run.seconds} s (from ${run.from} to ${run.to} s).` });

  const { rhythm, changes } = rhythmMetrics(input, pictureTo);
  const events = changes.map((change) => changeTime(series, change.frame));
  let largestGap: ReviewSpan | null = null;
  if (samples > 1) {
    const marks = [range.from, ...events, pictureTo];
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

  const { sync = null, seam = null, delivery = null, sound = null } = input;
  if (sync) craft.push(...syncWarnings(sync));
  if (seam && input.loop) craft.push(...seamWarnings(seam));
  if (delivery) craft.push(...deliveryWarnings(delivery));
  for (const { platform, flags } of input.safe ?? []) craft.push(...safeWarnings(platform, flags));
  if (sound) craft.push(...soundListWarnings(sound));
  if (input.behind) craft.push(...behindWarnings(input.behind));

  craft.sort((a, b) => (a.from ?? -1) - (b.from ?? -1));
  // Every finding is a warning until `requirements.json` is applied (`judgeRequirements`).
  return {
    picture: { samples, spacing: round(spacing), sampled: series.step > 1, longestStatic, staticRuns, events: events.length, largestGap, blank, firstFrameEmpty },
    rhythm,
    subtitles,
    loudness,
    sync,
    seam,
    delivery,
    sound,
    craft: craft.map((finding) => ({ ...finding, severity: "warn" as const })),
    waived: [],
    requirements: null,
    ...(input.speed ? { speed: [...input.speed] } : {}),
    ...(input.behind ? { behind: [...input.behind] } : {}),
  };
}
