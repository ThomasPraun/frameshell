// Timeline editing (SPEC §10): what a press grabs, where a drag lands, which daemon edits a gesture or key sends.
// Pure and DOM-free, like layout.ts: the panel feeds pointer and keys in and sends the edits out.
import type { EditOptions, HistoryCommand, TimelineEdit } from "../../../shared/api.js";
import { type ClipBox, type LaneViewport, type TimelineLayout, type TrackRow, RULER_HEIGHT, clipAt, visibleClips } from "./layout.js";

/** Edge handles are this wide at most, px; a third of the clip on short clips, so the middle still moves it. */
const EDGE_PX = 6;

/** Part of a clip a press takes hold of: its body moves it, an edge trims it. */
export type GrabPart = "body" | "head" | "tail";

/** A clip taken hold of on the canvas. */
export interface Grab {
  row: TrackRow;
  clip: ClipBox;
  part: GrabPart;
}

/**
 * What a press at (`x`, `y`) grabs, canvas px as in {@link clipAt}; null off
 * clips. Clips of unknown length (nested timeline missing) only move: their
 * drawn end is a stand-in.
 */
export function grabAt(layout: TimelineLayout, viewport: LaneViewport, x: number, y: number): Grab | null {
  const hit = clipAt(layout, viewport, x, y);
  if (!hit) return null;
  const { clip, row } = hit;
  const left = clip.start * viewport.pxPerSecond - viewport.scrollLeft;
  const right = clip.end * viewport.pxPerSecond - viewport.scrollLeft;
  const handle = Math.min(EDGE_PX, (right - left) / 3);
  let part: GrabPart = "body";
  if (!clip.problem && x - left <= handle) part = "head";
  else if (!clip.problem && right - x <= handle) part = "tail";
  return { row, clip, part };
}

/** A time edges snap to: another clip's edge or the playhead. */
export interface SnapPoint {
  time: number;
  kind: "clip" | "playhead";
}

/** Snap targets for a drag: every clip edge but those of `exclude`, and the playhead. Sorted by time. */
export function snapPoints(layout: TimelineLayout, playhead: number, exclude: ReadonlySet<string>): SnapPoint[] {
  const points: SnapPoint[] = [{ time: playhead, kind: "playhead" }];
  for (const row of layout.rows) {
    for (const clip of row.clips) {
      if (exclude.has(clip.id) || clip.problem) continue;
      points.push({ time: clip.start, kind: "clip" }, { time: clip.end, kind: "clip" });
    }
  }
  return points.sort((a, b) => a.time - b.time);
}

/** One pointer position of a drag. */
export interface DragInput {
  layout: TimelineLayout;
  grab: Grab;
  /** Timeline seconds the pointer travelled since the press. */
  delta: number;
  /** Pointer y in content px (ruler included, lanes scrolled): moving onto another track. */
  y: number;
  fps: number;
  /** Targets and reach, seconds (a few px at the current zoom); null snaps nothing. */
  snap: { points: readonly SnapPoint[]; tolerance: number } | null;
  /** Edge drags: ripple trim, later clips of every track follow the edge (`clip.trim` `ripple`). */
  ripple?: boolean;
  /**
   * Body drags: the selected clip ids. When they hold the grabbed clip and
   * others, those move along by the same shift, each on its own track.
   */
  group?: readonly string[];
}

/** A selected clip moving along with the grabbed one: where it would land. */
export interface GroupMember {
  clip: ClipBox;
  row: TrackRow;
  start: number;
  end: number;
}

