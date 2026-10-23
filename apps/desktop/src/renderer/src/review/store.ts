import { useSyncExternalStore } from "react";
import {
  INITIAL_REVIEW,
  type ReviewSide,
  type ReviewState,
  afterEdit,
  applyEvent,
  dismissStale,
  readStatus,
  viewOf,
  withSide,
} from "./model.js";

/**
 * Review mode of the window's project (ADR 0019), the one store of the renderer. Detached panels are drawn by
 * this same renderer (ADR 0012), so the Before / After side is shared with them by construction: the shared
 * timeline feeds read the side from here, and preview and timeline always show the same one.
 */
let state: ReviewState = INITIAL_REVIEW;
const listeners = new Set<() => void>();

function set(next: ReviewState): void {
  if (next === state) return;
  state = next;
  for (const listener of [...listeners]) listener();
}

/** Latest review state. */
export function reviewState(): ReviewState {
  return state;
}

/** Call `listener` after each change of the review state. Returns the function that removes it. */
export function watchReview(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/** The review state, live. */
export function useReview(): ReviewState {
  return useSyncExternalStore(watchReview, reviewState);
}

/** `view` the timeline feeds ask the daemon for now; see {@link viewOf}. */
export function reviewView(): ReturnType<typeof viewOf> {
  return viewOf(state);
}

async function refresh(): Promise<void> {
  try {
    set(readStatus(state, await window.frameshell.review.status()));
  } catch {
    // The daemon is unreachable: the timeline says so, and the next event or resync reads again.
  }
}

/**
 * Follow review mode: read its status, then each proposal step, switch change and reconnect. A person's edit
 * (`timeline.changed` by `ui`) while looking at After returns the view to Before: edits always apply to the
 * file, and the proposal rebases or goes stale on them. Returns the function that stops following.
 */
export function startReview(): () => void {
  void refresh();
  const offReview = window.frameshell.review.onChanged((event) => {
    if ("resync" in event) void refresh();
    else set(applyEvent(state, event));
  });
  const offTimeline = window.frameshell.timeline.onChanged((change) => {
    if (change.timeline !== null && change.author === "ui") set(afterEdit(state));
  });
  return () => {
    offReview();
    offTimeline();
  };
}

/** Show `side` of the open proposal in every panel of the window. */
export function showSide(side: ReviewSide): void {
  set(withSide(state, side));
}

/** Hide the stale notice. */
export function dismissStaleNotice(): void {
  set(dismissStale(state));
}

/** Turn the project's review mode on or off. Resolves with the daemon's message on failure, else null. */
export async function setReviewEnabled(enabled: boolean): Promise<string | null> {
  return attempt(() => window.frameshell.review.setEnabled(enabled));
}

/**
 * Accept or reject proposal `tx`. A proposal already decided, in another window or by the agent
 * dropping it, is not an error: its closing event is on the way. Resolves with the message of any other failure.
 */
export async function decide(tx: string, decision: "accept" | "reject"): Promise<string | null> {
  const failure = await attempt(() => window.frameshell.review[decision](tx));
  return failure !== null && /decided|unknown/.test(failure) ? null : failure;
}

async function attempt(work: () => Promise<void>): Promise<string | null> {
  try {
    await work();
    return null;
  } catch (error) {
    return (error as Error).message;
  }
}
