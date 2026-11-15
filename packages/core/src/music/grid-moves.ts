import { ErrorCode, type MusicGridCut, type MusicGridResult, RpcError } from "@frameshell/protocol";
import { type AnyClip, type AnyClipTrack, type AudioEffect, type MediaClip, type ShapeSettings, type Timeline, isShotClip } from "@frameshell/schema";
import type { DipPoint } from "../media/duck.js";
import type { OperationRequest } from "../timeline/engine.js";
import { FrameGrid } from "../timeline/grid.js";
import { type TimelineGrid, nearestBeat } from "../timeline/tempo.js";
import { type GridLoader, TimeRefError, unusableGrid } from "../timeline/time-ref.js";
import { planBuildEffects } from "./builds.js";
import { clipEnd as fileClipEnd } from "./fit.js";
import { type MusicFitPlan, planDuckAgain } from "./run.js";
import { shapeCurve } from "./shape.js";

/**
 * Grid moves of `music.grid` (#485 slice 5, ADR 0037): picture cuts moved onto the timeline's beat grid by ripple trims of
 * the clip before each cut (or, with `trim: "head"` and for program tracks, by roll edits: the tail before the cut and the
 * head after it). Entries of clips alone on upper video tracks move whole. Every cut gets an absolute target (its beat, or
 * where it is), so a move followed by a cut that stays changes only the shots between them, like a roll. Each operation is tried on the engine in memory first
 * (`apply`), so a move the engine would refuse is reported as blocked and the rest still go; the daemon writes the
 * operations that passed, in order, as one transaction.
 */

/** What `music.grid` needs from the project. */
export interface GridMovesDeps {
  /** The timeline's beat grid (`tempoGrid`) up to `horizon`. */
  loadGrid: GridLoader;
  /** Apply one operation to `timeline` in memory with the engine's checks; nothing is written. Throws the engine's `RpcError`. */
  apply(timeline: Timeline, request: OperationRequest): Promise<{ timeline: Timeline; warnings: string[] }>;
  /** Timeline second just after a clip's last frame (`clipEnd`); throws when a nested timeline's length cannot be derived. */
  end(clip: AnyClip): Promise<number>;
  /** Words of a project-relative asset in source seconds, or why it has none to check. */
  words(asset: string): Promise<readonly GridWord[] | "no-transcript" | "stale-transcript">;
  /** Whether a project-relative asset has an audio stream. */
  hasAudio(asset: string): Promise<boolean>;
}

/** A transcript word in source seconds, as the person corrected it. */
export interface GridWord {
  /** The word as the person corrected it, else as transcribed. */
  text: string;
  /** Source seconds. */
  start: number;
  /** Source seconds. */
  end: number;
}

/** What `music.grid` was asked for, defaults filled in. */
export interface GridMovesRequest {
  /** Land cuts on beats or on bar starts. */
  to: "beat" | "bar";
  /** Farthest a cut moves, seconds. */
  maxShift: number;
  /** `tail`: ripple trim of the clip before a video cut. `head`: a roll edit (tail before, head after, nothing ripples). Default `tail`. */
  trim?: "tail" | "head" | undefined;
  /** `all` (default): also program-track shot changes and upper-track entries. `video`: video-track cuts only. */
  tracks?: "all" | "video" | undefined;
  /** Move ids (`g1`…) to leave out, `duck` and `shape`. */
  skip?: readonly string[] | undefined;
  /** Nothing is written: warnings say what would happen. */
  dryRun?: boolean | undefined;
}

/** Grid moves before anything is written. */
export interface GridMovesPlan extends Omit<MusicGridResult, "timeline" | "revision" | "dryRun" | "applied" | "tx"> {
  /** Operations to apply in order; empty when no cut changes. */
  requests: OperationRequest[];
  /** Duck to run again after them (the voice moved under ducked music); null when none runs. */
  duckAgain: MusicFitPlan["duckAgain"];
  /** `music.shape` to run again after them, before the duck (the hits moved with their shots); null when none runs. */
  shapeAgain: { clip: string; curve: DipPoint[]; settings: ShapeSettings; effects: AudioEffect[] | null | undefined } | null;
}

