import type { ReviewMetrics, ReviewRequirementCheck, ReviewRequirements, ReviewSpan, ReviewWaivedWarning } from "@frameshell/protocol";
import { REQUIREMENTS_FILE, type RequirementsFile, type ResolvedSubtitleTrack, type Timeline, clipRequirements, staysInFrameMargin } from "@frameshell/schema";
import { STILL_LEVEL } from "../analyze/rhythm.js";
import { TimeRefError, resolveTimeRef } from "../timeline/time-ref.js";
import { BLANK_SPREAD, stillSpans } from "./metrics.js";
import type { BoxSpan } from "./placement.js";
import type { MotionSeries } from "./source.js";

// `requirements.json` judged against a run (#457): the assertions the person states, the craft warnings that are
// failures in this project, and the waivers that accept a warning with a reason. Pure: metrics in, metrics out.

/** A clip of the reviewed timeline: where it plays, timeline seconds (`end` null: to the end of the film). */
export interface ClipSpan {
  id: string;
  start: number;
  end: number | null;
}

/** Where the pictures of the clips are in the film reviewed, for `staysInFrame`: `placement.ts` boxes in the film's pixels. */
export interface FramePlacement {
  /** Id of the project format reviewed. */
  format: string;
  /** The picture the film shows: the whole frame, or what letterbox bars leave of it; film pixels. */
  picture: { left: number; top: number; width: number; height: number };
  boxes: readonly BoxSpan[];
  /** Why a clip has no box, by clip id, when known. */
  unplaced: ReadonlyMap<string, string>;
}

/** Film pixels within which a box counts as touching an edge: the picture is cut there. */
const EDGE_PX = 0.5;

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
  /** For `staysInFrame`; null or absent when it was not measured (a file, or the timeline could not be laid out). */
  placement?: FramePlacement | null | undefined;
}

/** Ids of `clips` that are clip `id` inside a nested clip (`<nested clip id>/<id>`). */
function nestedPaths(id: string, clips: readonly ClipSpan[] | null): string[] {
  return [...new Set((clips ?? []).filter((clip) => clip.id.endsWith(`/${id}`)).map((clip) => clip.id))];
}

/** The paths clip `id` can be named by inside nested clips, as the end of a sentence. */
function nestedHint(id: string, clips: readonly ClipSpan[] | null): string {
  const paths = nestedPaths(id, clips);
  return `${paths.slice(0, 3).join(", ")}${paths.length > 3 ? ", ..." : ""} (<nested clip id>/<clip id>).`;
}

