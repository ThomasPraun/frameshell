import type { TimelineView } from "@frameshell/protocol";
import { useCallback, useSyncExternalStore } from "react";

/** What the panel shows: the latest `timeline.show`, or why there is none. */
export interface TimelineState {
  view: TimelineView | null;
  /** Daemon message when the timeline cannot be read (missing or invalid file); null otherwise. */
  error: string | null;
}

const INITIAL: TimelineState = { view: null, error: null };

/** One followed timeline, shared by every component showing it. */
interface Feed {
  state: TimelineState;
  listeners: Set<() => void>;
  stop: () => void;
}

const feeds = new Map<string, Feed>();

/**
 * Follow `timeline`: read it once, then again on each daemon
 * `timeline.changed` (any client: CLI, agent, app) and when its file changes
 * on disk (direct edits). Reads never overlap: changes landing during a read
 * cause exactly one more read.
 */
function follow(timeline: string, feed: Feed): () => void {
  let disposed = false;
  let reading = false;
  let again = false;
  let revision = -1;
  const publish = (state: TimelineState) => {
    feed.state = state;
    for (const listener of feed.listeners) listener();
  };
  const read = async () => {
    if (reading) {
      again = true;
      return;
    }
    reading = true;
    do {
      again = false;
      try {
        const view = await window.frameshell.timeline.show(timeline);
        revision = view.revision;
        if (!disposed) publish({ view, error: null });
      } catch (error) {
        if (!disposed) publish({ view: feed.state.view, error: (error as Error).message });
      }
    } while (again && !disposed);
    reading = false;
  };

  const offEvents = window.frameshell.timeline.onChanged((change) => {
    // A revision we already show (our own read raced ahead of the event) needs no read.
    if (change.timeline === null || (change.timeline === timeline && change.revision > revision)) void read();
  });
  const file = `timelines/${timeline}.json`;
  const offFiles = window.frameshell.files.onChanged((paths) => {
    if (paths.includes(file)) void read();
  });
  void read();
  return () => {
    disposed = true;
    offEvents();
    offFiles();
  };
}

/**
 * The latest `timeline.show` of one timeline of the window's project, live.
 * Every caller of the same timeline shares one feed (one read per change):
 * the timeline panel and the script editor's scene links see the same
 * revision. The feed stops when its last caller unmounts.
 */
export function useTimelineView(timeline: string): TimelineState {
  const subscribe = useCallback(
    (listener: () => void) => {
      let feed = feeds.get(timeline);
      if (!feed) {
        const created: Feed = { state: INITIAL, listeners: new Set(), stop: () => undefined };
        feeds.set(timeline, created);
        created.stop = follow(timeline, created);
        feed = created;
      }
      feed.listeners.add(listener);
      const current = feed;
      return () => {
        current.listeners.delete(listener);
        if (current.listeners.size === 0) {
          current.stop();
          feeds.delete(timeline);
        }
      };
    },
    [timeline],
  );
  return useSyncExternalStore(subscribe, () => feeds.get(timeline)?.state ?? INITIAL);
}