/** What the grid moves: a cut of two clips that meet on a frame, or the first frame of a clip alone on an upper track. */
interface Cut {
  kind: MusicGridCut["kind"];
  at: number;
  frame: number;
  track: string;
  /** Clip before the cut; null for an entry. */
  out: string | null;
  /** Clip after the cut, or the entry's clip. */
  in: string;
}

/** Slack for comparing source seconds of words and clip edges (stored with 3 decimals). */
const WORD_EPSILON_S = 0.001;

const invalid = (message: string, data: Record<string, unknown>) => new RpcError(ErrorCode.InvalidOperation, `music.grid: ${message}`, { op: "music.grid", ...data });
const round3 = (value: number) => Math.round(value * 1000) / 1000;
const ms = (seconds: number) => Math.round(seconds * 1000);
const isClipTrack = (track: Timeline["tracks"][number]): track is AnyClipTrack => track.kind !== "subtitles";

/**
 * The grid moves for `timeline` (ADR 0037 slice 5): its picture cuts, the nearest beat of each, and the clip trims that
 * land the moves, each tried in memory. Reads only. Throws InvalidOperation for a timeline with no usable grid or a `skip`
 * id that is no move.
 */
export async function planGridMoves(timeline: Timeline, fps: number, request: GridMovesRequest, deps: GridMovesDeps): Promise<GridMovesPlan> {
  const frames = new FrameGrid(fps);
  const trim = request.trim ?? "tail";
  const scope = request.tracks ?? "all";
  const tracks = timeline.tracks.filter(isClipTrack);
  const spans = new Map<string, { start: number; end: number }>();
  for (const track of tracks) {
    for (const clip of track.clips as readonly AnyClip[]) {
      const end = await deps.end(clip).catch(() => null);
      if (end !== null) spans.set(clip.id, { start: clip.start, end });
    }
  }
  const timelineEnd = Math.max(0, ...[...spans.values()].map((span) => span.end));
  const found = await deps.loadGrid(timelineEnd + request.maxShift);
  const unusable = unusableGrid(found);
  if (unusable) throw invalid(unusable.message, { reason: "grid", ...(unusable.hint ? { hint: unusable.hint } : {}) });
  const grid = found.grid as TimelineGrid;
  const music = grid.clip === undefined ? null : (spans.get(grid.clip) ?? null);

  const cuts = findCuts(timeline, spans, frames, scope);
  const betweenCuts = cuts.filter((cut) => cut.kind !== "entry");
  // A track with a clip across a cut keeps its timing: rippling it would open a gap or an overlap behind that clip.
  const crossing = (track: AnyClipTrack) =>
    (track.clips as readonly AnyClip[]).some((clip) => {
      const span = spans.get(clip.id);
      return span !== undefined && betweenCuts.some((cut) => frames.frame(span.start) < cut.frame && cut.frame < frames.frame(span.end));
    });
  const ripple = tracks.filter((track) => !crossing(track)).map((track) => track.id);

  const report: MusicGridCut[] = [];
  let next = 0;
  for (const cut of cuts) {
    const entry: MusicGridCut = { id: null, kind: cut.kind, at: cut.at, track: cut.track, out: cut.out, in: cut.in, beat: null, ref: null, shiftMs: null, status: "outside", reason: null, landsAt: cut.at, warnings: [] };
    report.push(entry);
    if (music && !(music.start < cut.at && cut.at < music.end)) {
      // Only a cut the music runs across leaves the music, and its beats, where they are.
      entry.reason = `the music clip ${grid.clip} (${round3(music.start)}–${round3(music.end)} s) does not run across it.`;
      continue;
    }
    let beat: number;
    try {
      beat = nearestBeat(grid, cut.at, request.to);
    } catch (error) {
      if (!(error instanceof TimeRefError)) throw error;
      entry.reason = error.message;
      continue;
    }
    Object.assign(entry, { beat, ref: refOf(grid, beat, request.to), shiftMs: ms(beat - cut.at) });
    if (frames.frame(beat) === cut.frame) {
      entry.status = "on-grid";
      continue;
    }
    if (Math.abs(beat - cut.at) > request.maxShift + 1e-9) {
      entry.status = "far";
      entry.reason = `${Math.abs(ms(beat - cut.at))} ms from ${entry.ref}, more than maxShift ${request.maxShift} s.`;
      continue;
    }
    entry.id = `g${++next}`;
    entry.status = "move";
  }
  const moveIds = report.flatMap((entry) => (entry.id ? [entry.id] : []));
  const skip = new Set(request.skip ?? []);
  const unknown = [...skip].filter((id) => id !== "duck" && id !== "shape" && !moveIds.includes(id));
  if (unknown.length > 0) {
    throw invalid(`${unknown.join(", ")} ${unknown.length === 1 ? "is" : "are"} not a move.`, {
      reason: "skip",
      field: "skip",
      valid: [...moveIds, "duck", "shape"],
      hint: "Run a dry run with the same `to`, `trim`, `tracks` and `maxShift` and skip ids from its `cuts`.",
    });
  }

  const requests: OperationRequest[] = [];
  const warnings: string[] = [];
  let current = timeline;
  for (const [index, cut] of cuts.entries()) {
    const entry = report[index]!;
    if (entry.id !== null && skip.has(entry.id)) entry.status = "skipped";
    const settled = (tried: Tried, target: number) => {
      entry.warnings.push(...tried.warnings);
      if (tried.ok) {
        current = tried.timeline;
        requests.push(...tried.requests);
        entry.landsAt = round3(target);
        return true;
      }
      entry.landsAt = round3(tried.at);
      if (entry.status === "move") {
        entry.status = "blocked";
        entry.reason = tried.reason;
      }
      return false;
    };
    if (cut.kind === "entry") {
      // A clip alone on an upper track keeps its place unless it moves onto a beat (or already sits on one, which a ripple of
      // the cuts before it could have knocked off): a title that follows its shot is not pulled back to where it was.
      const target = entry.status === "move" ? entry.beat! : entry.status === "on-grid" ? cut.at : null;
      if (target === null) continue;
      const tried = await tryEntry(current, cut, target, { frames, deps, original: timeline });
      if (!settled(tried, target) && !tried.ok && entry.status !== "blocked") entry.warnings.push(`It moved ${ms(tried.at - cut.at)} ms with the cuts before it and cannot be put back: ${tried.reason}`);
      continue;
    }
    const target = entry.status === "move" ? entry.beat! : cut.at;
    const upcoming = cuts.slice(index + 1).find((later) => later.kind !== "entry");
    const between = { original: timeline, from: cut.frame, until: upcoming?.frame ?? Number.POSITIVE_INFINITY };
    const roll = trim === "head" || cut.kind === "program";
    const tried = await tryCut(current, cut, target, { frames, ripple, deps, between, roll });
    if (!settled(tried, target) && !tried.ok && entry.status !== "blocked") {
      entry.warnings.push(`It moved ${ms(tried.at - cut.at)} ms with the cuts before it and cannot be put back: ${tried.reason}`);
      entry.warnings.push(...(await syncSlips(current, between, frames, deps)).map((slip) => `So ${slip}, up to the next cut.`));
    }
  }
  // An entry nobody tried stayed where the ripple of the cuts before it left it.
  for (const [index, cut] of cuts.entries()) {
    if (cut.kind !== "entry" || report[index]!.status === "move" || report[index]!.status === "on-grid") continue;
    const left = findClip(current, cut.in);
    if (left) report[index]!.landsAt = round3(left.clip.start);
  }

  const moved = report.filter((entry) => entry.status === "move").length;
  let durationChange = 0;
  if (requests.length > 0) {
    durationChange = round3((await pictureEnd(current, deps)) - (await pictureEnd(timeline, deps)));
    warnings.push(...afterMoves(timeline, report, frames));
  }

  let duck: GridMovesPlan["duck"] = null;
  let duckAgain: GridMovesPlan["duckAgain"] = null;
  const musicClip = grid.clip === undefined ? null : findMedia(timeline, grid.clip);
  if (requests.length > 0 && musicClip && musicClip.clip.keys?.gain?.some((key) => key.auto === "duck") === true) {
    const rerun = planDuckAgain(timeline, musicClip.track, musicClip.clip, { skipped: skip.has("duck"), dryRun: request.dryRun === true });
    warnings.push(rerun.warning.replace("which no longer line up with the voice", "which no longer line up with the voice that moved with the cuts"));
    duck = rerun.duck;
    duckAgain = rerun.duckAgain;
  }

  let shape: GridMovesPlan["shape"] = null;
  let shapeAgain: GridMovesPlan["shapeAgain"] = null;
  if (requests.length > 0 && trim === "tail" && musicClip) {
    const carried = carryDrops({ report, frames, clip: musicClip.clip, rippled: ripple.includes(musicClip.track), skipped: skip.has("shape"), duck, dryRun: request.dryRun === true, warnings });
    shape = carried.shape;
    shapeAgain = carried.shapeAgain;
  }

  return {
    to: request.to,
    maxShift: request.maxShift,
    trim,
    tracks: scope,
    grid: { source: grid.source, bpm: grid.bpm, meter: grid.meter, clip: grid.clip ?? null, confidence: grid.confidence ?? null },
    cuts: report,
    moved,
    ripple,
    durationChange,
    duck,
    shape,
    warnings,
    requests,
    duckAgain,
    shapeAgain,
  };
}

