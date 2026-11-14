import { ErrorCode, type MusicGridCut, type MusicGridResult, RpcError } from "@frameshell/protocol";
import { type AnyClip, type AnyClipTrack, type MediaClip, type Timeline, isShotClip } from "@frameshell/schema";
import type { OperationRequest } from "../timeline/engine.js";
import { FrameGrid } from "../timeline/grid.js";
import { type TimelineGrid, nearestBeat } from "../timeline/tempo.js";
import { type GridLoader, TimeRefError, unusableGrid } from "../timeline/time-ref.js";
import { type MusicFitPlan, planDuckAgain } from "./run.js";

/**
 * Grid moves of `music.grid` (#485 slice 5, ADR 0037): picture cuts moved onto the timeline's beat grid by ripple trims of
 * the clip before each cut. Every cut gets an absolute target (its beat, or where it is), so a move followed by a cut that
 * stays changes only the shots between them, like a roll. Each cut's operations are tried on the engine in memory first
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
  /** Move ids (`g1`…) to leave out, and `duck`. */
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
}

/** Two clips of one video track that meet on a frame. */
interface Cut {
  at: number;
  frame: number;
  track: string;
  out: string;
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

  const cuts = findCuts(timeline, spans, frames);
  // A track with a clip across a cut keeps its timing: rippling it would open a gap or an overlap behind that clip.
  const crossing = (track: AnyClipTrack) =>
    (track.clips as readonly AnyClip[]).some((clip) => {
      const span = spans.get(clip.id);
      return span !== undefined && cuts.some((cut) => frames.frame(span.start) < cut.frame && cut.frame < frames.frame(span.end));
    });
  const ripple = tracks.filter((track) => !crossing(track)).map((track) => track.id);

