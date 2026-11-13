import { ErrorCode, RpcError, type SnapToKind, TIME_REF_FIELDS } from "@frameshell/protocol";
import { type BeatsFile, type MediaClip, type Tempo, type Timeline, effectiveBeatGrid, findMarker, findMusicClip, isLowConfidence, nominalBeatFrame } from "@frameshell/schema";
import { FrameGrid } from "./grid.js";
import { TimeRefError, resolveTimeRefAsync, unusableGrid } from "./time-ref.js";
import type { OperationRequest } from "./engine.js";

/**
 * The timeline's beat grid on the timeline clock (ADR 0029 slice 3): the one place `tempo` turns into beat and bar
 * times, read by `tempo.show`, `timeline.show` with `grid` (the app paints it) and `--snap-to`. Pure apart from the
 * injected beats file lookup.
 */

/** Most beats one grid lists; a nominal grid over hours at a high tempo stops here. */
export const MAX_GRID_BEATS = 20_000;

/** Fewest beats a nominal grid is built past its last requested time; it is built a whole bar past it at least. */
const NOMINAL_TAIL_BEATS = 2;

/** How far a time may sit from the marker `--snap-to marker` moves it to, seconds. */
export const MARKER_SNAP_REACH_S = 1;

/** The beat kinds of `snapTo`, which need a grid; `marker` does not. */
type GridKind = Exclude<SnapToKind, "marker">;

/** A beat grid on the timeline clock. */
export interface TimelineGrid {
  /** `beats`: measured, from a beats file; `nominal`: from a BPM alone. */
  source: "beats" | "nominal";
  /** Beats per minute on the timeline clock (a sped-up music clip is faster). */
  bpm: number;
  /** Beats per bar. */
  meter: number;
  /** The music clip the grid rides on; absent for a nominal grid on the timeline clock. */
  clip?: string;
  /** Project-relative asset whose beats file gave the grid; absent for a nominal grid. */
  asset?: string;
  /** Confidence of the measured grid, 0..1; absent for a nominal grid (it is exact). */
  confidence?: number;
  /** True when the grid is LOW confidence and nobody vouched for it with `edits`: `--snap-to` refuses it. */
  low: boolean;
  /** Timeline seconds of every beat, increasing, on the frame grid. */
  beats: number[];
  /** Timeline seconds of the beats that start a bar (a subset of `beats`). */
  bars: number[];
  /**
   * Beats of the music FILE before `beats[0]` (the head a trim cuts away): `beat:N` counts from the file's first
   * measured beat, so `beats[i]` is `beat:(beatBase + i + 1)`. 0 for a grid on the timeline clock.
   */
  beatBase: number;
  /** Bar starts of the music file before `bars[0]`, like {@link TimelineGrid.beatBase}: `bars[i]` is `bar:(barBase + i + 1)`. */
  barBase: number;
}

/** What {@link tempoGrid} found. */
export interface TempoResult {
  /** The grid; null when `tempo` is unset or its beats are not there (see `problem`). */
  grid: TimelineGrid | null;
  /** Why there is no grid although a `tempo` is set (no beats file, a broken one); null otherwise. */
  problem: string | null;
}

/** Input of {@link tempoGrid}. */
export interface TempoInput {
  fps: number;
  timeline: Pick<Timeline, "tempo" | "tracks">;
  /** A nominal grid on the timeline clock runs up to this timeline second (and a little past it). */
  horizon: number;
  /** Beats file of a project-relative asset, or null when it has none; throws for a broken file. */
  beatsOf(asset: string): Promise<BeatsFile | null>;
}

/** Indexes (of `count` beats) that start a bar when beat `first` does and bars repeat every `meter` beats. */
function barIndexes(count: number, first: number, meter: number): Set<number> {
  const starts = new Set<number>();
  for (let index = 0; index < count; index++) if ((((index - first) % meter) + meter) % meter === 0) starts.add(index);
  return starts;
}

/**
 * Beat and bar times of `timeline.tempo`: the measured grid of the music clip's beats file carried through the clip,
 * a nominal grid riding on the clip, or a nominal grid on the timeline clock. `grid` is null with `problem` set when
 * the beats are not there yet (a clip without a beats file), and null with no problem when no `tempo` is set. Throws
 * `InvalidProjectFile` (from `beatsOf`) for a broken beats file.
 */