/** `Music grid: 3 cuts onto beats`. */
export function musicGridLabel(plan: Pick<GridMovesPlan, "moved" | "to">): string {
  return `Music grid: ${plan.moved} ${plan.moved === 1 ? "cut" : "cuts"} onto ${plan.to === "bar" ? "bar starts" : "beats"}`;
}

/**
 * Cuts of the video tracks (and with `all` the shot changes of program tracks) in time order: two clips of a track that
 * meet on a frame; on one frame the first track in order names it. With `all`, after the cuts of a frame, the entries of
 * the upper video tracks: a clip alone on a track (nothing meets its start or its end), not at 0, on a track above the
 * lowest picture track (a title or an overlay appearing).
 */
function findCuts(timeline: Timeline, spans: ReadonlyMap<string, { start: number; end: number }>, frames: FrameGrid, scope: "all" | "video"): Cut[] {
  const byFrame = new Map<number, Cut>();
  for (const track of timeline.tracks) {
    if (track.kind !== "video" && !(scope === "all" && track.kind === "program")) continue;
    const clips = [...(track.clips as readonly AnyClip[])].filter((clip) => spans.has(clip.id)).sort((a, b) => a.start - b.start);
    for (let index = 1; index < clips.length; index++) {
      const [before, after] = [clips[index - 1]!, clips[index]!];
      const frame = frames.frame(after.start);
      if (frames.frame(spans.get(before.id)!.end) !== frame || byFrame.has(frame)) continue;
      byFrame.set(frame, { kind: track.kind === "program" ? "program" : "cut", at: frames.seconds(frame), frame, track: track.id, out: before.id, in: after.id });
    }
  }
  const entries: Cut[] = [];
  if (scope === "all") {
    const base = timeline.tracks.find((track) => track.kind === "video" || track.kind === "program");
    for (const track of timeline.tracks) {
      if (track.kind !== "video" || track === base) continue;
      const clips = (track.clips as readonly AnyClip[]).filter((clip) => spans.has(clip.id));
      for (const clip of clips) {
        const [start, end] = [frames.frame(clip.start), frames.frame(spans.get(clip.id)!.end)];
        const touching = clips.some((other) => other !== clip && (frames.frame(spans.get(other.id)!.end) === start || frames.frame(other.start) === end));
        if (start > 0 && !touching) entries.push({ kind: "entry", at: frames.seconds(start), frame: start, track: track.id, out: null, in: clip.id });
      }
    }
  }
  return [...byFrame.values(), ...entries].sort((a, b) => a.frame - b.frame || (a.kind === "entry" ? 1 : 0) - (b.kind === "entry" ? 1 : 0));
}

