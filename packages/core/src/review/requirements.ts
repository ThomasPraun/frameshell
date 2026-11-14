import type { ReviewMetrics, ReviewRequirementCheck, ReviewRequirements, ReviewSpan, ReviewWaivedWarning } from "@frameshell/protocol";
import { REQUIREMENTS_FILE, type RequirementsFile, type ResolvedSubtitleTrack, type Timeline } from "@frameshell/schema";
import { TimeRefError, resolveTimeRef } from "../timeline/time-ref.js";
import { BLANK_SPREAD, STILL_ENERGY, stillSpans } from "./metrics.js";
import type { MotionSeries } from "./source.js";

// `requirements.json` judged against a run (#457): the assertions the person states, the craft warnings that are
// failures in this project, and the waivers that accept a warning with a reason. Pure: metrics in, metrics out.

/** A clip of the reviewed timeline: where it plays, timeline seconds (`end` null: to the end of the film). */
export interface ClipSpan {
  id: string;
  start: number;
  end: number | null;
}

/** What {@link judgeRequirements} reads besides the file. */
export interface JudgeInput {
  requirements: RequirementsFile;
  /** The run's metrics as `reviewMetrics` made them: every craft warning a `warn`, none waived. */
  metrics: ReviewMetrics;
  series: MotionSeries;
  /** Seconds the whole film runs, whatever the range. */
  filmSeconds: number;
  /** Seconds reviewed. */
  range: { from: number; to: number };
  fps: number;
  /** Timeline reviewed; null for a file, which has no clips, markers or subtitle tracks. */
  timeline: Pick<Timeline, "id" | "markers" | "tempo"> | null;
  clips: readonly ClipSpan[] | null;
  tracks: readonly ResolvedSubtitleTrack[] | null;
}

const round = (value: number) => Math.round(value * 1000) / 1000;

const seconds = (value: number) => `${round(value)} s`;

/** Seconds of `span` that lie inside `[from, to)`. */
function overlap(span: ReviewSpan, from: number, to: number): number {
  return Math.max(0, Math.min(span.to, to) - Math.max(span.from, from));
}

/**
 * How long the picture has held still at the end of the range, and whether that card is not blank: from the last
 * sample that changed to the end of the range.
 */
function endHold(series: MotionSeries, end: number): { seconds: number; blank: boolean } {
  const { times, energy, spread } = series;
  let i = times.length - 1;
  while (i >= 1 && energy[i]! < STILL_ENERGY) i--;
  return { seconds: Math.max(0, end - times[Math.max(0, i)]!), blank: spread[spread.length - 1]! < BLANK_SPREAD };
}

/**
 * `input.metrics` with `requirements.json` applied: each assertion checked into `requirements.checks`, each craft
 * warning a waiver covers moved to `waived` with its reason, the others `fail` when the file lists their check.
 * `notes` are for the run's `warnings`: what the file asks that this review cannot place.
 */
export function judgeRequirements(input: JudgeInput): { metrics: ReviewMetrics; notes: string[] } {
  const { requirements, metrics } = input;
  const notes: string[] = [];
  const checks = [...filmChecks(input), ...captionChecks(input), ...clipChecks(input)];

  const byId = new Map((input.clips ?? []).map((clip) => [clip.id, clip]));
  const end = (clip: ClipSpan) => clip.end ?? input.filmSeconds;
  const covers = (waiver: RequirementsFile["waivers"][number], from: number | null, to: number | null): boolean => {
    if (waiver.clip === undefined) return true;
    const clip = byId.get(waiver.clip);
    if (!clip || from === null) return false;
    const last = Math.max(to ?? from, from);
    return from < end(clip) && (last > clip.start || (last === from && from >= clip.start));
  };

  const matched = requirements.waivers.map(() => 0);
  const craft: ReviewMetrics["craft"] = [];
  const waived: ReviewWaivedWarning[] = [];
  for (const { severity: _severity, ...warning } of metrics.craft) {
    const found = requirements.waivers.flatMap((waiver, index) => (waiver.check === warning.check && covers(waiver, warning.from, warning.to) ? [index] : []));
    for (const index of found) matched[index]!++;
    if (found.length > 0) {
      const first = requirements.waivers[found[0]!]!;
      waived.push({ ...warning, reason: first.reason, ...(first.clip === undefined ? {} : { clip: first.clip }) });
    } else craft.push({ ...warning, severity: requirements.fail.includes(warning.check) ? "fail" : "warn" });
  }

  for (const waiver of requirements.waivers) {
    if (waiver.clip === undefined || byId.has(waiver.clip)) continue;
    notes.push(
      input.clips === null
        ? `requirements: the waiver of ${waiver.check} names clip ${waiver.clip}, and a file has no clips: it covers nothing here (review the timeline).`
        : `requirements: the waiver of ${waiver.check} names clip ${waiver.clip}, which is not on the timeline: it covers nothing.`,
    );
  }

  const result: ReviewRequirements = {
    file: REQUIREMENTS_FILE,
    checks,
    waivers: requirements.waivers.map((waiver, index) => ({ check: waiver.check, ...(waiver.clip === undefined ? {} : { clip: waiver.clip }), reason: waiver.reason, matched: matched[index]! })),
    failed: checks.filter((check) => check.status === "fail").length + craft.filter((warning) => warning.severity === "fail").length,
  };
  return { metrics: { ...metrics, craft, waived, requirements: result }, notes };
}