  const report: MusicGridCut[] = [];
  let next = 0;
  for (const cut of cuts) {
    const entry: MusicGridCut = { id: null, at: cut.at, track: cut.track, out: cut.out, in: cut.in, beat: null, ref: null, shiftMs: null, status: "outside", reason: null, landsAt: cut.at, warnings: [] };
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
  const unknown = [...skip].filter((id) => id !== "duck" && !moveIds.includes(id));
  if (unknown.length > 0) {
    throw invalid(`${unknown.join(", ")} ${unknown.length === 1 ? "is" : "are"} not a move.`, {
      reason: "skip",
      field: "skip",
      valid: [...moveIds, "duck"],
      hint: "Run a dry run with the same `to` and `maxShift` and skip ids from its `cuts`.",
    });
  }

  const requests: OperationRequest[] = [];
  const warnings: string[] = [];
  let current = timeline;
  for (const [index, cut] of cuts.entries()) {
    const entry = report[index]!;
    if (entry.id !== null && skip.has(entry.id)) entry.status = "skipped";
    const target = entry.status === "move" ? entry.beat! : cut.at;
    const between = { original: timeline, from: cut.frame, until: cuts[index + 1]?.frame ?? Number.POSITIVE_INFINITY };
    const tried = await tryCut(current, cut, target, { frames, ripple, deps, between });
    entry.warnings.push(...tried.warnings);
    if (tried.ok) {
      current = tried.timeline;
      requests.push(...tried.requests);
      entry.landsAt = round3(target);
      continue;
    }
    entry.landsAt = round3(tried.at);
    if (entry.status === "move") {
      entry.status = "blocked";
      entry.reason = tried.reason;
    } else {
      entry.warnings.push(`It moved ${ms(tried.at - cut.at)} ms with the cuts before it and cannot be put back: ${tried.reason}`);
      entry.warnings.push(...(await syncSlips(current, between, frames, deps)).map((slip) => `So ${slip}, up to the next cut.`));
    }
  }

  const moved = report.filter((entry) => entry.status === "move").length;
  let durationChange = 0;
  if (requests.length > 0) {
    durationChange = round3((await pictureEnd(current, deps)) - (await pictureEnd(timeline, deps)));
    warnings.push(...afterMoves(timeline, report, grid, frames));
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

  return {
    to: request.to,
    maxShift: request.maxShift,
    grid: { source: grid.source, bpm: grid.bpm, meter: grid.meter, clip: grid.clip ?? null, confidence: grid.confidence ?? null },
    cuts: report,
    moved,
    ripple,
    durationChange,
    duck,
    warnings,
    requests,
    duckAgain,
  };
}

/** `Music grid: 3 cuts onto beats`. */
export function musicGridLabel(plan: Pick<GridMovesPlan, "moved" | "to">): string {
  return `Music grid: ${plan.moved} ${plan.moved === 1 ? "cut" : "cuts"} onto ${plan.to === "bar" ? "bar starts" : "beats"}`;
}

/** Cuts of the video tracks in time order: two clips of a track that meet on a frame. On one frame the first track in order names it. */
function findCuts(timeline: Timeline, spans: ReadonlyMap<string, { start: number; end: number }>, frames: FrameGrid): Cut[] {
  const byFrame = new Map<number, Cut>();
  for (const track of timeline.tracks) {
    if (track.kind !== "video") continue;
    const clips = [...(track.clips as readonly AnyClip[])].filter((clip) => spans.has(clip.id)).sort((a, b) => a.start - b.start);
    for (let index = 1; index < clips.length; index++) {
      const [before, after] = [clips[index - 1]!, clips[index]!];
      const frame = frames.frame(after.start);
      if (frames.frame(spans.get(before.id)!.end) !== frame || byFrame.has(frame)) continue;
      byFrame.set(frame, { at: frames.seconds(frame), frame, track: track.id, out: before.id, in: after.id });
    }
  }
  return [...byFrame.values()].sort((a, b) => a.frame - b.frame);
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
 * Put `cut` on timeline second `target` in `timeline` (as earlier cuts left it): a ripple trim of the clip before the
 * cut over the `ripple` tracks, and plain trims of the clips of those tracks that end with it, each applied in memory.
 * Refused when the cut is gone, a shot would be trimmed, the engine refuses, a word would be cut, dropped or added, or a
 * clip of `between` would slip against its own sound (`syncSlips`).
 */
async function tryCut(
  timeline: Timeline,
  cut: Cut,
  target: number,
  context: { frames: FrameGrid; ripple: readonly string[]; deps: GridMovesDeps; between: Between },
): Promise<Tried> {
  const { frames, ripple, deps } = context;
  const warnings: string[] = [];
  const lead = findClip(timeline, cut.out);
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
  for (const track of timeline.tracks.filter(isClipTrack)) {
    if (track.id === lead.track.id) continue;
    for (const clip of track.clips as readonly AnyClip[]) {
      const end = await deps.end(clip).catch(() => null);
      if (end === null) continue;
      const meets = frames.frame(end) === frame;
      if (ripple.includes(track.id)) {
        if (!meets) continue;
        if (isShotClip(clip)) return { ok: false, at, reason: `shot ${clip.id} of program track ${track.id} ends at the cut; grid moves do not trim multicam shots.`, warnings };
        followers.push({ track, clip });
      } else if (meets || frames.frame(clip.start) === frame) {
        warnings.push(
          `${clip.id} on ${track.id} ${meets ? "ends" : "starts"} on the cut, but its track keeps its timing (a clip on it runs across a cut): ` +
            `it stays where it is, so ${incoming.clip.id}, the shot after the cut, starts ${Math.abs(ms(shift))} ms ${shift < 0 ? "before" : "after"} it ` +
            `${meets ? "ends" : "starts"} and plays that much out of sync with it.`,
        );
      }
    }
  }

  const trimmed = [lead, ...followers];
  const leadRequest = {
    op: "clip.trim",
    args: { clip: lead.clip.id, end: frames.seconds(goal), snap: false, ripple: true, rippleTracks: ripple.length > 0 ? [...ripple] : [lead.track.id] },
  } as OperationRequest;
  const followerRequests = followers.map(({ clip }) => ({ op: "clip.trim", args: { clip: clip.id, end: frames.seconds(goal), snap: false } }) as OperationRequest);
  // Shorter: the followers first, so the clips after the cut never overlap them; longer: the ripple first makes the room.
  const requests = shift < 0 ? [...followerRequests, leadRequest] : [leadRequest, ...followerRequests];
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
    if (!after || after.out === clip.out) continue;
    if (track.kind !== "audio" && !(await deps.hasAudio(clip.asset))) continue;
    const words = await deps.words(clip.asset);
    if (typeof words === "string") {
      warnings.push(`${clip.id} (${clip.asset}) has sound but ${words === "no-transcript" ? "no transcript" : "a transcript older than the file"}: its ${shift < 0 ? "cut" : "added"} end was not checked for words.`);
      continue;
    }
    const [from, to] = [Math.min(clip.out, after.out), Math.max(clip.out, after.out)];
    const hit = words.filter((word) => word.start < to - WORD_EPSILON_S && word.end > from + WORD_EPSILON_S);
    if (hit.length > 0) {
      const said = hit.map((word) => `"${word.text}"`).join(" ");
      const what = shift < 0 ? `would cut ${said} from the end of ${clip.id}` : `would add ${said} to the end of ${clip.id}`;
      return { ok: false, at, reason: `${what} (${clip.asset} ${round3(from)}–${round3(to)} s).`, warnings };
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

/** Warnings about what stays while the cuts move: markers on a moved cut, and music shape hits whose shot moved. */
function afterMoves(timeline: Timeline, report: readonly MusicGridCut[], grid: TimelineGrid, frames: FrameGrid): string[] {
  const warnings: string[] = [];
  const shifted = report.filter((entry) => frames.frame(entry.landsAt) !== frames.frame(entry.at));
  for (const marker of timeline.markers ?? []) {
    const on = shifted.find((entry) => frames.frame(entry.at) === frames.frame(marker.at));
    if (on) warnings.push(`Marker "${marker.label}" stays at ${marker.at} s; the cut it was on moved to ${on.landsAt} s (\`marker set ${marker.id} --at ${on.landsAt}\`).`);
  }
  const shape = grid.clip === undefined ? undefined : findMedia(timeline, grid.clip)?.clip.audio?.shape;
  // Content between two cuts moves with the first of them.
  const shiftAt = (time: number) => {
    const last = [...report].reverse().find((entry) => entry.at <= time);
    return last ? last.landsAt - last.at : 0;
  };
  const moved = (shape?.drops ?? []).filter((drop) => frames.frame(drop + shiftAt(drop)) !== frames.frame(drop));
  if (moved.length > 0) {
    warnings.push(`The music steps down before hits at ${moved.join(", ")} s (\`music shape\`), which moved with their shots: run \`music shape\` again with their new times.`);
  }
  return warnings;
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