/** The `beat:N` / `bar:N` reference of a grid time (counted in the music file, as the resolver reads them). */
function refOf(grid: TimelineGrid, time: number, kind: "beat" | "bar"): string {
  const list = kind === "bar" ? grid.bars : grid.beats;
  return `${kind}:${list.indexOf(time) + 1 + (kind === "bar" ? grid.barBase : grid.beatBase)}`;
}

/** Result of trying to put one cut on its target. */
type Tried =
  | { ok: true; timeline: Timeline; requests: OperationRequest[]; warnings: string[] }
  | { ok: false; at: number; reason: string; warnings: string[] };

/**
 * Put the entry clip of `entry` on timeline second `target` in `timeline` (as the cuts before it left it): one `clip.move`
 * applied in memory. Refused when the clip is gone, the engine refuses (an overlap), or the move would put it out of sync
 * with a clip of the same file it played in sync with (`syncSlips`).
 */
async function tryEntry(timeline: Timeline, entry: Cut, target: number, context: { frames: FrameGrid; deps: GridMovesDeps; original: Timeline }): Promise<Tried> {
  const { frames, deps } = context;
  const found = findClip(timeline, entry.in);
  if (!found) return { ok: false, at: entry.at, reason: `${entry.in} is no longer on the timeline.`, warnings: [] };
  const at = found.clip.start;
  const goal = frames.frame(target);
  if (frames.frame(at) === goal) return { ok: true, timeline, requests: [], warnings: [] };
  const request = { op: "clip.move", args: { clip: entry.in, start: frames.seconds(goal) } } as OperationRequest;
  let next: Timeline;
  try {
    next = (await deps.apply(timeline, request)).timeline;
  } catch (error) {
    if (!(error instanceof RpcError)) throw error;
    return { ok: false, at, reason: error.message, warnings: [] };
  }
  const slips = await syncSlips(next, { original: context.original, from: entry.frame, until: entry.frame + 1 }, frames, deps);
  if (slips.length > 0) return { ok: false, at, reason: `after the move ${slips.join("; ")}.`, warnings: [] };
  return { ok: true, timeline: next, requests: [request], warnings: [] };
}

