import { isDeepStrictEqual } from "node:util";
import {
  ErrorCode,
  type HistoryResult,
  type HistoryTransaction,
  type JournalEntry,
  type RevertConflict,
  RpcError,
  type TimelinePatch,
} from "@frameshell/protocol";
import type { Timeline } from "@frameshell/schema";
import { applyPatch } from "../timeline/patch.js";
import { timelineHash } from "./hash.js";

/**
 * Pure history logic over a journal (SPEC §6.2): what `revert` restores and
 * when it must refuse, and the grouped `history` view. Entity keys are
 * `track:<id>`, `clip:<id>` and `order` (track stacking order).
 */

/**
 * Timeline with the target's operations undone: their inverses applied to
 * `current` newest first. `target` is a tx id (all its operations) or an op id.
 *
 * Throws `RpcError` HistoryNotFound when no entry matches, and RevertConflict
 * when an operation outside the target, journaled after the target's first
 * operation, left a different value on a track or clip the target changed
 * (a later change that was itself reverted cancels out), or when the file
 * changed outside the journal since the target (see `checkUnbroken`).
 */
export function planRevert(current: Timeline, entries: JournalEntry[], target: string, timeline: string): Timeline {
  const inTarget = (entry: JournalEntry) => entry.id === target || entry.tx === target;
  const first = entries.findIndex(inTarget);
  if (first === -1) {
    throw new RpcError(
      ErrorCode.HistoryNotFound,
      `No ${target.startsWith("tx_") ? "transaction" : "operation"} ${target} in the history of timeline ${timeline}. ` +
        "List ids with `frameshell history` (pass --timeline for another timeline).",
      { target, timeline },
    );
  }
  const tail = entries.slice(first);
  checkUnbroken(current, tail, target, timeline);

  const keys = new Set(tail.filter(inTarget).flatMap((entry) => patchKeys(entry.inverse.args)));
  // Walk back from `current`: before each target op, the values its later
  // segment of foreign ops left must equal the values right after that op.
  let state = current;
  let anchor = snapshot(state, keys);
  let segment: JournalEntry[] = [];
  const conflicts = new Map<string, { entry: JournalEntry; ids: Set<string> }>();
  let restored = current;
  for (let i = tail.length - 1; i >= 0; i--) {
    const entry = tail[i]!;
    const previous = rewind(state, entry, target, timeline);
    if (!inTarget(entry)) {
      segment.push(entry);
      state = previous;
      continue;
    }
    for (const key of keys) {
      if (isDeepStrictEqual(value(state, key), anchor.get(key))) continue;
      const blamed = segment.filter((other) => relates(other, key, state, current));
      for (const other of blamed.length > 0 ? blamed : segment.slice(0, 1)) {
        const conflict = conflicts.get(other.id) ?? { entry: other, ids: new Set<string>() };
        conflict.ids.add(key.replace(/^(clip|track):/, ""));
        conflicts.set(other.id, conflict);
      }
    }
    // A conflict discards `restored`. Rewinding it anyway can fail (an `order`
    // patch misses a later foreign track) and would hide the conflicting op.
    if (conflicts.size === 0) restored = rewind(restored, entry, target, timeline);
    state = previous;
    anchor = snapshot(state, keys);
    segment = [];
  }
  if (conflicts.size > 0) {
    const ordered = [...conflicts.values()].sort((a, b) => tail.indexOf(a.entry) - tail.indexOf(b.entry));
    throw conflictError(target, timeline, ordered);
  }
  return restored;
}

/** Ids of the tracks and clips a patch changes (clips named once, tracks first). */
export function touchedIds(patch: TimelinePatch): string[] {
  const ids = [...(patch.tracks ?? []).map((entry) => entry.id), ...(patch.clips ?? []).map((entry) => entry.id)];
  return [...new Set(ids)];
}

/**
 * `history` view: entries grouped into runs of one transaction, oldest first.
 * With `since`, only entries after that transaction's last entry. Throws
 * HistoryNotFound when `since` is not in the journal.
 */