type Status = ReviewRequirementCheck["status"];

function item(id: string, status: Status, expected: string | number, actual: string | number | null, message: string, clip?: string): ReviewRequirementCheck {
  return { id, ...(clip === undefined ? {} : { clip }), status, expected, actual, message };
}

/** The checks of `film`: length, still stretch, end card, loudness. */
function filmChecks({ requirements, metrics, series, filmSeconds, range, fps, timeline }: JudgeInput): ReviewRequirementCheck[] {
  const { film } = requirements;
  const found: ReviewRequirementCheck[] = [];
  // Half a frame of slack: the length is a whole number of frames, written back as seconds.
  const slack = 0.5 / fps;
  if (film.maxSeconds !== undefined) {
    const over = filmSeconds > film.maxSeconds + slack;
    found.push(item("film.maxSeconds", over ? "fail" : "pass", film.maxSeconds, round(filmSeconds), `the film runs ${seconds(filmSeconds)}${over ? `, over the ${seconds(film.maxSeconds)} the project allows` : `, within ${seconds(film.maxSeconds)}`}.`));
  }
  if (film.minSeconds !== undefined) {
    const under = filmSeconds < film.minSeconds - slack;
    found.push(item("film.minSeconds", under ? "fail" : "pass", film.minSeconds, round(filmSeconds), `the film runs ${seconds(filmSeconds)}${under ? `, under the ${seconds(film.minSeconds)} the project asks for` : `, at least ${seconds(film.minSeconds)}`}.`));
  }
  if (film.maxStatic !== undefined) {
    const longest = metrics.picture.longestStatic;
    const held = longest?.seconds ?? 0;
    const over = held > film.maxStatic + 1e-9;
    found.push(
      item("film.maxStatic", over ? "fail" : "pass", film.maxStatic, held, over ? `the picture holds still for ${seconds(held)} (from ${longest!.from} to ${longest!.to} s), over ${seconds(film.maxStatic)}.` : `the picture never holds still for more than ${seconds(film.maxStatic)}.`),
    );
  }
  if (film.endCard) {
    const wanted = film.endCard.minSeconds;
    if (range.to < filmSeconds - slack) found.push(item("film.endCard", "skipped", wanted, null, `the range stops at ${seconds(range.to)}, short of the end of the film (${seconds(filmSeconds)}).`));
    else if (series.times.length === 0) found.push(item("film.endCard", "skipped", wanted, null, "there is no picture to measure."));
    else {
      const hold = endHold(series, range.to);
      const ok = hold.seconds >= wanted - 1e-9 && !hold.blank;
      found.push(
        item(
          "film.endCard",
          ok ? "pass" : "fail",
          wanted,
          round(hold.seconds),
          hold.blank ? "the film ends on a near-blank picture, not a card." : `the film ends on a picture held for ${seconds(hold.seconds)}${ok ? "" : `, under the ${seconds(wanted)} of an end card`}.`,
        ),
      );
    }
  }
  const { loudness } = film;
  if (loudness) {
    const sound = metrics.loudness;
    const why = timeline !== null ? "a timeline has no loudness: render it and review the file" : "the file has no sound reading";
    if (loudness.target !== undefined) {
      if (sound === null) found.push(item("film.loudness.target", "skipped", loudness.target, null, `${why}.`));
      else if (sound.integrated === null) found.push(item("film.loudness.target", "fail", loudness.target, null, "the file is silent."));
      else {
        const off = round(sound.integrated - loudness.target);
        const ok = Math.abs(off) <= loudness.tolerance + 1e-9;
        found.push(item("film.loudness.target", ok ? "pass" : "fail", loudness.target, sound.integrated, `the file is ${sound.integrated} LUFS, ${ok ? "within" : `${Math.abs(off)} LU ${off > 0 ? "over" : "under"}, outside`} ${loudness.tolerance} LU of the ${loudness.target} LUFS target.`));
      }
    }
    if (loudness.maxTruePeak !== undefined) {
      if (sound === null) found.push(item("film.loudness.maxTruePeak", "skipped", loudness.maxTruePeak, null, `${why}.`));
      else if (sound.truePeak === null) found.push(item("film.loudness.maxTruePeak", "pass", loudness.maxTruePeak, null, "the file has no true peak (digital silence)."));
      else {
        const ok = sound.truePeak <= loudness.maxTruePeak + 1e-9;
        found.push(item("film.loudness.maxTruePeak", ok ? "pass" : "fail", loudness.maxTruePeak, sound.truePeak, `the true peak is ${sound.truePeak} dBTP, ${ok ? "at or under" : "over"} ${loudness.maxTruePeak} dBTP.`));
      }
    }
  }
  return found;
}

