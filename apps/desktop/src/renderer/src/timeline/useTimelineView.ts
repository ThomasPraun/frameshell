import type { TimelineRejection, TimelineView } from "@frameshell/protocol";
import { useCallback, useSyncExternalStore } from "react";
import { SELECTION_TIMELINE, selection } from "../selection.js";

/** What the panel shows: the latest `timeline.show`, or why there is none. */
export interface TimelineState {
  view: TimelineView | null;
  /** Daemon message when the timeline cannot be read (missing or invalid file); null otherwise. */
  error: string | null;
  /** Latest direct edit of this timeline's file the daemon refused, until dismissed; null otherwise. */
  rejection: TimelineRejection | null;
  /** Hide {@link TimelineState.rejection}. */
  dismissRejection: () => void;
}

const INITIAL: TimelineState = { view: null, error: null, rejection: null, dismissRejection: () => undefined };

/** One followed timeline, shared by every component showing it. */
interface Feed {
  state: TimelineState;
  listeners: Set<() => void>;
  stop: () => void;
}

const feeds = new Map<string, Feed>();

/**
 * Follow `timeline`: read it once, then again on each daemon
 * `timeline.changed` (any client: CLI, agent, app, and direct edits of the
 * file, which the daemon journals as author `file`); direct edits it refuses
 * arrive as rejections. Reads never overlap: changes landing during a read
 * cause exactly one more read.
 */
function follow(timeline: string, feed: Feed): () => void {
  let disposed = false;
  let reading = false;
  let again = false;
  let revision = -1;
  const dismissRejection = () => publish({ ...feed.state, rejection: null });
  feed.state = { ...feed.state, dismissRejection };
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
        if (disposed) continue;
        // Before publishing: no render may see a selected clip the new revision removed.
        if (timeline === SELECTION_TIMELINE) selection.retainClips(new Set(view.tracks.flatMap((track) => track.clips.map((clip) => clip.id))));
        publish({ ...feed.state, view, error: null });
      } catch (error) {
        if (!disposed) publish({ ...feed.state, error: (error as Error).message });
      }
    } while (again && !disposed);
    reading = false;
  };

  const offEvents = window.frameshell.timeline.onChanged((change) => {
    // A revision we already show (our own read raced ahead of the event) needs no read.
    if (change.timeline === null || (change.timeline === timeline && change.revision > revision)) void read();
  });
  const offRejected = window.frameshell.timeline.onRejected((refused) => {
    if (refused.timeline === timeline && !disposed) publish({ ...feed.state, rejection: refused });
  });
  void read();
  return () => {
    disposed = true;
    offEvents();
    offRejected();
  };
}

/**
 * The latest `timeline.show` of one timeline of the window's project, live.
 * Every caller of the same timeline shares one feed (one read per change):
 * the timeline panel and the script editor's scene links see the same
 * revision. Each revision of {@link SELECTION_TIMELINE} first prunes the
 * selection to clips it still has. The feed stops when its last caller
 * unmounts.
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