export function historyView(entries: JournalEntry[], timeline: string, since?: string): HistoryResult {
  let shown = entries;
  if (since !== undefined) {
    const last = entries.findLastIndex((entry) => entry.tx === since);
    if (last === -1) {
      throw new RpcError(
        ErrorCode.HistoryNotFound,
        `No transaction ${since} in the history of timeline ${timeline}. It may have changed another timeline: pass --timeline.`,
        { target: since, timeline },
      );
    }
    shown = entries.slice(last + 1);
  }
  const transactions: HistoryTransaction[] = [];
  for (const entry of shown) {
    let group = transactions.at(-1);
    if (group?.tx !== entry.tx) {
      group = { tx: entry.tx, label: entry.txLabel, author: entry.author, at: entry.at, operations: [] };
      transactions.push(group);
    }
    group.operations.push({
      id: entry.id,
      op: entry.op,
      args: entry.args,
      author: entry.author,
      at: entry.at,
      revisionBefore: entry.revisionBefore,
      revision: entry.revision,
      touched: touchedIds(entry.inverse.args),
    });
  }
  return { timeline, revision: entries.at(-1)?.revision ?? null, since: since ?? null, transactions };
}

/**
 * Throws RevertConflict (empty `conflicts`) unless the journal from the
 * target's first entry on accounts for every change up to `current`: each
 * entry applied to what the previous one wrote (hash and revision), and the
 * file is what the last one wrote. A gap is an unjournaled edit (a hand edit
 * made while no daemon watched, a journal append that failed): it has no inverse, so replaying
 * inverses over it would silently drop it.
 */
function checkUnbroken(current: Timeline, tail: JournalEntry[], target: string, timeline: string): void {
  const refuse = (where: string) =>
    new RpcError(
      ErrorCode.RevertConflict,
      `Cannot revert ${target}: timeline ${timeline} changed outside the journal ${where}. The journal cannot undo ` +
        "an edit it did not record, and reverting would overwrite it. Edit the timeline forward instead.",
      { target, timeline, conflicts: [], hint: "Edit forward; the journal cannot undo changes it did not record." },
    );
  for (let i = 1; i < tail.length; i++) {
    const [previous, entry] = [tail[i - 1]!, tail[i]!];
    if (entry.hashBefore !== previous.hash || entry.revisionBefore !== previous.revision) {
      throw refuse(`between ${previous.id} (revision ${previous.revision}) and ${entry.id} (revision ${entry.revisionBefore})`);
    }
  }
  const last = tail.at(-1)!;
  if (timelineHash(current) !== last.hash || current.revision !== last.revision) {
    throw refuse(`after ${last.id} (file at revision ${current.revision}, history ends at ${last.revision})`);
  }
}

function patchKeys(patch: TimelinePatch): string[] {
  return [
    ...(patch.tracks ?? []).map((entry) => `track:${entry.id}`),
    ...(patch.clips ?? []).map((entry) => `clip:${entry.id}`),
    ...(patch.order ? ["order"] : []),
  ];
}

/** Tracks a patch writes into: whole tracks and the tracks of its clip entries. */
function patchTracks(patch: TimelinePatch): Set<string> {
  return new Set([...(patch.tracks ?? []).map((entry) => entry.id), ...(patch.clips ?? []).map((entry) => entry.track)]);
}

/** State before `entry`, from the state right after it. */
function rewind(state: Timeline, entry: JournalEntry, target: string, timeline: string): Timeline {
  try {
    return applyPatch(state, entry.inverse.args);
  } catch (error) {
    throw new RpcError(
      ErrorCode.RevertConflict,
      `Cannot revert ${target}: the history of timeline ${timeline} no longer matches the file at ${entry.id} ` +
        `(${(error as Error).message}). Edit forward instead of reverting.`,
      { target, timeline, conflicts: [], hint: "Edit forward; the journal and the file disagree." },
    );
  }
}