/** Where a dragged clip would land: the ghost drawn during the drag, and the edit sent on release. */
export interface DragPreview {
  clip: ClipBox;
  part: GrabPart;
  /** Track the clip lands on: the one under the pointer when of the same kind, else its own (always, for a group). */
  from: TrackRow;
  row: TrackRow;
  /** Landing times, seconds on the frame grid. */
  start: number;
  end: number;
  /** Target an edge landed on; null when it moved freely. */
  snapped: SnapPoint | null;
  /** The grabbed clip or a group member overlaps a clip that stays: the daemon will refuse it. */
  blocked: boolean;
  /** Edge drags: a ripple trim. */
  ripple: boolean;
  /** Body drags of a multi-selection: the other selected clips; empty otherwise. */
  others: readonly GroupMember[];
}

/**
 * Ghost of a drag. Moving keeps the length and snaps whichever edge is
 * nearer a target; a group keeps its spacing and stops at timeline 0.
 * Trimming moves one edge, keeping at least a frame, and a head no earlier
 * than timeline 0 or source 0; a ripple trim may pass timeline 0 (the clip
 * keeps its left edge) and is never blocked, since later clips move along.
 */
export function dragPreview(input: DragInput): DragPreview {
  const { layout, grab, delta, fps } = input;
  const { clip, part } = grab;
  const frame = 1 / fps;
  const onGrid = (time: number) => Math.round(time * fps) / fps;
  let { start, end } = clip;
  let snapped: SnapPoint | null = null;
  let row = grab.row;
  const ripple = part !== "body" && input.ripple === true;
  const members = new Set(part === "body" && input.group?.includes(clip.id) ? input.group : []);
  const group = layout.rows.flatMap((candidate) =>
    candidate.clips.filter((other) => other.id !== clip.id && members.has(other.id)).map((other) => ({ clip: other, row: candidate })),
  );
  let others: GroupMember[] = [];

  if (part === "body") {
    const length = clip.end - clip.start;
    start = Math.max(0, clip.start + delta);
    const hitStart = nearest(input.snap, start);
    const hitEnd = nearest(input.snap, start + length);
    const best = [hitStart && { point: hitStart, shift: hitStart.time - start }, hitEnd && { point: hitEnd, shift: hitEnd.time - start - length }]
      .filter((hit): hit is { point: SnapPoint; shift: number } => !!hit && start + hit.shift >= 0)
      .sort((a, b) => Math.abs(a.shift) - Math.abs(b.shift))[0];
    if (best) {
      start += best.shift;
      snapped = best.point;
    } else start = onGrid(start);
    if (group.length > 0) {
      // The member nearest timeline 0 stops the whole group there.
      const floor = -Math.min(...group.map((member) => member.clip.start));
      if (start - clip.start < floor) {
        start = clip.start + floor;
        snapped = null;
      }
      const shift = start - clip.start;
      others = group.map(({ clip: other, row: lane }) => ({ clip: other, row: lane, start: other.start + shift, end: other.end + shift }));
    }
    end = start + length;
    const under = rowAt(layout, input.y);
    if (group.length === 0 && under && under.kind === grab.row.kind) row = under;
  } else if (part === "head") {
    const earliest = ripple ? clip.start - clip.in / clip.speed : Math.max(0, clip.start - clip.in / clip.speed);
    const edge = clip.start + delta;
    snapped = nearest(input.snap, edge);
    start = Math.min(clip.end - frame, Math.max(earliest, snapped ? snapped.time : onGrid(edge)));
    if (snapped && start !== snapped.time) snapped = null;
  } else {
    const edge = clip.end + delta;
    snapped = nearest(input.snap, edge);
    end = Math.max(clip.start + frame, snapped ? snapped.time : onGrid(edge));
    if (snapped && end !== snapped.time) snapped = null;
  }
  const moving = new Set([clip.id, ...members]);
  const overlaps = (lane: TrackRow, from: number, to: number) =>
    visibleClips(lane.clips, from, to).some(
      (other) => !moving.has(other.id) && Math.round(other.start * fps) < Math.round(to * fps) && Math.round(other.end * fps) > Math.round(from * fps),
    );
  const blocked = !ripple && (overlaps(row, start, end) || others.some((member) => overlaps(member.row, member.start, member.end)));
  return { clip, part, from: grab.row, row, start, end, snapped, blocked, ripple, others };
}

