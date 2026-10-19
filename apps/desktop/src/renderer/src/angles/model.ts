// What the multicam viewer shows at the playhead (#243, ADR 0016 decision 5): the group's angles, which ones the
// current shot uses, who speaks, and where each angle's file is. Pure: the panel draws it.
import type { MulticamTurnsResult, TimelineView } from "@frameshell/protocol";
import type { TranscriptSource } from "../transcript/model.js";
import { ANGLE_COLOR_COUNT, type ShotAngle, type TrackRow, layoutTimeline } from "../timeline/layout.js";

/** One speaking turn, as `multicam.turns` reports it. */
export type SpeakingTurn = MulticamTurnsResult["turns"][number];

/** One angle's tile. */
export interface AngleTile {
  /** Angle id in the group. */
  id: string;
  /** Angle name as the group shows it. */
  name: string;
  /** 1-based place in the group: the number key, and what a click cuts to. */
  number: number;
  /** Colour slot, as the timeline paints the angle. */
  color: number;
  /** Project-relative asset the angle plays. */
  asset: string;
  /** Seconds in the angle's own file at the playhead, never negative. */
  sourceTime: number;
  /** CSS `object-view-box` that shows only the angle's cropped picture (a tile of a gallery recording); null without a crop. */
  viewBox: string | null;
  /** The shot under the playhead shows this angle. */
  inShot: boolean;
  /** A turn of this angle covers the playhead; several angles can speak at once. */
  speaking: boolean;
}

/** The viewer's picture of the timeline at a playhead time. */
export interface ViewerModel {
  /** Group id. */
  group: string;
  /** Group-clock seconds at the playhead. */
  groupTime: number;
  /** Whether a shot of the program track is under the playhead; false in a gap, where no angle counts as shown. */
  hasShot: boolean;
  /** One tile per group angle, in group order. */
  tiles: AngleTile[];
}

/**
 * Whether the turn of `angle` covers group time `time`. Start inclusive, end exclusive, so adjacent turns of
 * one angle never both cover a boundary.
 */
export function speakingAt(turns: readonly SpeakingTurn[], angle: string, time: number): boolean {
  return turns.some((turn) => turn.angle === angle && turn.start <= time && time < turn.end);
}

/**
 * Where the playhead is on the group clock, from the shot under it: `in` at the shot's start. In a gap the clock
 * continues from the nearest earlier shot (else the first one), so the angles keep showing about where the take is.
 */
export function groupTimeAt(row: TrackRow, time: number, fps: number): { groupTime: number; shot: boolean } {
  const frame = Math.round(time * fps);
  const shots = row.clips.filter((clip) => clip.shot !== null);
  const under = shots.find((clip) => Math.round(clip.start * fps) <= frame && frame < Math.round(clip.end * fps));
  if (under) return { groupTime: under.in + (frame / fps - under.start), shot: true };
  const before = [...shots].reverse().find((clip) => clip.end <= frame / fps + 1e-9);
  const anchor = before ?? shots[0];
  return { groupTime: anchor ? anchor.in + (time - anchor.start) : time, shot: false };
}

/** The program tracks of `view` that show a group, topmost first, as the number keys see them. */
export function programRows(view: TimelineView): TrackRow[] {
  return layoutTimeline(view).rows.filter((row) => row.kind === "program" && row.group !== null && row.angles.length > 0);
}

/** The row of `rows` the viewer shows at `time`: the topmost with a shot there, else the topmost. */
export function viewerRow(rows: readonly TrackRow[], fps: number, time: number): TrackRow | undefined {
  return rows.find((candidate) => groupTimeAt(candidate, time, fps).shot) ?? rows[0];
}

/**
 * The tiles at `time` (timeline seconds) for the topmost of `rows` ({@link programRows}) that has a shot there, else
 * the topmost; null when there is none. `turns` are the group's speaking turns (empty until measured).
 */
export function viewerModel(
  rows: readonly TrackRow[],
  groups: TimelineView["groups"],
  fps: number,
  time: number,
  turns: readonly SpeakingTurn[] = [],
): ViewerModel | null {
  const row = viewerRow(rows, fps, time);
  const group = row ? groups?.find((candidate) => candidate.id === row.group) : undefined;
  if (!row || !group) return null;
  const { groupTime, shot } = groupTimeAt(row, time, fps);
  const shown = new Set(shot ? shotAnglesAt(row, time, fps) : []);
  return {
    group: group.id,
    groupTime,
    hasShot: shot,
    tiles: group.angles.map((angle, index) => ({
      id: angle.id,
      name: angle.name,
      number: index + 1,
      color: index % ANGLE_COLOR_COUNT,
      asset: angle.asset,
      sourceTime: Math.max(0, groupTime - angle.offset),
      viewBox: cropViewBox(angle.crop),
      inShot: shown.has(angle.id),
      speaking: speakingAt(turns, angle.id, groupTime),
    })),
  };
}

function shotAnglesAt(row: TrackRow, time: number, fps: number): string[] {
  const frame = Math.round(time * fps);
  const clip = row.clips.find((candidate) => candidate.shot !== null && Math.round(candidate.start * fps) <= frame && frame < Math.round(candidate.end * fps));
  return clip?.shot?.angles.map((angle: ShotAngle) => angle.id) ?? [];
}

/** Whether two sets of turns are the same, so a refetch that found nothing new does not redraw. */
export function sameTurns(a: readonly SpeakingTurn[], b: readonly SpeakingTurn[]): boolean {
  return a.length === b.length && a.every((turn, i) => turn.angle === b[i]!.angle && turn.start === b[i]!.start && turn.end === b[i]!.end);
}

/**
 * When `multicam.turns` must be asked again: the angles or mics changed, or a transcript of a sound they are heard
 * through (an angle's file, a mic's file) did (a diarization run, a speaker correction) or went stale. Angles sharing a
 * file or mic take their turns from its transcript.
 */
export function turnsKey(
  angles: readonly { asset: string }[],
  sources: readonly TranscriptSource[],
  hashes: ReadonlyMap<string, string | null>,
  mics: readonly { asset: string }[] = [],
): string {
  const assets = new Set([...angles, ...mics].map((sound) => sound.asset));
  const transcripts = sources
    .filter((source) => assets.has(source.transcript.asset))
    .map((source) => [source.path, source.transcript, hashes.get(source.transcript.asset) ?? null]);
  return JSON.stringify([angles, mics, transcripts]);
}

/** `inset(top right bottom left)` in percent of the picture for an angle's crop fractions; null when nothing is cut. */
export function cropViewBox(crop: { left?: number | undefined; top?: number | undefined; right?: number | undefined; bottom?: number | undefined } | undefined): string | null {
  if (!crop) return null;
  const sides = [crop.top, crop.right, crop.bottom, crop.left].map((side) => side ?? 0);
  if (sides.every((side) => side === 0)) return null;
  return `inset(${sides.map((side) => `${Math.round(side * 10000) / 100}%`).join(" ")})`;
}
