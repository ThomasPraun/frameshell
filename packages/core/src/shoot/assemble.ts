import type { ShootStatusResult } from "@frameshell/protocol";
import type { AnyClip, ClipTrack, MediaClip, Timeline } from "@frameshell/schema";
import type { OperationRequest } from "../timeline/engine.js";

/**
 * First cut of a shoot (ADR 0023 decision 6), as ordinary timeline operations. Per scene, the chosen
 * take's span from its first to its last line, restarts and long pauses cut out, edges with a handle.
 * Scenes go in script order. A scene is replaced in place: its old clips (those carrying one of the
 * shoot's takes and the scene's `scriptRef`) are removed, what follows moves by the change in length,
 * and the new clips are added. Clips the person or an agent placed are never removed.
 */

/** Seconds of take kept around the first and last word, and around a long pause cut out (ADR 0023). */
export const ASSEMBLE_HANDLE_S = 0.15;
/** Pieces shorter than this are dropped: a breath between two cuts, not a shot. */
const MIN_PIECE_S = 0.1;
/** Edge difference still taken as the same placement: energy snapping moves edges by up to a window. */
const SAME_EDGE_S = 0.75;
/** Room made for snapped edges before adding a scene's clips, per clip; closed again afterwards. */
const SNAP_ROOM_S = 1.5;

/** Source range of one clip of a scene. */
export interface PlannedPiece {
  in: number;
  out: number;
}

/** What one scene should hold. */
export interface ScenePlan {
  slug: string;
  title: string;
  ref: string;
  take: string | null;
  asset: string | null;
  pieces: PlannedPiece[];
}

/** What {@link assembleShoot} did to one scene. */
export interface SceneOutcome {
  slug: string;
  take: string | null;
  /** `placed`: new clips; `unchanged`: already as planned; `removed`: old clips taken out, no take covers it; `none`: nothing to do. */
  action: "placed" | "unchanged" | "removed" | "none";
  clips: string[];
}

/** What {@link assembleShoot} needs from the daemon. */
export interface AssembleDeps {
  /** The timeline as the caller sees it now. */
  load(): Promise<Timeline>;
  /** Apply one operation in the run's transaction; returns the ids it added. */
  apply(request: OperationRequest): Promise<{ added: string[] }>;
  /** Whether a project file has a video stream. */
  hasVideo(asset: string): Promise<boolean>;
}

/** The plan of every scene from `status`: pieces of the chosen take, with restarts and pauses cut out. */
export function planScenes(status: ShootStatusResult): ScenePlan[] {
  const takes = new Map(status.takes.map((take) => [take.id, take]));
  return status.scenes.map((scene) => {
    const take = scene.chosen ? takes.get(scene.chosen) : undefined;
    const none = { slug: scene.slug, title: scene.title, ref: scene.ref, take: null, asset: null, pieces: [] };
    if (!take) return none;
    const said = take.lines.filter((line) => line.scene === scene.slug && line.status !== "outside" && line.at !== null).map((line) => line.at!);
    if (said.length === 0) return none;
    const start = Math.min(...said.map((at) => at.start));
    const end = Math.max(...said.map((at) => at.end));
    const cuts = take.deviations
      .filter((d) => d.scene === scene.slug && (d.kind === "restart" || d.kind === "pause") && d.at !== null)
      .map((d) => ({ kind: d.kind, start: d.at!.start, end: d.at!.end }))
      .filter((cut) => cut.end > start && cut.start < end)
      .sort((a, b) => a.start - b.start);
    const pieces: PlannedPiece[] = [];
    let from = Math.max(0, start - ASSEMBLE_HANDLE_S);
    for (const cut of cuts) {
      // A pause keeps a handle of silence on both sides; a restart is speech, cut at its words.
      const pad = cut.kind === "pause" ? ASSEMBLE_HANDLE_S : 0;
      const to = Math.min(cut.start + pad, cut.end);
      if (to - from >= MIN_PIECE_S) pieces.push({ in: round(from), out: round(to) });
      from = Math.max(from, cut.end - pad);
    }
    const last = end + ASSEMBLE_HANDLE_S;
    if (last - from >= MIN_PIECE_S) pieces.push({ in: round(from), out: round(last) });
    return { slug: scene.slug, title: scene.title, ref: scene.ref, take: take.id, asset: take.asset, pieces: merge(pieces) };
  });
}

/**
 * Bring the timeline in line with `plans` for the scenes in `only` (all when null), in script
 * order. `takes` are every take id of the shoot: clips carrying one of them belong to the assembly.
 */
