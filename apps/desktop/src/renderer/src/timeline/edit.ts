// Timeline editing (SPEC §10): what a press grabs, where a drag lands, which daemon edits a gesture or key sends.
// Pure and DOM-free, like layout.ts: the panel feeds pointer and keys in and sends the edits out.
import type { TimelineEdit } from "../../../shared/api.js";
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
}

/** Where a dragged clip would land: the ghost drawn during the drag, and the edit sent on release. */
export interface DragPreview {
  clip: ClipBox;
  part: GrabPart;
  /** Track the clip lands on: the one under the pointer when of the same kind, else its own. */
  from: TrackRow;
  row: TrackRow;
  /** Landing times, seconds on the frame grid. */
  start: number;
  end: number;
  /** Target an edge landed on; null when it moved freely. */
  snapped: SnapPoint | null;
  /** Overlaps another clip of {@link DragPreview.row}: the daemon will refuse it. */
  blocked: boolean;
}

/**
 * Ghost of a drag. Moving keeps the length and snaps whichever edge is
 * nearer a target; trimming moves one edge, keeping at least a frame, and a
 * head no earlier than timeline 0 or source 0.
 */
export function dragPreview(input: DragInput): DragPreview {
  const { layout, grab, delta, fps } = input;
  const { clip, part } = grab;
  const frame = 1 / fps;
  const onGrid = (time: number) => Math.round(time * fps) / fps;
  let { start, end } = clip;
  let snapped: SnapPoint | null = null;
  let row = grab.row;

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
    end = start + length;
    const under = rowAt(layout, input.y);
    if (under && under.kind === grab.row.kind) row = under;
  } else if (part === "head") {
    const earliest = Math.max(0, clip.start - clip.in / clip.speed);
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
  const blocked = visibleClips(row.clips, start, end).some(
    (other) => other.id !== clip.id && Math.round(other.start * fps) < Math.round(end * fps) && Math.round(other.end * fps) > Math.round(start * fps),
  );
  return { clip, part, from: grab.row, row, start, end, snapped, blocked };
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
 * The one operation a released drag sends; null when it changes nothing.
 * Trims keep the daemon's energy snapping (ADR 0003, as in the CLI), except
 * an edge put on another clip's edge: a pause-snapped edge there would leave
 * a gap or an overlap, so it goes exactly.
 */
export function dragEdit(preview: DragPreview): TimelineEdit | null {
  const { clip, part } = preview;
  if (part === "body") {
    const start = seconds(preview.start);
    const moved = start !== seconds(clip.start);
    const track = preview.row.id !== preview.from.id;
    if (!moved && !track) return null;
    return { op: "clip.move", args: { clip: clip.id, ...(moved ? { start } : {}), ...(track ? { track: preview.row.id } : {}) } };
  }
  const exact = preview.snapped?.kind === "clip" ? { snap: false } : {};
  if (part === "head") {
    const start = seconds(preview.start);
    return start === seconds(clip.start) ? null : { op: "clip.trim", args: { clip: clip.id, start, ...exact } };
  }
  const end = seconds(preview.end);
  return end === seconds(clip.end) ? null : { op: "clip.trim", args: { clip: clip.id, end, ...exact } };
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

/** Seconds as the daemon stores them: 3 decimals (it snaps to its frame grid itself). */
function seconds(time: number): number {
  return Math.round(time * 1000) / 1000 + 0;
}
