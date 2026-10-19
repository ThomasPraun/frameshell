import { isDeepStrictEqual } from "node:util";
import type { TimelinePatch } from "@frameshell/protocol";
import type { AnyClip, AnyClipTrack, MulticamGroup, Timeline, Track } from "@frameshell/schema";

/**
 * Patch turning `from` into `to`, at clip granularity: whole tracks only when
 * a track appears, disappears or its own fields change; whole multicam groups.
 * Diffing makes every operation's inverse correct by construction
 * (`diff(after, before)`).
 */
export function diffTimelines(from: Timeline, to: Timeline): TimelinePatch {
  const groups: NonNullable<TimelinePatch["groups"]> = [];
  const groupsAfter = new Map((to.groups ?? []).map((group) => [group.id, group]));
  for (const group of from.groups ?? []) if (!groupsAfter.has(group.id)) groups.push({ id: group.id, group: null });
  for (const group of to.groups ?? []) {
    const before = from.groups?.find((candidate) => candidate.id === group.id);
    if (!before || !isDeepStrictEqual(before, group)) groups.push({ id: group.id, group });
  }
  const tracks: NonNullable<TimelinePatch["tracks"]> = [];
  const deletions: NonNullable<TimelinePatch["clips"]> = [];
  const upserts: NonNullable<TimelinePatch["clips"]> = [];
  const toIds = new Set(to.tracks.map((track) => track.id));
  for (const track of from.tracks) if (!toIds.has(track.id)) tracks.push({ id: track.id, track: null });
  for (const track of to.tracks) {
    const before = from.tracks.find((candidate) => candidate.id === track.id);
    if (!before || !isDeepStrictEqual(header(before), header(track))) {
      if (!before || !isDeepStrictEqual(before, track)) tracks.push({ id: track.id, track });
      continue;
    }
    if (track.kind === "subtitles" || before.kind === "subtitles") continue;
    const clipsAfter = new Map(track.clips.map((clip) => [clip.id, clip]));
    for (const clip of before.clips) if (!clipsAfter.has(clip.id)) deletions.push({ track: track.id, id: clip.id, clip: null });
    for (const clip of track.clips) {
      const old = before.clips.find((candidate) => candidate.id === clip.id);
      if (!old || !isDeepStrictEqual(old, clip)) upserts.push({ track: track.id, id: clip.id, clip });
    }
  }
  const patch: TimelinePatch = {};
  if (groups.length > 0) patch.groups = groups;
  if (tracks.length > 0) patch.tracks = tracks;
  // Deletions first: a clip moving between tracks is never in two places after the patch.
  if (deletions.length + upserts.length > 0) patch.clips = [...deletions, ...upserts];
  const order = to.tracks.map((track) => track.id);
  if (!isDeepStrictEqual(applyPatch(from, patch).tracks.map((track) => track.id), order)) patch.order = order;
  return structuredClone(patch);
}

/** True when `patch` changes nothing. */
export function isEmptyPatch(patch: TimelinePatch): boolean {
  return !patch.groups && !patch.tracks && !patch.clips && !patch.order;
}

/**
 * Apply `patch` to a copy of `timeline` (revision untouched). Clips stay
 * sorted by start; `groups` disappears when the last group goes. Throws
 * when the patch names a missing or subtitle track, or `order` is not a
 * permutation of the resulting tracks. Whether a clip suits its track kind
 * is left to the timeline schema.
 */
export function applyPatch(timeline: Timeline, patch: TimelinePatch): Timeline {
  const next = structuredClone(timeline);
  if (patch.groups) {
    const groups: MulticamGroup[] = next.groups ?? [];
    for (const { id, group } of patch.groups) {
      const index = groups.findIndex((candidate) => candidate.id === id);
      if (group === null) {
        if (index !== -1) groups.splice(index, 1);
      } else if (index === -1) {
        groups.push(structuredClone(group));
      } else {
        groups[index] = structuredClone(group);
      }
    }
    if (groups.length > 0) next.groups = groups;
    else delete next.groups;
  }
  for (const { id, track } of patch.tracks ?? []) {
    const index = next.tracks.findIndex((candidate) => candidate.id === id);
    if (track === null) {
      if (index !== -1) next.tracks.splice(index, 1);
    } else if (index === -1) {
      next.tracks.push(structuredClone(track));
    } else {
      next.tracks[index] = structuredClone(track);
    }
  }
  const touched = new Set<AnyClipTrack>();
  for (const { track: trackId, id, clip } of patch.clips ?? []) {
    const track = next.tracks.find((candidate) => candidate.id === trackId);
    if (!track || track.kind === "subtitles") throw new Error(`patch names clip track "${trackId}", which does not exist`);
    const clips: AnyClip[] = track.clips;
    const index = clips.findIndex((candidate) => candidate.id === id);
    if (clip === null) {
      if (index !== -1) clips.splice(index, 1);
    } else if (index === -1) {
      clips.push(structuredClone(clip));
    } else {
      clips[index] = structuredClone(clip);
    }
    touched.add(track);
  }
  for (const track of touched) sortClips(track);
  if (patch.order) {
    const byId = new Map(next.tracks.map((track) => [track.id, track]));
    if (patch.order.length !== byId.size || patch.order.some((id) => !byId.has(id))) {
      throw new Error(`patch order [${patch.order.join(", ")}] does not list the timeline's tracks exactly`);
    }
    next.tracks = patch.order.map((id) => byId.get(id)!);
  }
  return next;
}

/** Canonical clip order: by start, then id. */
export function sortClips(track: { clips: AnyClip[] }): void {
  track.clips.sort((a, b) => a.start - b.start || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Track fields other than its clips. */
function header(track: Track): Omit<Track, "clips"> {
  if (track.kind === "subtitles") return track;
  const { clips: _clips, ...rest } = track;
  return rest;
}
