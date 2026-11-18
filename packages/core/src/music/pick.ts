import { ErrorCode, type MusicPickResult, RpcError } from "@frameshell/protocol";
import type { Clip, ClipTrack, Timeline } from "@frameshell/schema";
import { MUSIC_TRACK_NAME } from "../sound/music-place.js";
import type { OperationRequest } from "../timeline/engine.js";
import { CANDIDATE_TRACK_NAME } from "./candidates.js";

/** What `music.pick` was asked. */
export interface MusicPickRequest {
  /** Track id (`t_…`) or name (`Music 2`) of the candidate to keep. */
  track: string;
  /** Leave the other candidates in place, muted, instead of removing them. */
  keep?: boolean | undefined;
}

/** The pick before anything is written: the report and the operations that make it, in order. */
export interface MusicPickPlan {
  report: Omit<MusicPickResult, "timeline" | "revision" | "dryRun" | "applied" | "tx">;
  requests: OperationRequest[];
}

const invalid = (message: string, data: Record<string, unknown>) => new RpcError(ErrorCode.InvalidOperation, `music.pick: ${message}`, { op: "music.pick", ...data });

const NEXT =
  "The winner keeps the gain, fit and shaping the candidates wrote. Fit it to the cut with `music fit <clip> --end <time>` and set its level under the voice with `duck <track> --under <voice track> --level style`.";

/** `Music pick: Music 2`. */
export function musicPickLabel(plan: Pick<MusicPickPlan["report"], "chosen">): string {
  return `Music pick: ${plan.chosen.name}`;
}

/**
 * Keeps one candidate of `music.candidates` and clears the others (ADR 0037): the chosen audio track is unmuted and renamed
 * `Music`, the other candidate tracks are removed with their clip (`keep`: muted and left in place). A candidate is an audio track
 * named like `candidateName` that holds only media clips. A track a person worked on (more than one clip, or a clip with speed,
 * keys, effects, fades or transitions) is never removed: it is left in place and named. Reads only; the daemon writes
 * `requests` in one transaction. Throws TrackNotFound, or InvalidOperation (the track is not a candidate, or none is left to pick between).
 */
export function planMusicPick(timeline: Timeline, request: MusicPickRequest): MusicPickPlan {
  const chosen = findTrack(timeline, request.track);
  const rest = timeline.tracks.filter((track): track is ClipTrack => track !== chosen && isCandidate(track));
  if (!isCandidate(chosen)) {
    throw invalid(`${label(chosen)} is not a candidate track: it must be an audio track named like \`Music 2\` that holds only media clips.`, {
      reason: "not a candidate",
      field: "track",
      hint: candidateHint(timeline),
    });
  }
  if (rest.length === 0) {
    throw invalid(`${label(chosen)} has no other candidate to pick between.`, { reason: "no other candidate", field: "track", hint: "`music candidates` places the tracks to choose from." });
  }

  const warnings: string[] = [];
  const requests: OperationRequest[] = [];
  const clash = timeline.tracks.some((track) => track !== chosen && track.name === MUSIC_TRACK_NAME);
  if (clash) warnings.push(`A track named ${MUSIC_TRACK_NAME} already exists: ${label(chosen)} keeps its name.`);
  const set = { track: chosen.id, ...(chosen.muted === true ? { muted: false } : {}), ...(clash ? {} : { name: MUSIC_TRACK_NAME }) };
  if (Object.keys(set).length > 1) requests.push({ op: "track.set", args: set } as OperationRequest);

  const removed: MusicPickPlan["report"]["removed"] = [];
  const muted: MusicPickPlan["report"]["muted"] = [];
  const left: MusicPickPlan["report"]["left"] = [];
  for (const track of rest) {
    const entry = { track: track.id, name: track.name ?? track.id, asset: assetOf(track) };
    if (request.keep === true) {
      if (track.muted !== true) requests.push({ op: "track.set", args: { track: track.id, muted: true } } as OperationRequest);
      muted.push(entry);
      continue;
    }
    const why = editedReason(timeline, track);
    if (why !== null) {
      left.push({ ...entry, reason: why });
      warnings.push(`${entry.name} (${track.id}) is left in place: ${why} Remove it yourself with \`track remove ${track.id} --force\` when you do not need it.`);
      continue;
    }
    requests.push({ op: "track.remove", args: { track: track.id, force: true } } as OperationRequest);
    removed.push(entry);
  }
  // A candidate-looking track that is not one (`Music 3` holding a title) is not touched either way: say so.
  for (const track of timeline.tracks) {
    if (track !== chosen && !isCandidate(track) && track.name !== undefined && CANDIDATE_TRACK_NAME.test(track.name)) {
      warnings.push(`${track.name} (${track.id}) is not an audio track of media clips only, so it is not a candidate and is left as it is.`);
    }
  }
  if (requests.length === 0) warnings.push("Nothing to change: the track is already unmuted and the others are in place.");

  const clip = chosen.clips[0] as Clip | undefined;
  return {
    report: {
      chosen: { track: chosen.id, name: chosen.name ?? chosen.id, asset: assetOf(chosen), clip: chosen.clips.length === 1 ? (clip?.id ?? null) : null, renamedTo: clash ? null : MUSIC_TRACK_NAME, unmuted: chosen.muted === true },
      keep: request.keep === true,
      removed,
      muted,
      left,
      next: NEXT,
      warnings,
    },
    requests,
  };
}