export async function tempoGrid(input: TempoInput): Promise<TempoResult> {
  const { timeline, fps } = input;
  const tempo = timeline.tempo;
  if (!tempo) return { grid: null, problem: null };
  const frames = new FrameGrid(fps);
  if (tempo.clip === undefined) return { grid: nominalGrid(tempo, fps, input.horizon, frames), problem: null };
  const clip = findMusicClip(timeline, tempo.clip);
  if (!clip) return { grid: null, problem: `tempo follows clip ${tempo.clip}, which is not a media clip of the timeline.` };
  const speed = clip.speed ?? 1;
  if (tempo.bpm !== undefined) return { grid: nominalClipGrid(tempo, clip, speed, fps, frames), problem: null };

  const file = await input.beatsOf(clip.asset);
  if (!file) return { grid: null, problem: `${clip.asset} has no beat grid yet: run \`frameshell beats measure ${clip.asset}\`.` };
  const effective = effectiveBeatGrid(file);
  const starts = barIndexes(effective.beats.length, effective.downbeat, effective.meter);
  const beats: number[] = [];
  const bars: number[] = [];
  let beatBase = 0;
  let barBase = 0;
  let last = -1;
  effective.beats.forEach((time, index) => {
    // Half a frame of slack at the clip's edges: a beat on the first or last frame belongs to the clip.
    if (time < clip.in - 0.5 / fps) {
      beatBase++;
      if (starts.has(index)) barBase++;
      return;
    }
    if (time >= clip.out - 0.5 / fps || beats.length >= MAX_GRID_BEATS) return;
    const frame = frames.frame(clip.start + (time - clip.in) / speed);
    const seconds = frames.seconds(frame);
    if (frame === last) {
      // Two beats on one frame (a very fast grid): keep one beat, but never lose a bar start that was the second of them.
      if (starts.has(index) && bars.at(-1) !== seconds) bars.push(seconds);
      return;
    }
    last = frame;
    beats.push(seconds);
    if (starts.has(index)) bars.push(seconds);
  });
  const grid: TimelineGrid = {
    source: "beats",
    bpm: Math.round(effective.bpm * speed * 100) / 100,
    meter: effective.meter,
    clip: clip.id,
    asset: clip.asset,
    confidence: file.confidence,
    low: isLowConfidence(file),
    beats,
    bars,
    beatBase,
    barBase,
  };
  return { grid, problem: null };
}

/** A nominal grid on the timeline clock: beat `i` at `offset + 60 i / bpm`, each frame rounded once from the index. */
function nominalGrid(tempo: Tempo, fps: number, horizon: number, frames: FrameGrid): TimelineGrid {
  const bpm = tempo.bpm!;
  const meter = tempo.meter ?? 4;
  const offset = tempo.offset ?? 0;
  const until = horizon + (Math.max(NOMINAL_TAIL_BEATS, meter) * 60) / bpm;
  const beats: number[] = [];
  const bars: number[] = [];
  for (let index = 0; index < MAX_GRID_BEATS; index++) {
    const frame = nominalBeatFrame(index, bpm, fps, offset);
    if (frames.seconds(frame) > until) break;
    beats.push(frames.seconds(frame));
    if (index % meter === 0) bars.push(frames.seconds(frame));
  }
  return { source: "nominal", bpm, meter, low: false, beats, bars, beatBase: 0, barBase: 0 };
}

/** A nominal grid riding on a music clip: source second `offset + 60 i / bpm` mapped through the clip, beats inside it only. */
function nominalClipGrid(tempo: Tempo, clip: MediaClip, speed: number, fps: number, frames: FrameGrid): TimelineGrid {
  const bpm = tempo.bpm!;
  const meter = tempo.meter ?? 4;
  const offset = tempo.offset ?? 0;
  // Beat i is timeline second `first + 60 i / (bpm * speed)`: the same form `nominalBeatFrame` rounds once.
  const first = clip.start + (offset - clip.in) / speed;
  const beats: number[] = [];
  const bars: number[] = [];
  const startFrame = frames.frame(clip.start);
  const endFrame = frames.frame(clip.start + (clip.out - clip.in) / speed);
  let beatBase = 0;
  let barBase = 0;
  for (let index = 0; index < MAX_GRID_BEATS; index++) {
    const frame = nominalBeatFrame(index, bpm * speed, fps, first);
    if (frame >= endFrame) break;
    if (frame < startFrame) {
      beatBase++;
      if (index % meter === 0) barBase++;
      continue;
    }
    beats.push(frames.seconds(frame));
    if (index % meter === 0) bars.push(frames.seconds(frame));
  }
  return { source: "nominal", bpm: Math.round(bpm * speed * 100) / 100, meter, clip: clip.id, asset: clip.asset, low: false, beats, bars, beatBase, barBase };
}

/** The beat or bar of `grid` nearest to `seconds`; the earlier one on a tie. Throws when the grid has none within a beat of it. */
export function nearestBeat(grid: TimelineGrid, seconds: number, kind: GridKind): number {
  const list = kind === "bar" ? grid.bars : grid.beats;
  if (list.length === 0) throw new TimeRefError(`the timeline's grid has no ${kind === "bar" ? "bar starts" : "beats"} to snap to.`);
  let low = 0;
  let high = list.length - 1;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (list[mid]! < seconds) low = mid + 1;
    else high = mid;
  }
  const after = list[low]!;
  const before = low > 0 ? list[low - 1]! : after;
  const best = Math.abs(before - seconds) <= Math.abs(after - seconds) ? before : after;
  const reach = Math.max(60 / grid.bpm, 0.1) * (kind === "bar" ? grid.meter : 1);
  if (Math.abs(best - seconds) > reach) {
    throw new TimeRefError(`${seconds} s is outside the grid, which runs from ${list[0]} s to ${list[list.length - 1]} s.`, "Snap a time inside the music, or set a nominal tempo with `tempo.set` { bpm }.");
  }
  return best;
}