/**
 * Put `cut` on timeline second `target` in `timeline` (as earlier cuts left it). Tail mode: a ripple trim of the clip
 * before the cut over the `ripple` tracks, and plain trims of the clips of those tracks that end with it. Roll mode (`head`,
 * and every program track): the tails of those clips and the heads of the clips that start at the cut are trimmed to the
 * target, nothing ripples and every shot keeps its own time. Each applied in memory. Refused when the cut is gone, a shot
 * would be trimmed in tail mode, the engine refuses, a word would be cut, dropped or added, or a clip of `between` would
 * slip against its own sound (`syncSlips`).
 */
async function tryCut(
  timeline: Timeline,
  cut: Cut,
  target: number,
  context: { frames: FrameGrid; ripple: readonly string[]; deps: GridMovesDeps; between: Between; roll: boolean },
): Promise<Tried> {
  const { frames, ripple, deps, roll } = context;
  const warnings: string[] = [];
  const lead = cut.out === null ? null : findClip(timeline, cut.out);
  const incoming = findClip(timeline, cut.in);
  if (!lead || !incoming) return { ok: false, at: cut.at, reason: `${lead ? cut.in : cut.out} is no longer on the timeline.`, warnings };
  const at = await deps.end(lead.clip);
  if (incoming.track.id !== lead.track.id || frames.frame(incoming.clip.start) !== frames.frame(at)) {
    return { ok: false, at, reason: `${cut.out} and ${cut.in} no longer meet.`, warnings };
  }
  const frame = frames.frame(at);
  const goal = frames.frame(target);
  if (goal === frame) return { ok: true, timeline, requests: [], warnings };
  const shift = frames.seconds(goal) - frames.seconds(frame);

  const followers: { track: AnyClipTrack; clip: AnyClip }[] = [];
  // Roll only: clips that start at the cut get their head trimmed with it, when their track cuts there too (the sound of the
  // shots) or is a sound track; a title or overlay that merely appears on the cut is an entry and moves whole on its own.
  const starting: { track: AnyClipTrack; clip: AnyClip }[] = [];
  const cutting = new Set<string>();
  for (const track of timeline.tracks.filter(isClipTrack)) {
    if (track.id === lead.track.id) continue;
    for (const clip of track.clips as readonly AnyClip[]) {
      const end = await deps.end(clip).catch(() => null);
      if (end === null) continue;
      const meets = frames.frame(end) === frame;
      if (ripple.includes(track.id)) {
        if (meets) {
          cutting.add(track.id);
          if (isShotClip(clip) && !roll) return { ok: false, at, reason: `shot ${clip.id} of program track ${track.id} ends at the cut; ripple moves do not trim multicam shots (a roll edit does: \`trim: head\`).`, warnings };
          followers.push({ track, clip });
        } else if (roll && frames.frame(clip.start) === frame) starting.push({ track, clip });
      } else if (!roll && (meets || frames.frame(clip.start) === frame)) {
        warnings.push(
          `${clip.id} on ${track.id} ${meets ? "ends" : "starts"} on the cut, but its track keeps its timing (a clip on it runs across a cut): ` +
            `it stays where it is, so ${incoming.clip.id}, the shot after the cut, starts ${Math.abs(ms(shift))} ms ${shift < 0 ? "before" : "after"} it ` +
            `${meets ? "ends" : "starts"} and plays that much out of sync with it.`,
        );
      }
    }
  }

  const starters = starting.filter(({ track }) => track.kind === "audio" || cutting.has(track.id));
  const at3 = frames.seconds(goal);
  let requests: OperationRequest[];
  if (roll) {
    const tails = [lead.clip, ...followers.map(({ clip }) => clip)].map((clip) => ({ op: "clip.trim", args: { clip: clip.id, end: at3, snap: false } }) as OperationRequest);
    const heads = [incoming.clip, ...starters.map(({ clip }) => clip)].map((clip) => ({ op: "clip.trim", args: { clip: clip.id, start: at3, snap: false } }) as OperationRequest);
    // Earlier: the tails give the room the heads grow into; later: the heads leave the room the tails grow into.
    requests = shift < 0 ? [...tails, ...heads] : [...heads, ...tails];
  } else {
    const leadRequest = {
      op: "clip.trim",
      args: { clip: lead.clip.id, end: at3, snap: false, ripple: true, rippleTracks: ripple.length > 0 ? [...ripple] : [lead.track.id] },
    } as OperationRequest;
    const followerRequests = followers.map(({ clip }) => ({ op: "clip.trim", args: { clip: clip.id, end: at3, snap: false } }) as OperationRequest);
    // Shorter: the followers first, so the clips after the cut never overlap them; longer: the ripple first makes the room.
    requests = shift < 0 ? [...followerRequests, leadRequest] : [leadRequest, ...followerRequests];
  }
  const trimmed = roll ? [lead, ...followers, incoming, ...starters] : [lead, ...followers];
  let next = timeline;
  try {
    for (const request of requests) next = (await deps.apply(next, request)).timeline;
  } catch (error) {
    if (!(error instanceof RpcError)) throw error;
    return { ok: false, at, reason: error.message, warnings };
  }

  for (const { track, clip } of trimmed) {
    if (!("asset" in clip) || clip.audio?.muted === true) continue;
    const after = findClip(next, clip.id)?.clip as MediaClip | undefined;
    if (!after || (after.out === clip.out && after.in === clip.in)) continue;
    if (track.kind !== "audio" && !(await deps.hasAudio(clip.asset))) continue;
    const words = await deps.words(clip.asset);
    if (typeof words === "string") {
      warnings.push(`${clip.id} (${clip.asset}) has sound but ${words === "no-transcript" ? "no transcript" : "a transcript older than the file"}: its trimmed edge was not checked for words.`);
      continue;
    }
    // Source seconds each trimmed edge gains (grows) or loses.
    const edges = [
      ...(after.out === clip.out ? [] : [{ side: "end", from: Math.min(clip.out, after.out), to: Math.max(clip.out, after.out), grew: after.out > clip.out }]),
      ...(after.in === clip.in ? [] : [{ side: "start", from: Math.min(clip.in, after.in), to: Math.max(clip.in, after.in), grew: after.in < clip.in }]),
    ];
    for (const edge of edges) {
      const hit = words.filter((word) => word.start < edge.to - WORD_EPSILON_S && word.end > edge.from + WORD_EPSILON_S);
      if (hit.length === 0) continue;
      const said = hit.map((word) => `"${word.text}"`).join(" ");
      const what = edge.grew ? `would add ${said} to the ${edge.side} of ${clip.id}` : `would cut ${said} from the ${edge.side} of ${clip.id}`;
      return { ok: false, at, reason: `${what} (${clip.asset} ${round3(edge.from)}–${round3(edge.to)} s).`, warnings };
    }
  }
  const slips = await syncSlips(next, context.between, frames, deps);
  if (slips.length > 0) return { ok: false, at, reason: `after the move ${slips.join("; ")}.`, warnings };
  return { ok: true, timeline: next, requests, warnings };
}

