import type { TimelineView } from "@frameshell/protocol";
import { useEffect, useSyncExternalStore } from "react";

/** File of the timeline the app shows; must match main's `timeline.show` target. */
const MAIN_TIMELINE = "timelines/main.json";

let view: TimelineView | null = null;
let users = 0;
let stopWatching: (() => void) | null = null;
let generation = 0;
const listeners = new Set<() => void>();

/** Latest fetch wins: a slow reply never overwrites a newer one. */
function refresh(): void {
  const mine = ++generation;
  void window.frameshell.timeline.show().then((next) => {
    if (mine !== generation) return;
    view = next;
    for (const listener of listeners) listener();
  });
}

/**
 * The `main` timeline as the daemon shows it, refetched whenever its file
 * changes on disk (agent, CLI or editor). One fetch shared by every caller;
 * null until loaded or while the file is missing or invalid.
 */
export function useTimelineView(): TimelineView | null {
  useEffect(() => {
    if (users++ === 0) {
      stopWatching = window.frameshell.files.onChanged((paths) => {
        if (paths.includes(MAIN_TIMELINE)) refresh();
      });
      refresh();
    }
    return () => {
      if (--users === 0) {
        stopWatching?.();
        stopWatching = null;
      }
    };
  }, []);
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => view,
  );
}

/** Every clip of a timeline view, track order then time. */
export function clipsOf(timeline: TimelineView | null): TimelineView["tracks"][number]["clips"] {
  return timeline ? timeline.tracks.flatMap((track) => track.clips) : [];
}
