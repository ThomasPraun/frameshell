import { ErrorCode, RpcError, type SnapToKind, TIME_REF_FIELDS } from "@frameshell/protocol";
import { type BeatsFile, type MediaClip, type Tempo, type Timeline, effectiveBeatGrid, isLowConfidence, nominalBeatFrame } from "@frameshell/schema";
import { isMediaClip } from "../segment/cutout.js";
import { FrameGrid } from "./grid.js";
import { TimeRefError, resolveTimeRef } from "./time-ref.js";
import type { OperationRequest } from "./engine.js";

/**
 * The timeline's beat grid on the timeline clock (ADR 0029 slice 3): the one place `tempo` turns into beat and bar
 * times, read by `tempo.show`, `timeline.show` with `grid` (the app paints it) and `--snap-to`. Pure apart from the
 * injected beats file lookup.
 */

/** Most beats one grid lists; a nominal grid over hours at a high tempo stops here. */
export const MAX_GRID_BEATS = 20_000;

/** How far past a nominal grid's last requested time it is built, beats. */
const NOMINAL_TAIL_BEATS = 2;

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

/** The media clip `tempo.clip` names, with the track kind it sits on; undefined when it is gone. */
function musicClip(timeline: Pick<Timeline, "tracks">, id: string): MediaClip | undefined {
  for (const track of timeline.tracks) {
    if (track.kind !== "video" && track.kind !== "audio") continue;
    const clip = track.clips.find((candidate) => candidate.id === id);
    if (clip && isMediaClip(clip)) return clip;
  }
  return undefined;
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
  const clip = musicClip(timeline, tempo.clip);
  if (!clip) return { grid: null, problem: `tempo follows clip ${tempo.clip}, which is not a media clip of the timeline.` };
  const speed = clip.speed ?? 1;
  if (tempo.bpm !== undefined) return { grid: nominalClipGrid(tempo, clip, speed, fps, frames), problem: null };

  const file = await input.beatsOf(clip.asset);
  if (!file) return { grid: null, problem: `${clip.asset} has no beat grid yet: run \`frameshell beats measure ${clip.asset}\`.` };
  const effective = effectiveBeatGrid(file);
  const starts = barIndexes(effective.beats.length, effective.downbeat, effective.meter);
  const beats: number[] = [];
  const bars: number[] = [];
  let last = -1;
  effective.beats.forEach((time, index) => {
    // Half a frame of slack at the clip's edges: a beat on the first or last frame belongs to the clip.
    if (time < clip.in - 0.5 / fps || time >= clip.out - 0.5 / fps || beats.length >= MAX_GRID_BEATS) return;
    const frame = frames.frame(clip.start + (time - clip.in) / speed);
    if (frame === last) return;
    last = frame;
    beats.push(frames.seconds(frame));
    if (starts.has(index)) bars.push(frames.seconds(frame));
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
  };
  return { grid, problem: null };
}

/** A nominal grid on the timeline clock: beat `i` at `offset + 60 i / bpm`, each frame rounded once from the index. */
function nominalGrid(tempo: Tempo, fps: number, horizon: number, frames: FrameGrid): TimelineGrid {
  const bpm = tempo.bpm!;
  const meter = tempo.meter ?? 4;
  const offset = tempo.offset ?? 0;
  const until = horizon + (NOMINAL_TAIL_BEATS * 60) / bpm;
  const beats: number[] = [];
  const bars: number[] = [];
  for (let index = 0; index < MAX_GRID_BEATS; index++) {
    const frame = nominalBeatFrame(index, bpm, fps, offset);
    if (frames.seconds(frame) > until) break;
    beats.push(frames.seconds(frame));
    if (index % meter === 0) bars.push(frames.seconds(frame));
  }
  return { source: "nominal", bpm, meter, low: false, beats, bars };
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
  for (let index = 0; index < MAX_GRID_BEATS; index++) {
    const frame = nominalBeatFrame(index, bpm * speed, fps, first);
    if (frame >= endFrame) break;
    if (frame < startFrame) continue;
    beats.push(frames.seconds(frame));
    if (index % meter === 0) bars.push(frames.seconds(frame));
  }
  return { source: "nominal", bpm: Math.round(bpm * speed * 100) / 100, meter, clip: clip.id, asset: clip.asset, low: false, beats, bars };
}

/** The beat or bar of `grid` nearest to `seconds`; the earlier one on a tie. Throws when the grid has none within a beat of it. */
export function nearestBeat(grid: TimelineGrid, seconds: number, kind: SnapToKind): number {
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
 * `request` with every time argument of its operation (the {@link TIME_REF_FIELDS} table) resolved and moved to the
 * nearest beat or bar of the timeline's grid (`snapTo`, ADR 0029 decision 6). A `cut` or `clip.trim` that is snapped
 * to the beat goes exactly there, so pause snapping is off unless the caller asked for it. Throws `RpcError`
 * `InvalidOperation` (reason `snap`) when the timeline has no usable grid, the grid is LOW confidence or a time is
 * outside it.
 */
export async function snapRequest(request: OperationRequest, context: SnapContext): Promise<OperationRequest> {
  const fields: readonly string[] | undefined = (TIME_REF_FIELDS as Partial<Record<string, readonly string[]>>)[request.op];
  const args = request.args as Record<string, unknown>;
  const given = (fields ?? []).filter((field) => args[field] !== undefined);
  const refuse = (message: string, hint?: string) =>
    new RpcError(ErrorCode.InvalidOperation, `${request.op}: snapTo: ${message}`, { op: request.op, field: "snapTo", reason: "snap", ...(hint ? { hint } : {}) });
  if (given.length === 0) throw refuse(`${request.op} has no time argument to snap.`, `It snaps ${(fields ?? []).join(", ") || "nothing"}.`);
  const resolved: Record<string, number> = {};
  for (const field of given) {
    try {
      resolved[field] = resolveTimeRef(args[field] as number | string, { timeline: context.timeline });
    } catch (error) {
      if (!(error instanceof TimeRefError)) throw error;
      throw new RpcError(ErrorCode.InvalidOperation, `${request.op}: ${field}: ${error.message}`, { op: request.op, field, reason: "time reference", ...(error.hint ? { hint: error.hint } : {}) });
    }
  }
  const { grid, problem } = await tempoGrid({
    fps: context.fps,
    timeline: context.timeline,
    horizon: Math.max(...Object.values(resolved)),
    beatsOf: context.beatsOf,
  });
  if (!grid) {
    throw refuse(problem ?? "the timeline has no tempo.", problem ? undefined : "Set one with `tempo.set` { clip } (a measured music clip) or { bpm } (a nominal grid).");
  }
  if (grid.low) {
    throw refuse(
      `the grid of ${grid.asset} is LOW confidence (${grid.confidence}): it may be double time or a bar off.`,
      `Check it with \`beats.show\`, then correct it with \`edits.tempo\` or \`edits.downbeat\` in its beats file, or measure again with a \`bpm\` hint.`,
    );
  }
  const next: Record<string, unknown> = { ...args };
  for (const field of given) {
    try {
      next[field] = nearestBeat(grid, resolved[field]!, context.snapTo);
    } catch (error) {
      if (!(error instanceof TimeRefError)) throw error;
      throw refuse(`${field}: ${error.message}`, error.hint);
    }
  }
  if ((request.op === "cut" || request.op === "clip.trim") && next["snap"] === undefined) next["snap"] = false;
  return { op: request.op, args: next } as OperationRequest;
}