/** The track `ref` names: an id, else a name (`Music 2`). Throws TrackNotFound; InvalidOperation when a name is on several tracks. */
function findTrack(timeline: Timeline, ref: string) {
  const byId = timeline.tracks.find((track) => track.id === ref);
  if (byId) return byId;
  const byName = timeline.tracks.filter((track) => track.name === ref);
  if (byName.length > 1) {
    throw invalid(`${byName.length} tracks are named "${ref}": ${byName.map((track) => track.id).join(", ")}.`, { reason: "ambiguous name", field: "track", hint: "Pass the track id." });
  }
  if (byName[0]) return byName[0];
  throw new RpcError(ErrorCode.TrackNotFound, `music.pick: no track "${ref}" in timeline ${timeline.id}.`, {
    op: "music.pick",
    track: ref,
    available: timeline.tracks.map((track) => `${track.id}${track.name ? ` (${track.name})` : ""}`),
    hint: candidateHint(timeline),
  });
}

/** An audio track named like a candidate that holds only media clips, at least one. */
function isCandidate(track: Timeline["tracks"][number]): track is ClipTrack {
  return track.kind === "audio" && track.name !== undefined && CANDIDATE_TRACK_NAME.test(track.name) && track.clips.length > 0 && track.clips.every((clip) => clip.type === "media");
}

const candidateHint = (timeline: Timeline) => {
  const names = timeline.tracks.filter(isCandidate).map((track) => `${track.name} (${track.id})`);
  return names.length > 0 ? `Candidates: ${names.join(", ")}.` : "There are no candidate tracks: `music candidates` places them.";
};

const label = (track: Timeline["tracks"][number]) => `${track.name ?? track.id} (${track.id})`;
const assetOf = (track: ClipTrack) => (track.clips[0] as { asset?: string } | undefined)?.asset ?? "";

/** Fields `music.candidates` writes on its clip (`music.fit` moves `start` and `in`); anything else is somebody's work. */
const WRITTEN_CLIP_FIELDS = new Set(["id", "start", "type", "asset", "in", "out", "audio"]);
const WRITTEN_AUDIO_FIELDS = new Set(["gain", "fadeInMs"]);

/** Why `track` must not be removed, or null when it holds only what `music.candidates` placed. */
function editedReason(timeline: Timeline, track: ClipTrack): string | null {
  const follower = timeline.tracks.find((other) => other.kind === "subtitles" && other.follows === track.id);
  if (follower) return `the subtitle track ${follower.id} follows it.`;
  if (track.clips.length !== 1) return `it holds ${track.clips.length} clips, not the one that was placed.`;
  const clip = track.clips[0] as Record<string, unknown>;
  const extra = Object.keys(clip).filter((key) => !WRITTEN_CLIP_FIELDS.has(key));
  const audio = Object.keys((clip["audio"] ?? {}) as Record<string, unknown>).filter((key) => !WRITTEN_AUDIO_FIELDS.has(key));
  const changed = [...extra, ...audio.map((key) => `audio.${key}`)];
  if (changed.length > 0) return `its clip was edited (${changed.join(", ")}).`;
  return null;
}