/** Nearest snap point within reach of `time`, or null. */
function nearest(snap: DragInput["snap"], time: number): SnapPoint | null {
  if (!snap) return null;
  let best: SnapPoint | null = null;
  for (const point of snap.points) {
    const distance = Math.abs(point.time - time);
    if (distance <= snap.tolerance && (!best || distance < Math.abs(best.time - time))) best = point;
  }
  return best;
}

/** Lane under content `y`, or null over the ruler and below the last lane. */
function rowAt(layout: TimelineLayout, y: number): TrackRow | null {
  if (y < RULER_HEIGHT) return null;
  return layout.rows.find((row) => y >= row.top && y < row.top + row.height) ?? null;
}

/**
 * The operations a released drag sends, as one call; none when it changes
 * nothing. A group move is a `clip.move` per clip, the leading one first so
 * clips of one track never collide midway. Trims keep the daemon's energy
 * snapping (ADR 0003, as in the CLI), except an edge put on another clip's
 * edge: a pause-snapped edge there would leave a gap or an overlap, so it
 * goes exactly. A ripple trim adds `ripple`.
 */
export function dragEdits(preview: DragPreview): TimelineEdit[] {
  const { clip, part } = preview;
  if (part === "body") {
    const start = seconds(preview.start);
    const moved = start !== seconds(clip.start);
    const track = preview.row.id !== preview.from.id;
    if (!moved && !track) return [];
    const grabbed: TimelineEdit = {
      op: "clip.move",
      args: { clip: clip.id, ...(moved ? { start } : {}), ...(track ? { track: preview.row.id } : {}) },
    };
    if (preview.others.length === 0) return [grabbed];
    const later = preview.start > clip.start;
    return [{ clip, start: preview.start }, ...preview.others]
      .sort((a, b) => (later ? b.clip.start - a.clip.start : a.clip.start - b.clip.start))
      .map((member) => ({ op: "clip.move", args: { clip: member.clip.id, start: seconds(member.start) } }));
  }
  const exact = preview.snapped?.kind === "clip" ? { snap: false } : {};
  const ripple = preview.ripple ? { ripple: true } : {};
  if (part === "head") {
    const start = seconds(preview.start);
    return start === seconds(clip.start) ? [] : [{ op: "clip.trim", args: { clip: clip.id, start, ...exact, ...ripple } }];
  }
  const end = seconds(preview.end);
  return end === seconds(clip.end) ? [] : [{ op: "clip.trim", args: { clip: clip.id, end, ...exact, ...ripple } }];
}

/**
 * Undo or redo of a key press, as the Edit menu shows them: Command+Z and
 * Command+Shift+Z on macOS; Control+Z, Control+Shift+Z and Control+Y elsewhere.
 * Null for any other key.
 */
export function historyShortcut(
  event: { key: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean },
  mac: boolean,
): HistoryCommand | null {
  const mod = mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  if (!mod || event.altKey) return null;
  const key = event.key.toLowerCase();
  if (key === "z") return event.shiftKey ? "redo" : "undo";
  return key === "y" && !mac && !event.shiftKey ? "redo" : null;
}

/** Keyboard edit commands of the timeline panel. */
export type EditCommand =
  | { kind: "split" }
  | { kind: "trim"; side: "head" | "tail" }
  | { kind: "nudge"; frames: number }
  | { kind: "delete"; ripple: boolean };

/** What a command acts on: the shared selection's clips and the playhead. */
export interface CommandContext {
  layout: TimelineLayout;
  selected: readonly string[];
  playhead: number;
  fps: number;
}