/** Arguments of {@link snapRequest}. */
export interface SnapContext {
  /** The timeline the operation applies to, in the state it sees. */
  timeline: Timeline;
  fps: number;
  snapTo: SnapToKind;
  beatsOf: TempoInput["beatsOf"];
}

/**
 * The marker of `timeline` nearest to `seconds` within {@link MARKER_SNAP_REACH_S}; the earlier one on a tie.
 * `except` is a marker id never offered (the marker a `marker.set` moves). Throws when there is none in reach.
 */
export function nearestMarker(timeline: Pick<Timeline, "markers">, seconds: number, except?: string): number {
  const times = (timeline.markers ?? []).filter((marker) => marker.id !== except).map((marker) => marker.at).sort((a, b) => a - b);
  if (times.length === 0) throw new TimeRefError("the timeline has no marker to snap to.", "Add one with `marker.add`.");
  const best = times.reduce((near, time) => (Math.abs(time - seconds) < Math.abs(near - seconds) ? time : near));
  if (Math.abs(best - seconds) > MARKER_SNAP_REACH_S) {
    throw new TimeRefError(`${seconds} s is more than ${MARKER_SNAP_REACH_S} s from the nearest marker (at ${best} s).`, "Give a time closer to a marker, or name the marker (`--at hook`).");
  }
  return best;
}

/**
 * `request` with every time argument of its operation (the {@link TIME_REF_FIELDS} table) resolved and moved to the
 * nearest beat or bar of the timeline's grid, or the nearest marker (`snapTo`, ADR 0029 decision 6). A `cut` or `clip.trim` that is snapped
 * to the beat goes exactly there, so pause snapping is off unless the caller asked for it. Throws `RpcError`
 * `InvalidOperation` (reason `snap`) when the timeline has no usable grid, the grid is LOW confidence or a time is
 * outside it. `marker` needs no tempo: it fails when no marker is within {@link MARKER_SNAP_REACH_S}.
 */
export async function snapRequest(request: OperationRequest, context: SnapContext): Promise<OperationRequest> {
  const fields: readonly string[] | undefined = (TIME_REF_FIELDS as Partial<Record<string, readonly string[]>>)[request.op];
  const args = request.args as Record<string, unknown>;
  const given = (fields ?? []).filter((field) => args[field] !== undefined);
  const refuse = (message: string, hint?: string) =>
    new RpcError(ErrorCode.InvalidOperation, `${request.op}: snapTo: ${message}`, { op: request.op, field: "snapTo", reason: "snap", ...(hint ? { hint } : {}) });
  if (given.length === 0) throw refuse(`${request.op} has no time argument to snap.`, `It snaps ${(fields ?? []).join(", ") || "nothing"}.`);
  const resolved: Record<string, number> = {};
  const loadGrid = (horizon: number) => tempoGrid({ fps: context.fps, timeline: context.timeline, horizon, beatsOf: context.beatsOf });
  for (const field of given) {
    try {
      resolved[field] = await resolveTimeRefAsync(args[field] as number | string, context.timeline, loadGrid);
    } catch (error) {
      if (!(error instanceof TimeRefError)) throw error;
      throw new RpcError(ErrorCode.InvalidOperation, `${request.op}: ${field}: ${error.message}`, { op: request.op, field, reason: "time reference", ...(error.hint ? { hint: error.hint } : {}) });
    }
  }
  const snapTo = context.snapTo;
  if (snapTo === "marker") {
    const self = request.op === "marker.set" && typeof args["marker"] === "string" ? findMarker(context.timeline.markers, args["marker"])?.id : undefined;
    return withSnapped(request, args, given, (field) => {
      try {
        return nearestMarker(context.timeline, resolved[field]!, self);
      } catch (error) {
        if (!(error instanceof TimeRefError)) throw error;
        throw refuse(`${field}: ${error.message}`, error.hint);
      }
    });
  }
  const { grid, problem } = await tempoGrid({
    fps: context.fps,
    timeline: context.timeline,
    horizon: Math.max(...Object.values(resolved)),
    beatsOf: context.beatsOf,
  });
  const unusable = unusableGrid({ grid, problem });
  if (unusable) throw refuse(unusable.message, unusable.hint);
  const usable = grid as TimelineGrid;
  return withSnapped(request, args, given, (field) => {
    try {
      return nearestBeat(usable,resolved[field]!, snapTo);
    } catch (error) {
      if (!(error instanceof TimeRefError)) throw error;
      throw refuse(`${field}: ${error.message}`, error.hint);
    }
  });
}

/** `request` with each of `fields` replaced by `land(field)`; a `cut` or `clip.trim` then goes exactly there (pause snapping off unless asked). */
function withSnapped(request: OperationRequest, args: Record<string, unknown>, fields: string[], land: (field: string) => number): OperationRequest {
  const next: Record<string, unknown> = { ...args };
  for (const field of fields) next[field] = land(field);
  if ((request.op === "cut" || request.op === "clip.trim") && next["snap"] === undefined) next["snap"] = false;
  return { op: request.op, args: next } as OperationRequest;
}
