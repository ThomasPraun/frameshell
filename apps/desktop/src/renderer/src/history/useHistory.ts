import type { HistoryDiffResult, HistoryResult, TimelineView } from "@frameshell/protocol";
import { useEffect, useState } from "react";
import { type SelectionOrigin, selection } from "../selection.js";
import { timelineState, useTimelineView, watchTimeline } from "../timeline/useTimelineView.js";
import { historySelection } from "./model.js";

/** Diffs asked for, by timeline, target and the revision asked at; both panels asking share one request. */
const diffs = new Map<string, Promise<HistoryDiffResult>>();
/** Past entries' diffs never change and an open one's only grows with the revision: a few recent ones suffice. */
const MAX_DIFFS = 32;

/**
 * `history.diff` of `target`, asked once per revision: a transaction still
 * open (auto-grouped session, `tx begin`) gains operations as the revision
 * grows. A failed request is forgotten, so the next ask retries.
 */
export function loadHistoryDiff(timeline: string, target: string, revision: number | null): Promise<HistoryDiffResult> {
  const key = `${timeline}\n${target}\n${revision ?? ""}`;
  let pending = diffs.get(key);
  if (!pending) {
    pending = window.frameshell.history.diff(timeline, target);
    pending.catch(() => diffs.delete(key));
    diffs.set(key, pending);
    if (diffs.size > MAX_DIFFS) diffs.delete(diffs.keys().next().value!);
  }
  return pending;
}

/**
 * Select History entry `target` (`tx_…` or `op_…`) of `timeline` in the
 * shared selection: the clips it changed that the timeline still has,
 * revealed, and its changes marked. Rejects with the daemon's message (e.g.
 * an id not in the journal), leaving the selection as it was. `revision`:
 * the target produced it (a revert just made), so which clips it left is
 * read from that revision once the shared feed has it.
 */
export async function selectHistoryEntry(
  timeline: string,
  target: string,
  origin: SelectionOrigin,
  options: { revision?: number } = {},
): Promise<void> {
  const asked = timelineState(timeline).view;
  const [{ clips }, shown] = await Promise.all([
    loadHistoryDiff(timeline, target, asked?.revision ?? null),
    feedAt(timeline, options.revision ?? -1),
  ]);
  // A revision that landed during the request decides which clips are still there.
  const view = timelineState(timeline).view ?? shown ?? asked;
  const present = new Set(view?.tracks.flatMap((track) => track.clips.map((clip) => clip.id)) ?? []);
  const picked = historySelection(clips, present);
  selection.selectHistory(target, picked.clips, picked.reveal, origin);
}

/** How long {@link feedAt} waits for a revision: the feed follows the daemon's event, normally within milliseconds. */
const FEED_WAIT_MS = 2_000;

/** The shared feed's view once it shows `revision` or later; whatever it shows after {@link FEED_WAIT_MS}. */
function feedAt(timeline: string, revision: number): Promise<TimelineView | null> {
  const now = timelineState(timeline).view;
  if (now && now.revision >= revision) return Promise.resolve(now);
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      off();
      resolve(timelineState(timeline).view);
    };
    const timer = setTimeout(done, FEED_WAIT_MS);
    const off = watchTimeline(timeline, () => {
      if ((timelineState(timeline).view?.revision ?? -1) >= revision) done();
    });
  });
}

/**
 * `history` of `timeline`, live: read again on each revision of the shared
 * timeline feed (which follows daemon `timeline.changed`), so no second
 * subscription exists. Every journaled operation bumps the revision.
 */
export function useTimelineHistory(timeline: string): { history: HistoryResult | null; error: string | null } {
  const { view } = useTimelineView(timeline);
  const revision = view?.revision ?? null;
  const [state, setState] = useState<{ history: HistoryResult | null; error: string | null }>({ history: null, error: null });
  useEffect(() => {
    if (revision === null) return;
    let live = true;
    window.frameshell.history.list(timeline).then(
      (history) => live && setState({ history, error: null }),
      (error: unknown) => live && setState((was) => ({ ...was, error: (error as Error).message })),
    );
    return () => {
      live = false;
    };
  }, [timeline, revision]);
  return state;
}

/**
 * Diff of history entry `target` (null: none), re-asked when `revision`
 * changes. While a new revision's diff loads the previous one of the same
 * target stays, so marks do not flicker as the agent keeps editing.
 */
export function useHistoryDiff(
  timeline: string,
  target: string | null,
  revision: number | null,
): { diff: HistoryDiffResult | null; error: string | null } {
  const [state, setState] = useState<{ diff: HistoryDiffResult | null; error: string | null }>({ diff: null, error: null });
  useEffect(() => {
    if (target === null) {
      setState({ diff: null, error: null });
      return;
    }
    let live = true;
    setState((was) => (was.diff?.target === target ? was : { diff: null, error: null }));
    loadHistoryDiff(timeline, target, revision).then(
      (diff) => live && setState({ diff, error: null }),
      (error: unknown) => live && setState({ diff: null, error: (error as Error).message }),
    );
    return () => {
      live = false;
    };
  }, [timeline, target, revision]);
  return state;
}
