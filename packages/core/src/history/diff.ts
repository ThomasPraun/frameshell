import { isDeepStrictEqual } from "node:util";
import { type ClipDiff, ErrorCode, type JournalEntry, RpcError } from "@frameshell/protocol";
import type { Clip, Timeline } from "@frameshell/schema";
import { applyPatch } from "../timeline/patch.js";
import { historyNotFound, journalGap } from "./revert.js";

/** A clip and the track holding it. */
export interface PlacedClip {
  track: string;
  clip: Clip;
}

/** One clip the target changed; see {@link planDiff}. */
export interface ClipChange {
  clip: string;
  change: ClipDiff["change"];
  /** Right before the target's first operation on the clip; null when it did not exist. */
  before: PlacedClip | null;
  /** Right after the target's last operation on the clip; null when it no longer existed. */
  after: PlacedClip | null;
}

/**
 * What a transaction (`tx_…`) or operation (`op_…`) did to clips (`history.diff`):
 * the journal is rewound from `current` through the stored inverses to the
 * states around each of the target's operations. Clips it changed and then
 * restored are left out. Order: as the target first changed them.
 *
 * Throws HistoryNotFound when no entry matches, and HistoryUnavailable when
 * the file changed outside the journal since the target (see `journalGap`):
 * rewinding across such a gap would report states that never existed.
 */
export function planDiff(current: Timeline, entries: JournalEntry[], target: string, timeline: string): ClipChange[] {
  const inTarget = (entry: JournalEntry) => entry.id === target || entry.tx === target;
  const first = entries.findIndex(inTarget);
  if (first === -1) throw historyNotFound(target, timeline);
  const tail = entries.slice(first);
  const gap = journalGap(current, tail);
  if (gap !== null) throw unavailable(target, timeline, `changed outside the journal ${gap}`);

  const before = new Map<string, PlacedClip | null>();
  const after = new Map<string, PlacedClip | null>();
  /** Clip ids of each target entry, oldest entry first once reversed. */
  const order: string[][] = [];
  let state = current;
  for (let i = tail.length - 1; i >= 0; i--) {
    const entry = tail[i]!;
    let previous: Timeline;
    try {
      previous = applyPatch(state, entry.inverse.args);
    } catch (error) {
      throw unavailable(target, timeline, `no longer matches the file at ${entry.id} (${(error as Error).message})`);
    }
    if (inTarget(entry)) {
      const ids = touchedClips(entry, previous, state);
      for (const id of ids) {
        // Walking back: the first `after` seen is the latest, the last `before` seen the earliest.
        if (!after.has(id)) after.set(id, locate(state, id));
        before.set(id, locate(previous, id));
      }
      order.push(ids);
    }
    state = previous;
  }

  const seen = new Set<string>();
  const changes: ClipChange[] = [];
  for (const id of order.reverse().flat()) {
    if (seen.has(id)) continue;
    seen.add(id);
    const change = classify(before.get(id) ?? null, after.get(id) ?? null);
    if (change) changes.push({ clip: id, change, before: before.get(id) ?? null, after: after.get(id) ?? null });
  }
  return changes;
}

/** Clip ids `entry` changed: its clip patches, and every clip of a track it replaced, before or after. */
function touchedClips(entry: JournalEntry, before: Timeline, after: Timeline): string[] {
  const patch = entry.inverse.args;
  const ids = (patch.clips ?? []).map((clip) => clip.id);
  for (const { id } of patch.tracks ?? []) {
    for (const state of [before, after]) {
      const track = state.tracks.find((candidate) => candidate.id === id);
      if (track && track.kind !== "subtitles") ids.push(...track.clips.map((clip) => clip.id));
    }
  }
  return [...new Set(ids)];
}

function locate(timeline: Timeline, id: string): PlacedClip | null {
  for (const track of timeline.tracks) {
    if (track.kind === "subtitles") continue;
    const clip = track.clips.find((candidate) => candidate.id === id);
    if (clip) return { track: track.id, clip };
  }
  return null;
}

/** Null when nothing differs. `moved` = only the track or start changed. */
function classify(before: PlacedClip | null, after: PlacedClip | null): ClipDiff["change"] | null {
  if (!before && !after) return null;
  if (!before) return "added";
  if (!after) return "removed";
  if (isDeepStrictEqual(before, after)) return null;
  const { start: _a, ...restBefore } = before.clip;
  const { start: _b, ...restAfter } = after.clip;
  return isDeepStrictEqual(restBefore, restAfter) ? "moved" : "changed";
}

function unavailable(target: string, timeline: string, why: string): RpcError {
  return new RpcError(
    ErrorCode.HistoryUnavailable,
    `Cannot diff ${target}: timeline ${timeline} ${why}, so the states around it cannot be replayed.`,
    { target, timeline, hint: "The journal cannot replay changes it did not record; read the timeline as it is now." },
  );
}