/** The caption size check: the smallest text of the subtitle tracks that show in the range. */
function captionChecks({ requirements, tracks, range, fps, timeline }: JudgeInput): ReviewRequirementCheck[] {
  const wanted = requirements.captions?.minSize;
  if (wanted === undefined) return [];
  if (timeline === null || tracks === null) return [item("captions.minSize", "skipped", wanted, null, "a file's captions are burned into its picture: review the timeline to read their size.")];
  const shown = tracks.filter((track) => track.cues.some((cue) => cue.end / fps > range.from && cue.start / fps < range.to));
  if (shown.length === 0) return [item("captions.minSize", "skipped", wanted, null, "no subtitle cue shows in the range.")];
  const smallest = shown.reduce((best, track) => (track.style.size < best.style.size ? track : best));
  const size = round(smallest.style.size);
  const ok = smallest.style.size >= wanted - 1e-9;
  return [
    item("captions.minSize", ok ? "pass" : "fail", wanted, size, `the smallest captions (track ${smallest.track}) are ${size} of the short side${ok ? ", not under" : ", under"} the ${wanted} the project asks for.`),
  ];
}

/** The per-clip checks: `appearsBy`, `before`, `keepsMoving`. */
function clipChecks({ requirements, series, filmSeconds, range, timeline, clips }: JudgeInput): ReviewRequirementCheck[] {
  const found: ReviewRequirementCheck[] = [];
  const byId = new Map((clips ?? []).map((clip) => [clip.id, clip]));
  const still = stillSpans(series);
  for (const { clip: id, appearsBy, before, keepsMoving } of requirements.clips) {
    const asked: [string, string | number][] = [];
    if (appearsBy !== undefined) asked.push(["clip.appearsBy", appearsBy]);
    if (before !== undefined) asked.push(["clip.before", before]);
    if (keepsMoving) asked.push(["clip.keepsMoving", keepsMoving.maxStatic]);
    const clip = byId.get(id);
    for (const [check, expected] of asked) {
      if (clips === null || timeline === null) {
        found.push(item(check, "skipped", expected, null, `a file has no clips: review the timeline to check clip ${id}.`, id));
        continue;
      }
      if (!clip) {
        found.push(item(check, "fail", expected, null, `clip ${id} is not on the timeline.`, id));
        continue;
      }
      if (check === "clip.appearsBy") {
        let by: number;
        try {
          by = resolveTimeRef(appearsBy!, { timeline });
        } catch (error) {
          found.push(item(check, "fail", expected, null, error instanceof TimeRefError ? error.message : `cannot read the time ${appearsBy}.`, id));
          continue;
        }
        const ok = clip.start <= by + 1e-6;
        found.push(item(check, ok ? "pass" : "fail", expected, round(clip.start), `clip ${id} starts at ${seconds(clip.start)}${ok ? ", by" : ", after"} ${seconds(by)}.`, id));
      } else if (check === "clip.before") {
        const other = byId.get(before!);
        if (!other) found.push(item(check, "fail", expected, null, `clip ${before} is not on the timeline.`, id));
        else {
          const ok = clip.start < other.start;
          found.push(item(check, ok ? "pass" : "fail", expected, round(clip.start), `clip ${id} starts at ${seconds(clip.start)}, ${ok ? "before" : "not before"} clip ${before} at ${seconds(other.start)}.`, id));
        }
      } else {
        const to = clip.end ?? filmSeconds;
        if (clip.start >= range.to || to <= range.from) {
          found.push(item(check, "skipped", expected, null, `clip ${id} plays outside the range reviewed.`, id));
          continue;
        }
        const longest = still.reduce((best, span) => (overlap(span, clip.start, to) > overlap(best, clip.start, to) ? span : best), { from: 0, to: 0, seconds: 0 });
        const held = round(overlap(longest, clip.start, to));
        const ok = held <= keepsMoving!.maxStatic + 1e-9;
        found.push(item(check, ok ? "pass" : "fail", expected, held, ok ? `the picture holds still for at most ${seconds(held)} while clip ${id} plays.` : `the picture holds still for ${seconds(held)} while clip ${id} plays, over ${seconds(keepsMoving!.maxStatic)}.`, id));
      }
    }
  }
  return found;
}