export async function assembleShoot(plans: readonly ScenePlan[], only: ReadonlySet<string> | null, takes: ReadonlySet<string>, deps: AssembleDeps, snap: boolean): Promise<SceneOutcome[]> {
  const outcomes: SceneOutcome[] = [];
  for (const [index, plan] of plans.entries()) {
    if (only !== null && !only.has(plan.slug)) continue;
    const timeline = await deps.load();
    const own = sceneClips(timeline, plan.ref, takes);
    if (plan.take === null && own.length === 0) {
      outcomes.push({ slug: plan.slug, take: null, action: "none", clips: [] });
      continue;
    }
    if (plan.take !== null && same(own, plan)) {
      outcomes.push({ slug: plan.slug, take: plan.take, action: "unchanged", clips: own.map(({ clip }) => clip.id) });
      continue;
    }
    // Where the scene goes: where its clips were, else right after the scenes before it.
    const earlier = new Set(plans.slice(0, index).map((other) => other.ref));
    const before = clipTracksOf(timeline).flatMap((track) => track.clips).filter((clip) => isAssembled(clip, takes) && clip.scriptRef !== undefined && earlier.has(clip.scriptRef));
    const at = own.length > 0 ? Math.min(...own.map(({ clip }) => clip.start)) : Math.max(0, ...before.map(end));
    const oldEnd = own.length > 0 ? Math.max(...own.map(({ clip }) => end(clip))) : at;
    const trackHint = own[0]?.track ?? null;
    for (const { clip } of own) await deps.apply({ op: "clip.remove", args: { clip: clip.id } } as OperationRequest);

    if (plan.take === null || plan.asset === null) {
      await shiftAfter(deps, oldEnd, at - oldEnd, new Set());
      outcomes.push({ slug: plan.slug, take: null, action: "removed", clips: [] });
      continue;
    }
    const length = plan.pieces.reduce((sum, piece) => sum + piece.out - piece.in, 0);
    const room = snap ? SNAP_ROOM_S * plan.pieces.length : 0;
    const moved = await shiftAfter(deps, oldEnd, at + length + room - oldEnd, new Set());
    const track = trackHint ?? (await shootTrack(deps, plan.asset, takes));
    const added: string[] = [];
    let cursor = at;
    for (const piece of plan.pieces) {
      const args = { track, type: "media", asset: plan.asset, start: cursor, in: piece.in, out: piece.out, scriptRef: plan.ref, take: plan.take, ...(snap ? { snap: true } : {}) };
      const result = await deps.apply({ op: "clip.add", args } as OperationRequest);
      const id = result.added[0]!;
      added.push(id);
      const placed = clipTracksOf(await deps.load()).flatMap((t) => t.clips).find((clip) => clip.id === id)!;
      cursor = end(placed);
    }
    // Close the room left for snapping: what followed now starts where the scene ends.
    const followerStart = moved.length > 0 ? Math.min(...moved.map((m) => m.start)) : null;
    if (followerStart !== null && followerStart > cursor) await shiftAfter(deps, followerStart, cursor - followerStart, new Set(added));
    outcomes.push({ slug: plan.slug, take: plan.take, action: "placed", clips: added });
  }
  return outcomes;
}

/** Clips of the scene's earlier assembly, by start, with their track. */
function sceneClips(timeline: Timeline, ref: string, takes: ReadonlySet<string>): { clip: AnyClip; track: string }[] {
  return clipTracksOf(timeline)
    .flatMap((track) => track.clips.map((clip) => ({ clip, track: track.id })))
    .filter(({ clip }) => isAssembled(clip, takes) && clip.scriptRef === ref)
    .sort((a, b) => a.clip.start - b.clip.start);
}

/** True when the scene's clips already hold its plan: same take, same pieces within snapping. */
function same(own: readonly { clip: AnyClip }[], plan: ScenePlan): boolean {
  if (own.length !== plan.pieces.length) return false;
  return own.every(({ clip }, i) => {
    if (clip.type !== "media") return false;
    const media = clip as MediaClip;
    if (media.take !== plan.take || media.asset !== plan.asset) return false;
    const piece = plan.pieces[i]!;
    return Math.abs(media.in - piece.in) <= SAME_EDGE_S && Math.abs(media.out - piece.out) <= SAME_EDGE_S;
  });
}

/**
 * Move every clip of the video and audio tracks starting at or after `from` by `delta` seconds,
 * in an order that never overlaps two clips; `skip` stays. Returns the moved clips' new starts.
 */
async function shiftAfter(deps: AssembleDeps, from: number, delta: number, skip: ReadonlySet<string>): Promise<{ id: string; start: number }[]> {
  if (Math.abs(delta) < 1e-6) return [];
  const timeline = await deps.load();
  const later = clipTracksOf(timeline)
    .flatMap((track) => track.clips)
    .filter((clip) => clip.start >= from - 1e-6 && !skip.has(clip.id))
    .sort((a, b) => (delta > 0 ? b.start - a.start : a.start - b.start));
  const moved: { id: string; start: number }[] = [];
  for (const clip of later) {
    const start = Math.max(0, clip.start + delta);
    await deps.apply({ op: "clip.move", args: { clip: clip.id, start } } as OperationRequest);
    moved.push({ id: clip.id, start });
  }
  return moved;
}

/** The track the shoot's clips of this kind already use, else a new one named `Shoot`. */
async function shootTrack(deps: AssembleDeps, asset: string, takes: ReadonlySet<string>): Promise<string> {
  const kind = (await deps.hasVideo(asset)) ? "video" : "audio";
  const timeline = await deps.load();
  const used = clipTracksOf(timeline).find((track) => track.kind === kind && track.clips.some((clip) => isAssembled(clip, takes)));
  if (used) return used.id;
  const { added } = await deps.apply({ op: "track.add", args: { kind, name: kind === "video" ? "Shoot" : "Shoot audio" } } as OperationRequest);
  return added[0]!;
}

function isAssembled(clip: AnyClip, takes: ReadonlySet<string>): boolean {
  const take = "take" in clip ? clip.take : undefined;
  return take !== undefined && takes.has(take);
}

function clipTracksOf(timeline: Timeline): ClipTrack[] {
  return timeline.tracks.filter((track): track is ClipTrack => track.kind === "video" || track.kind === "audio");
}

function end(clip: AnyClip): number {
  if (clip.type === "media") {
    const media = clip as MediaClip;
    return media.start + (media.out - media.in) / (media.speed ?? 1);
  }
  return clip.start + ("duration" in clip && typeof clip.duration === "number" ? clip.duration : 0);
}

function merge(pieces: PlannedPiece[]): PlannedPiece[] {
  const out: PlannedPiece[] = [];
  for (const piece of pieces) {
    const last = out.at(-1);
    if (last && piece.in <= last.out) last.out = Math.max(last.out, piece.out);
    else out.push({ ...piece });
  }
  return out;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
