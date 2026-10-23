import { type Clip, type MulticamGroup, type Person, type ProgramTrack, type ShotClip, type Timeline, type Transcript, withProgramSound, wordSpeaker } from "@frameshell/schema";
import type { GroupTurns } from "../multicam/group-turns.js";

/** Pauses shorter than this between two spans are bridged (the rule of `multicam.turns`). */
export const RANGE_BRIDGE_S = 0.5;

/** What a range answers: when the person talks, or when they are in the picture. */
export type RangeKind = "speaks" | "onscreen";

/** Timeline seconds `[start, end)`, millisecond precision. */
export interface Span {
  start: number;
  end: number;
}

/** What {@link personRanges} reads; the daemon wires these to the project. */
export interface RangesSource {
  /** Parsed transcript by project-relative file; null when it is missing or invalid. */
  transcript(file: string): Transcript | null;
  /** Speaking turns of a group; see `groupTurns`. */
  turns(group: MulticamGroup): Promise<Pick<GroupTurns, "turns" | "warnings">>;
  /**
   * Source seconds each video shows the person's face, by project-relative
   * asset, with notes on anchors that name no face. Absent: faces are not used.
   */
  faces?(person: Person): Promise<{ spans: Map<string, Span[]>; warnings: string[] }>;
}

/** Result of {@link personRanges}. */
export interface PersonRanges {
  spans: Span[];
  /** Seconds covered by `spans`. */
  total: number;
  /** Links that gave nothing and why, plus the notes of the multicam turns used. */
  warnings: string[];
}

/**
 * When `person` speaks or is on screen on `timeline` (ADR 0020 decision 7):
 * the spans of every source below, merged ({@link mergeSpans}). `timeline`
 * must have its nested timelines flattened. Occlusion by upper tracks is not
 * subtracted. Links whose target is gone are skipped with a warning.
 *
 * - speaks: {@link speakerSpans} and {@link angleSpans}.
 * - onscreen: {@link angleSpans} and {@link faceSpans}.
 */
export async function personRanges(person: Person, kind: RangeKind, timeline: Timeline, source: RangesSource): Promise<PersonRanges> {
  const warnings: string[] = [];
  const spans: Span[] = [];
  if (kind === "speaks") spans.push(...speakerSpans(person, timeline, source, warnings));
  spans.push(...(await angleSpans(person, kind, timeline, source, warnings)));
  if (kind === "onscreen" && source.faces) {
    const faces = await source.faces(person);
    warnings.push(...faces.warnings);
    spans.push(...faceSpans(timeline, faces.spans));
  }
  const merged = mergeSpans(spans);
  return { spans: merged, total: round(merged.reduce((sum, span) => sum + span.end - span.start, 0)), warnings };
}

/**
 * Spans sorted and merged where they touch, overlap or sit less than
 * {@link RANGE_BRIDGE_S} apart; empty ones dropped. Times round to milliseconds.
 */
export function mergeSpans(spans: readonly Span[]): Span[] {
  const sorted = spans
    .map((span) => ({ start: round(span.start), end: round(span.end) }))
    .filter((span) => span.end > span.start)
    .sort((a, b) => a.start - b.start);
  const merged: Span[] = [];
  for (const span of sorted) {
    const last = merged[merged.length - 1];
    if (last && span.start - last.end < RANGE_BRIDGE_S - 1e-9) last.end = Math.max(last.end, span.end);
    else merged.push({ ...span });
  }
  return merged;
}

const round = (seconds: number) => Math.round(seconds * 1000) / 1000;

/**
 * Words of the person's linked speakers placed by the media clips that play
 * their asset, with the mapping of `subtitleWords`: a word counts when its
 * midpoint lies in the clip's `[in, out)`, then `start` and `speed` place it
 * and the clip's edges cut it, so a cut removes its words. Program tracks
 * count by the sound they play (`withProgramSound`), so a mic's transcript is
 * heard through the shots. A word edited to nothing is skipped.
 */
