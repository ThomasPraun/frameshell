import type { TimelineView } from "@frameshell/protocol";
import { useEffect, useState } from "react";

/** What the panel shows: the latest `timeline.show`, or why there is none. */
export interface TimelineState {
  view: TimelineView | null;
  /** Daemon message when the timeline cannot be read (missing or invalid file); null otherwise. */
  error: string | null;
}

/**
 * Follow one timeline of the window's project: read it once, then again on
 * each daemon `timeline.changed` (any client: CLI, agent, app) and when its
 * file changes on disk (direct edits). Reads never overlap: changes landing
 * during a read cause exactly one more read.
 */
export function useTimelineView(timeline: string): TimelineState {
  const [state, setState] = useState<TimelineState>({ view: null, error: null });

  useEffect(() => {
    let disposed = false;
    let reading = false;
    let again = false;
    let revision = -1;
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
          if (!disposed) setState({ view, error: null });
        } catch (error) {
          if (!disposed) setState((current) => ({ view: current.view, error: (error as Error).message }));
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
  }, [timeline]);

  return state;
}