/** The clips a cut's move settles: those that started from `from` up to (not at) `until`, frames of the planned timeline. */
interface Between {
  original: Timeline;
  from: number;
  until: number;
}

/**
 * Clips of `between` (by their place in the planned timeline) that played in sync with a clip of the same file with sound
 * (same speed, same source second at the same timeline second, overlapping) and no longer do in `now`: a J or L cut whose
 * sound stays on a track that keeps its timing while its picture moved with the ripple.
 */
async function syncSlips(now: Timeline, between: Between, frames: FrameGrid, deps: Pick<GridMovesDeps, "end" | "hasAudio">): Promise<string[]> {
  const placed = async (state: Timeline) => {
    const list: { id: string; track: AnyClipTrack; clip: MediaClip; start: number; end: number; zero: number }[] = [];
    for (const track of state.tracks.filter(isClipTrack)) {
      for (const clip of track.clips as readonly AnyClip[]) {
        if (!("asset" in clip)) continue;
        const end = await deps.end(clip).catch(() => null);
        // Timeline second where the clip would show its file's second 0.
        if (end !== null) list.push({ id: clip.id, track, clip, start: clip.start, end, zero: clip.start - clip.in / (clip.speed ?? 1) });
      }
    }
    return list;
  };
  const before = await placed(between.original);
  const after = new Map((await placed(now)).map((entry) => [entry.id, entry]));
  const slips: string[] = [];
  const seen = new Set<string>();
  for (const moved of before) {
    const frame = frames.frame(moved.start);
    if (frame < between.from || frame >= between.until) continue;
    const movedNow = after.get(moved.id);
    // Only a clip that moved itself: its partner may start in the range and stay put while the clip is past `until`.
    if (!movedNow || frames.frame(movedNow.zero - moved.zero) === 0) continue;
    for (const partner of before) {
      if (partner.id === moved.id || partner.clip.asset !== moved.clip.asset || (partner.clip.speed ?? 1) !== (moved.clip.speed ?? 1)) continue;
      if (frames.frame(partner.zero) !== frames.frame(moved.zero) || partner.start >= moved.end || moved.start >= partner.end) continue;
      const partnerNow = after.get(partner.id);
      if (!partnerNow) continue;
      const drift = movedNow.zero - moved.zero - (partnerNow.zero - partner.zero);
      if (frames.frame(drift) === 0) continue;
      const key = [moved.id, partner.id].sort().join(" ");
      if (seen.has(key)) continue;
      const sounding = [moved, partner].some((entry) => entry.clip.audio?.muted !== true);
      const audible = moved.track.kind === "audio" || partner.track.kind === "audio" || (await deps.hasAudio(moved.clip.asset));
      if (!sounding || !audible) continue;
      seen.add(key);
      slips.push(
        `${moved.id} on ${moved.track.id} plays ${Math.abs(ms(drift))} ms ${drift > 0 ? "late" : "early"} against ${partner.id} on ${partner.track.id}, ` +
          `its own sound from ${moved.clip.asset} on a track that keeps its timing (a clip on it runs across a cut)`,
      );
    }
  }
  return slips;
}