export function speakerSpans(person: Person, timeline: Timeline, source: Pick<RangesSource, "transcript">, warnings: string[]): Span[] {
  const clips = withProgramSound(timeline)
    .tracks.flatMap((track) => (track.kind === "video" || track.kind === "audio" ? track.clips : []))
    .filter((clip): clip is Extract<Clip, { type: "media" }> => clip.type === "media" && "asset" in clip);
  const spans: Span[] = [];
  for (const link of person.speakers) {
    const transcript = source.transcript(link.transcript);
    if (!transcript) {
      warnings.push(`${person.name}: ${link.transcript} is missing or invalid, so that link is ignored.`);
      continue;
    }
    if (link.speaker !== undefined && !transcript.speakers?.some((speaker) => speaker.id === link.speaker)) {
      warnings.push(`${person.name}: ${link.transcript} has no speaker ${link.speaker}, so that link is ignored.`);
      continue;
    }
    const words = transcript.words.filter((word) => (link.speaker === undefined || wordSpeaker(transcript, word) === link.speaker) && transcript.edits[word.id]?.text !== "");
    for (const clip of clips.filter((candidate) => candidate.asset === transcript.asset)) {
      const speed = clip.speed ?? 1;
      const at = (sourceTime: number) => clip.start + (sourceTime - clip.in) / speed;
      for (const word of words) {
        const middle = (word.start + word.end) / 2;
        if (middle < clip.in || middle >= clip.out) continue;
        spans.push({ start: at(Math.max(word.start, clip.in)), end: at(Math.min(word.end, clip.out)) });
      }
    }
  }
  return spans;
}

/**
 * Source spans of each asset (`faces`: where the person's face shows) placed
 * by the media clips of video tracks that show that asset: cut to the clip's
 * `[in, out)`, then moved by `start` and `speed`. Program tracks are left
 * out: there only the shot's angles count.
 */
export function faceSpans(timeline: Timeline, faces: ReadonlyMap<string, readonly Span[]>): Span[] {
  const spans: Span[] = [];
  for (const track of timeline.tracks) {
    if (track.kind !== "video") continue;
    for (const clip of track.clips) {
      if (clip.type !== "media" || !("asset" in clip)) continue;
      const speed = clip.speed ?? 1;
      for (const span of faces.get(clip.asset) ?? []) {
        const from = Math.max(span.start, clip.in);
        const to = Math.min(span.end, clip.out);
        if (to > from) spans.push({ start: clip.start + (from - clip.in) / speed, end: clip.start + (to - clip.in) / speed });
      }
    }
  }
  return spans;
}

/** One shot's group-clock window and where it plays; a later shot cuts an earlier one it overlaps. */
interface Window {
  shot: ShotClip;
  start: number;
  length: number;
}

function windows(track: ProgramTrack): Window[] {
  const shots = [...track.clips].sort((a, b) => a.start - b.start);
  return shots.map((shot, i) => {
    const next = shots[i + 1];
    const length = shot.out - shot.in;
    return { shot, start: shot.start, length: next ? Math.min(length, Math.max(0, next.start - shot.start)) : length };
  });
}

/**
 * Spans from the person's linked multicam angles, through the program track
 * that shows the angle's group: `speaks` is the angle's turns (painted ones
 * included) inside each shot, `onscreen` is each shot that lists the angle.
 * A group the timeline does not show gives nothing. A group of a nested
 * timeline is found by its flattened name (`<nested clip>/<group>`).
 */
export async function angleSpans(person: Person, kind: RangeKind, timeline: Timeline, source: Pick<RangesSource, "turns">, warnings: string[]): Promise<Span[]> {
  const spans: Span[] = [];
  const noted = new Set<string>();
  for (const link of person.angles) {
    const here = link.timeline === timeline.id;
    const groups = (timeline.groups ?? []).filter((group) => (here ? group.id === link.group : group.id.endsWith(`/${link.group}`)));
    for (const group of groups) {
      if (!group.angles.some((angle) => angle.id === link.angle)) {
        warnings.push(`${person.name}: group ${link.group} has no angle ${link.angle}, so that link is ignored.`);
        continue;
      }
      const track = timeline.tracks.find((candidate): candidate is ProgramTrack => candidate.kind === "program" && candidate.group === group.id);
      if (!track) continue;
      if (kind === "onscreen") {
        for (const { shot, start, length } of windows(track)) if (shot.angles.includes(link.angle)) spans.push({ start, end: start + length });
        continue;
      }
      const measured = await source.turns(group);
      for (const warning of measured.warnings) {
        if (noted.has(warning)) continue;
        noted.add(warning);
        warnings.push(warning);
      }
      const turns = measured.turns.filter((turn) => turn.angle === link.angle);
      for (const { shot, start, length } of windows(track)) {
        for (const turn of turns) {
          const from = Math.max(turn.start, shot.in);
          const to = Math.min(turn.end, shot.in + length);
          if (to > from) spans.push({ start: start + from - shot.in, end: start + to - shot.in });
        }
      }
    }
  }
  return spans;
}