/** Why clip `id` is not in `clips`: the way to name it when it is inside nested clips, else just that it is absent. */
function missingClip(id: string, clips: readonly ClipSpan[] | null): string {
  if (nestedPaths(id, clips).length === 0) return `clip ${id} is not on the timeline.`;
  return `clip ${id} is inside a nested timeline: name it as ${nestedHint(id, clips)}`;
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
  while (i >= 1 && energy[i]! < STILL_LEVEL) i--;
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
  const covers = (waiver: RequirementsFile["waivers"][number], warning: { clip?: string | undefined; from: number | null; to: number | null }): boolean => {
    if (waiver.clip === undefined) return true;
    // A warning about one clip (`behind`) is that clip's alone, whatever else plays then.
    if (warning.clip !== undefined) return warning.clip === waiver.clip;
    const { from, to } = warning;
    const clip = byId.get(waiver.clip);
    if (!clip || from === null) return false;
    const last = Math.max(to ?? from, from);
    return from < end(clip) && (last > clip.start || (last === from && from >= clip.start));
  };

  const matched = requirements.waivers.map(() => 0);
  const craft: ReviewMetrics["craft"] = [];
  const waived: ReviewWaivedWarning[] = [];
  for (const { severity: _severity, ...warning } of metrics.craft) {
    const found = requirements.waivers.flatMap((waiver, index) => (waiver.check === warning.check && covers(waiver, warning) ? [index] : []));
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
        : nestedPaths(waiver.clip, input.clips).length > 0
          ? `requirements: the waiver of ${waiver.check} names clip ${waiver.clip}, which is inside a nested timeline: name it as ${nestedHint(waiver.clip, input.clips)}`
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

/** The per-clip checks: `appearsBy`, `before`, `keepsMoving`, `staysInFrame`. */
function clipChecks({ requirements, series, filmSeconds, range, fps, timeline, clips, placement }: JudgeInput): ReviewRequirementCheck[] {
  const found: ReviewRequirementCheck[] = [];
  const byId = new Map((clips ?? []).map((clip) => [clip.id, clip]));
  const still = stillSpans(series, fps);
  for (const { clip: id, appearsBy, before, keepsMoving, staysInFrame } of clipRequirements(requirements.clips)) {
    const asked: [string, string | number][] = [];
    if (appearsBy !== undefined) asked.push(["clip.appearsBy", appearsBy]);
    if (before !== undefined) asked.push(["clip.before", before]);
    if (keepsMoving) asked.push(["clip.keepsMoving", keepsMoving.maxStatic]);
    const margin = staysInFrameMargin(staysInFrame);
    if (margin !== null) asked.push(["clip.staysInFrame", margin]);
    const clip = byId.get(id);
    for (const [check, expected] of asked) {
      if (clips === null || timeline === null) {
        found.push(item(check, "skipped", expected, null, `a file has no clips: review the timeline to check clip ${id}.`, id));
        continue;
      }
      if (!clip) {
        found.push(item(check, "fail", expected, null, missingClip(id, clips), id));
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
        if (!other) found.push(item(check, "fail", expected, null, missingClip(before!, clips), id));
        else {
          const ok = clip.start < other.start;
          found.push(item(check, ok ? "pass" : "fail", expected, round(clip.start), `clip ${id} starts at ${seconds(clip.start)}, ${ok ? "before" : "not before"} clip ${before} at ${seconds(other.start)}.`, id));
        }
      } else if (check === "clip.staysInFrame") {
        found.push(inFrameCheck(clip, margin!, filmSeconds, range, placement ?? null));
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

/** Seconds `spans` cover, merged where they touch or overlap. */
function merged(spans: { from: number; to: number }[]): ReviewSpan[] {
  const out: ReviewSpan[] = [];
  for (const span of [...spans].sort((a, b) => a.from - b.from)) {
    const last = out.at(-1);
    if (last && span.from <= last.to + 1e-6) last.to = Math.max(last.to, span.to);
    else out.push({ from: span.from, to: span.to, seconds: 0 });
  }
  return out.map((span) => ({ from: round(span.from), to: round(span.to), seconds: round(span.to - span.from) }));
}

/** The edges of `picture` that `box` touches or crosses, `margin` (share of the picture) inside each. */
function edgesLeft(box: BoxSpan["box"], picture: FramePlacement["picture"], margin: number): string[] {
  const x = Math.max(margin * picture.width, EDGE_PX);
  const y = Math.max(margin * picture.height, EDGE_PX);
  const edges: string[] = [];
  if (box.x0 < picture.left + x) edges.push("left");
  if (box.x1 > picture.left + picture.width - x) edges.push("right");
  if (box.y0 < picture.top + y) edges.push("top");
  if (box.y1 > picture.top + picture.height - y) edges.push("bottom");
  return edges;
}

/**
 * `staysInFrame` of `clip`: every box of what it draws (its alpha, or the faces of its footage) while it plays in the
 * range keeps `margin` of the picture clear on every side; touching an edge is leaving, since the picture is cut there.
 */
function inFrameCheck(clip: ClipSpan, margin: number, filmSeconds: number, range: { from: number; to: number }, placement: FramePlacement | null): ReviewRequirementCheck {
  const check = "clip.staysInFrame";
  const to = Math.min(clip.end ?? filmSeconds, range.to);
  const from = Math.max(clip.start, range.from);
  if (from >= to) return item(check, "skipped", margin, null, `clip ${clip.id} plays outside the range reviewed.`, clip.id);
  if (!placement) return item(check, "skipped", margin, null, `what clip ${clip.id} draws could not be placed in the frame (the run's warnings say why).`, clip.id);
  const { format, picture } = placement;
  const boxes = placement.boxes.filter((box) => box.clip === clip.id && box.to > from && box.from < to);
  if (boxes.length === 0) {
    const why =
      placement.unplaced.get(clip.id) ??
      "nothing it draws has a box here: a generated clip needs a render with an alpha plane, footage a cached `people scan` (`frameshell people scan`) with a face while it plays";
    return { ...item(check, "skipped", margin, null, `clip ${clip.id} in format ${format}: ${why}.`, clip.id), format };
  }
  const edges = new Set<string>();
  const out: { from: number; to: number }[] = [];
  for (const box of boxes) {
    const left = edgesLeft(box.box, picture, margin);
    if (left.length === 0) continue;
    for (const edge of left) edges.add(edge);
    out.push({ from: Math.max(box.from, from), to: Math.min(box.to, to) });
  }
  const what = boxes[0]!.subject === "face" ? `a face of clip ${clip.id}` : `what clip ${clip.id} draws`;
  const line = margin > 0 ? `within ${round(margin * 100)} % of the edge of the frame` : "the frame";
  if (out.length === 0) {
    return { ...item(check, "pass", margin, 0, `${what} stays inside ${margin > 0 ? `a ${round(margin * 100)} % margin of ` : ""}the frame of format ${format} (${boxes.length} samples).`, clip.id), format };
  }
  const spans = merged(out);
  const total = round(spans.reduce((sum, span) => sum + span.seconds, 0));
  const times = spans.map((span) => `${span.from} to ${span.to} s`).join(", ");
  const verb = margin > 0 ? `comes ${line}` : "leaves the frame";
  return { ...item(check, "fail", margin, total, `${what} ${verb} of format ${format} (${[...edges].join(", ")}) from ${times}.`, clip.id), format, spans };
}