/**
 * Daemon edits of a keyboard command, in the order to send them, one
 * operation each.
 *
 * - `split` and `trim` (to the playhead) act on the selected clips under the
 *   playhead, or every clip under it when nothing is selected; a clip only
 *   touched by the playhead at an edge is not under it.
 * - `nudge` moves selected clips by frames, the leading one first so clips
 *   of one track never collide midway; clips at 0 stay.
 * - `delete` removes selected clips leaving a gap; `ripple` instead cuts each
 *   clip's range from its own track (exact, no energy snapping: the edges are
 *   existing edit points), latest first so earlier ranges stay put.
 *
 * Clips of unknown length are skipped by all but `delete` without ripple.
 */
export function commandEdits(command: EditCommand, context: CommandContext): TimelineEdit[] {
  const { layout, selected, playhead, fps } = context;
  const chosen = new Set(selected);
  const boxes = layout.rows.flatMap((row) => row.clips.map((clip) => ({ row, clip })));
  const picked = boxes.filter(({ clip }) => chosen.has(clip.id));
  const known = picked.filter(({ clip }) => !clip.problem);
  const frame = (time: number) => Math.round(time * fps);
  const at = seconds(playhead);

  switch (command.kind) {
    case "split":
    case "trim": {
      const pool = selected.length > 0 ? known : boxes.filter(({ clip }) => !clip.problem);
      const under = pool.filter(({ clip }) => frame(clip.start) < frame(playhead) && frame(playhead) < frame(clip.end));
      if (command.kind === "split") return under.map(({ clip }) => ({ op: "clip.split", args: { clip: clip.id, at } }));
      const edge = command.side === "head" ? { start: at } : { end: at };
      return under.map(({ clip }) => ({ op: "clip.trim", args: { clip: clip.id, ...edge } }));
    }
    case "nudge": {
      const shift = command.frames / fps;
      return [...picked]
        .sort((a, b) => (command.frames > 0 ? b.clip.start - a.clip.start : a.clip.start - b.clip.start))
        .map(({ clip }) => ({ clip, start: seconds(Math.max(0, clip.start + shift)) }))
        .filter(({ clip, start }) => start !== seconds(clip.start))
        .map(({ clip, start }) => ({ op: "clip.move", args: { clip: clip.id, start } }));
    }
    case "delete":
      if (!command.ripple) return picked.map(({ clip }) => ({ op: "clip.remove", args: { clip: clip.id } }));
      return [...known]
        .sort((a, b) => b.clip.start - a.clip.start)
        .map(({ row, clip }) => ({
          op: "cut",
          args: { from: seconds(clip.start), to: seconds(clip.end), tracks: [row.id], snap: false },
        }));
  }
}

/**
 * `layout` with clips moved to `starts` (clip id to seconds), keeping their
 * length: where clips will be once nudges already sent apply, so a key
 * pressed again before the daemon's new revision arrives builds on them.
 */
export function withStarts(layout: TimelineLayout, starts: ReadonlyMap<string, number>): TimelineLayout {
  if (starts.size === 0) return layout;
  const rows = layout.rows.map((row) => ({
    ...row,
    clips: row.clips
      .map((clip) => {
        const start = starts.get(clip.id);
        return start === undefined ? clip : { ...clip, start, end: clip.end + (start - clip.start) };
      })
      .sort((a, b) => a.start - b.start),
  }));
  return { ...layout, rows };
}

/**
 * How main records a command's call: nudges of the same clips are one
 * gesture burst (a held `.` is one history entry and one undo step); other
 * commands keep main's default, one labelled transaction per call.
 */
export function commandOptions(command: EditCommand, selected: readonly string[]): EditOptions {
  if (command.kind !== "nudge") return {};
  const ids = [...selected].sort();
  return { label: ids.length === 1 ? "Nudge clip" : `Nudge ${ids.length} clips`, burst: `nudge:${ids.join(" ")}` };
}

/** Seconds as the daemon stores them: 3 decimals (it snaps to its frame grid itself). */
function seconds(time: number): number {
  return Math.round(time * 1000) / 1000 + 0;
}