/** Warnings about what stays while the cuts move: markers on a moved cut. */
function afterMoves(timeline: Timeline, report: readonly MusicGridCut[], frames: FrameGrid): string[] {
  const warnings: string[] = [];
  const shifted = report.filter((entry) => entry.kind !== "entry" && frames.frame(entry.landsAt) !== frames.frame(entry.at));
  for (const marker of timeline.markers ?? []) {
    const on = shifted.find((entry) => frames.frame(entry.at) === frames.frame(marker.at));
    if (on) warnings.push(`Marker "${marker.label}" stays at ${marker.at} s; the cut it was on moved to ${on.landsAt} s (\`marker set ${marker.id} --at ${on.landsAt}\`).`);
  }
  return warnings;
}

/**
 * The hits `music.shape` stored on the music clip (`audio.shape.drops`, timeline seconds of moments of the picture) that
 * moved with their shot: content between two ripple cuts moves with the first of them, so a hit goes where that cut went.
 * A hit that the move pushed past its shot's new end stays and is named in a warning. When the clip carries music keys
 * the shaping is planned again at the new times (keys and builds, like `music.fit` does after it moves the clip); where
 * it cannot run (skipped, the clip's track moved with the ripple, duck keys that would not be put back) the warning says to
 * run `music shape` again.
 */