function value(timeline: Timeline, key: string): unknown {
  if (key === "order") return timeline.tracks.map((track) => track.id);
  const [kind, id] = [key.slice(0, key.indexOf(":")), key.slice(key.indexOf(":") + 1)];
  if (kind === "track") return timeline.tracks.find((track) => track.id === id) ?? null;
  for (const track of timeline.tracks) {
    if (track.kind === "subtitles") continue;
    const clip = track.clips.find((candidate) => candidate.id === id);
    if (clip) return { track: track.id, clip };
  }
  return null;
}

function snapshot(timeline: Timeline, keys: Set<string>): Map<string, unknown> {
  return new Map([...keys].map((key) => [key, value(timeline, key)]));
}

/** Whether foreign `entry` could have changed `key`: directly, or by rewriting the track holding it. */
function relates(entry: JournalEntry, key: string, ...states: Timeline[]): boolean {
  const patch = entry.inverse.args;
  if (patchKeys(patch).includes(key)) return true;
  if (key === "order") return (patch.tracks ?? []).length > 0;
  if (key.startsWith("track:")) return patchTracks(patch).has(key.slice("track:".length));
  const holders = states.map((state) => (value(state, key) as { track: string } | null)?.track).filter((track) => track !== undefined);
  return holders.some((track) => (patch.tracks ?? []).some((entry) => entry.id === track));
}

/** `found` oldest first. */
function conflictError(target: string, timeline: string, found: { entry: JournalEntry; ids: Set<string> }[]): RpcError {
  const conflicts: RevertConflict[] = found.map(({ entry, ids }) => ({
    id: entry.id,
    op: entry.op,
    author: entry.author,
    tx: entry.tx,
    ids: [...ids].sort(),
  }));
  const lines = conflicts.map((c) => `  ${c.id} ${c.op} by ${c.author} (${c.tx}) changed ${c.ids.join(", ")}`);
  const newestFirst = [...conflicts].reverse().map((c) => c.id);
  return new RpcError(
    ErrorCode.RevertConflict,
    `Cannot revert ${target} on timeline ${timeline}: later operations changed the same tracks or clips:\n${lines.join("\n")}\n` +
      `Revert them first (newest first: ${newestFirst.join(", ")}), or edit forward instead.`,
    { target, timeline, conflicts, hint: `Revert ${newestFirst.join(", ")} first, newest first.` },
  );
}

/** A timeline `tx.abort` could not revert, with the RevertConflict `planRevert` threw for it. */
export interface TimelineRevertFailure {
  root: string;
  timeline: string;
  error: RpcError;
}

/**
 * RevertConflict for a `tx.abort` refused on one or more timelines: says nothing
 * was undone and lists each timeline's conflicts. `data.conflicts` flattens them
 * (as for a one-timeline revert); `data.timelines` keeps them per timeline.
 */
export function abortConflictError(target: string, failures: TimelineRevertFailure[]): RpcError {
  const timelines = failures.map(({ root, timeline, error }) => {
    const data = error.data as { conflicts?: RevertConflict[]; hint?: string } | undefined;
    return { root, timeline, conflicts: data?.conflicts ?? [], hint: data?.hint ?? "" };
  });
  const names = timelines.map((entry) => entry.timeline).join(", ");
  return new RpcError(
    ErrorCode.RevertConflict,
    `Cannot abort ${target}: nothing was undone, because reverting it conflicts on timeline${failures.length > 1 ? "s" : ""} ${names}.\n` +
      `${failures.map(({ error }) => error.message).join("\n")}\n` +
      "The transaction stays open: resolve every conflict and abort again, or commit it.",
    {
      target,
      timeline: timelines[0]!.timeline,
      conflicts: timelines.flatMap((entry) => entry.conflicts),
      timelines,
      hint: timelines.map((entry) => `${entry.timeline}: ${entry.hint}`).join(" "),
    },
  );
}
