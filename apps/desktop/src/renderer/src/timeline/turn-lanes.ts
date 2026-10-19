// Turn lanes of a program track (ADR 0016 decision 3, #247): who speaks, per angle, drawn under the shots and painted by
// hand. Turns and painted marks are on the group clock; the lanes are on the timeline clock, which only shows the
// stretches some shot plays. Pure and DOM-free, like layout.ts.
import type { TimelineEdit } from "../../../shared/api.js";
import type { ClipBox, LaneViewport, TimelineLayout, TrackRow, TurnLane } from "./layout.js";

/** Height of one angle's lane under a program track, px. */
export const TURN_LANE_HEIGHT = 16;

/** A stretch of time, seconds. */
export interface Span {
  start: number;
  end: number;
}

/** A group-clock stretch a person marked for one angle. */
export interface PaintedMark extends Span {
  angle: string;
  speaking: boolean;
}

/** One speaking turn on the group clock. */
export interface GroupTurn extends Span {
  angle: string;
}

/** What a shot plays: timeline `start`..`end` shows group `in`.. (speed 1). */
export interface ShotSpan extends Span {
  /** Group-clock second shown at `start`. */
  in: number;
}

/** What a stroke on a lane does to its angle's turns. */
export type PaintMode =
  /** The angle speaks and every other angle is silent there. */
  | "only"
  /** The angle speaks too; the others stay as they are. */
  | "add"
  /** The angle does not speak, whatever its sound says. */
  | "silent"
  /** Back to the measured turns. */
  | "measured";

const EPSILON = 1e-6;
const ms = (seconds: number) => Math.round(seconds * 1000) / 1000;

/** The shots of a program row as spans, in timeline order. */
export function shotSpans(clips: readonly ClipBox[]): ShotSpan[] {
  return clips.filter((clip) => clip.shot !== null).map((clip) => ({ start: clip.start, end: clip.end, in: clip.in }));
}

/** Joins touching spans, sorted. */
function joined(spans: Span[]): Span[] {
  const out: Span[] = [];
  for (const span of spans.sort((a, b) => a.start - b.start)) {
    const last = out[out.length - 1];
    if (last && span.start <= last.end + EPSILON) last.end = Math.max(last.end, span.end);
    else out.push({ ...span });
  }
  return out;
}

/** Where `groups` (group-clock stretches) play on the timeline: the parts some shot shows, touching ones joined. */
export function toTimeline(shots: readonly ShotSpan[], groups: readonly Span[]): Span[] {
  const out: Span[] = [];
  for (const shot of shots) {
    const groupEnd = shot.in + (shot.end - shot.start);
    for (const group of groups) {
      const from = Math.max(group.start, shot.in);
      const to = Math.min(group.end, groupEnd);
      if (to - from > EPSILON) out.push({ start: shot.start + (from - shot.in), end: shot.start + (to - shot.in) });
    }
  }
  return joined(out);
}

/**
 * The group-clock stretches that timeline stretch `[from, to)` shows: one per shot it crosses, those that
 * continue one another on the group clock joined (a shot split in two is one stretch).
 */
export function toGroup(shots: readonly ShotSpan[], from: number, to: number): Span[] {
  const out: Span[] = [];
  for (const shot of shots) {
    const start = Math.max(from, shot.start);
    const end = Math.min(to, shot.end);
    if (end - start > EPSILON) out.push({ start: ms(shot.in + (start - shot.start)), end: ms(shot.in + (end - shot.start)) });
  }
  return joined(out).filter((span) => span.end - span.start >= 0.001);
}

/** What a lane draws, on the timeline clock. */
export interface LaneMarks {
  /** Turns of the angle, measured and painted. */
  turns: Span[];
  /** Painted stretches of the angle that are spoken. */
  spoken: Span[];
  /** Painted stretches of the angle that are silent. */
  silenced: Span[];
}

/** The marks of `angle`'s lane: its `turns` and the `painted` stretches of the group, as the shots show them. */
export function laneMarks(shots: readonly ShotSpan[], angle: string, turns: readonly GroupTurn[], painted: readonly PaintedMark[]): LaneMarks {
  const mine = <T extends { angle: string }>(list: readonly T[]) => list.filter((entry) => entry.angle === angle);
  return {
    turns: toTimeline(shots, mine(turns)),
    spoken: toTimeline(shots, mine(painted).filter((mark) => mark.speaking)),
    silenced: toTimeline(shots, mine(painted).filter((mark) => !mark.speaking)),
  };
}

/** True when `time` is inside one of `spans` (start inclusive). */
export function within(spans: readonly Span[], time: number): boolean {
  return spans.some((span) => span.start <= time + EPSILON && time < span.end - EPSILON);
}

/**
 * The `multicam.paint` edits of a stroke over timeline stretch `[from, to)` on `angle`'s lane: one per stretch of
 * the group clock the shots show there (none over gaps), sent together as one transaction.
 */
export function paintEdits(group: string, angle: string, shots: readonly ShotSpan[], from: number, to: number, mode: PaintMode): TimelineEdit[] {
  const [low, high] = from <= to ? [from, to] : [to, from];
  return toGroup(shots, low, high).map((span) => ({
    op: "multicam.paint",
    args: {
      group,
      angle,
      start: span.start,
      end: span.end,
      speaking: mode === "measured" ? null : mode !== "silent",
      ...(mode === "only" ? { alone: true } : {}),
    },
  }));
}

/**
 * The edits taking the painted stretch of `angle` under timeline second `time` back to measured, or none when
 * nothing is painted there.
 */
export function unpaintEdits(group: string, angle: string, shots: readonly ShotSpan[], painted: readonly PaintedMark[], time: number): TimelineEdit[] {
  const shot = shots.find((candidate) => candidate.start <= time + EPSILON && time < candidate.end - EPSILON);
  if (!shot) return [];
  const second = shot.in + (time - shot.start);
  const mark = painted.find((candidate) => candidate.angle === angle && candidate.start <= second + EPSILON && second < candidate.end - EPSILON);
  return mark ? [{ op: "multicam.paint", args: { group, angle, start: mark.start, end: mark.end, speaking: null } }] : [];
}

/** The lane under a point of the canvas (`x` from the lanes' left edge, `y` from the top, ruler included), or null. */
export function laneAt(layout: TimelineLayout, viewport: LaneViewport, x: number, y: number): { row: TrackRow; lane: TurnLane; time: number } | null {
  if (y < layout.head) return null;
  const contentY = y + viewport.scrollTop;
  for (const row of layout.rows) {
    const lane = row.lanes.find((candidate) => contentY >= candidate.top && contentY < candidate.top + candidate.height);
    if (lane) return { row, lane, time: (x + viewport.scrollLeft) / viewport.pxPerSecond };
  }
  return null;
}

/** Past any group's end: `multicam.paint` ranges need an end, and clearing takes everything. */
const WHOLE_GROUP_S = 1e6;

/** The edit taking every painted turn of `angle` (of every angle when null) in `group` back to measured. */
export function clearEdit(group: string, angle: string | null): TimelineEdit {
  return { op: "multicam.paint", args: { group, ...(angle === null ? {} : { angle }), start: 0, end: WHOLE_GROUP_S, speaking: null } };
}