function carryDrops(input: {
  report: readonly MusicGridCut[];
  frames: FrameGrid;
  clip: MediaClip;
  rippled: boolean;
  skipped: boolean;
  duck: GridMovesPlan["duck"];
  dryRun: boolean;
  warnings: string[];
}): { shape: GridMovesPlan["shape"]; shapeAgain: GridMovesPlan["shapeAgain"] } {
  const { report, clip, warnings } = input;
  const settings = clip.audio?.shape;
  const drops = settings?.drops ?? [];
  if (!settings || drops.length === 0) return { shape: null, shapeAgain: null };
  // Only a ripple cut carries what follows it: roll edits and entries leave every shot on its own time.
  const ripples = report.filter((entry) => entry.kind === "cut");
  const moved: { from: number; to: number }[] = [];
  const kept: number[] = [];
  const stuck: number[] = [];
  for (const drop of drops) {
    const index = ripples.findLastIndex((entry) => entry.at <= drop + 1e-6);
    const governing = ripples[index];
    const shift = governing ? governing.landsAt - governing.at : 0;
    if (!governing || input.frames.frame(shift) === 0) {
      kept.push(drop);
      continue;
    }
    const to = round3(drop + shift);
    const following = ripples[index + 1];
    if (following && to >= following.landsAt - 1e-6) {
      stuck.push(drop);
      kept.push(drop);
    } else {
      moved.push({ from: drop, to });
      kept.push(to);
    }
  }
  if (stuck.length > 0) {
    warnings.push(`The music steps down before hits at ${stuck.join(", ")} s (\`music shape\`): their shot got shorter than the move, so they stay where they were; run \`music shape\` again with their new times.`);
  }
  if (moved.length === 0) return { shape: null, shapeAgain: null };
  const shape = { clip: clip.id, drops: moved, rerun: false };
  const list = moved.map((drop) => `${drop.from} to ${drop.to} s`).join(", ");
  const keyed = clip.keys?.gain?.some((key) => key.auto === "music" || key.baseAuto === "music") === true;
  const ducked = clip.keys?.gain?.some((key) => key.auto === "duck") === true;
  const fallback = (why: string) => {
    warnings.push(`The music steps down before hits that moved with their shots (${list}) (\`music shape\`): ${why}; run \`music shape\` again with their new times.`);
    return { shape, shapeAgain: null };
  };
  if (!keyed) return fallback(`${clip.id} carries no music keys to move`);
  if (input.skipped) return fallback("skipped");
  if (input.rippled) return fallback(`${clip.id}'s track moved with the cuts too`);
  if (ducked && input.duck?.rerun !== true) return fallback("the duck keys could not be put back, and the shaping replaces them");
  const next: ShapeSettings = { ...settings, drops: [...new Set(kept)].sort((a, b) => a - b) };
  const { effects } = planBuildEffects(clip, next.drops ?? [], settings.build, warnings);
  const length = round3(fileClipEnd({ start: clip.start, in: clip.in, out: clip.out, speed: clip.speed ?? 1 }));
  warnings.push(`The music steps down before hits that moved with their shots (${list}): music shape ${input.dryRun ? "would run" : "ran"} again with the settings of its last run, at the new times.`);
  return { shape: { ...shape, rerun: true }, shapeAgain: { clip: clip.id, curve: shapeCurve(next, length), settings: next, effects } };
}

/** Timeline second after the last frame of picture (video and program tracks). */
async function pictureEnd(timeline: Timeline, deps: Pick<GridMovesDeps, "end">): Promise<number> {
  let end = 0;
  for (const track of timeline.tracks) {
    if (track.kind !== "video" && track.kind !== "program") continue;
    for (const clip of track.clips as readonly AnyClip[]) end = Math.max(end, (await deps.end(clip).catch(() => null)) ?? 0);
  }
  return end;
}

function findClip(timeline: Timeline, id: string): { track: AnyClipTrack; clip: AnyClip } | null {
  for (const track of timeline.tracks.filter(isClipTrack)) {
    const clip = (track.clips as readonly AnyClip[]).find((candidate) => candidate.id === id);
    if (clip) return { track, clip };
  }
  return null;
}

function findMedia(timeline: Timeline, id: string): { track: string; clip: MediaClip } | null {
  const found = findClip(timeline, id);
  return found && "asset" in found.clip ? { track: found.track.id, clip: found.clip } : null;
}
