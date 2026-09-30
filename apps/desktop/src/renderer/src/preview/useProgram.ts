import type { AssetInfo, TimelineView } from "@frameshell/protocol";
import { useEffect, useMemo, useRef, useState } from "react";
import { SELECTION_TIMELINE } from "../selection.js";
import { timelineState, useTimelineView, watchTimeline } from "../timeline/useTimelineView.js";
import { type Program, compileProgram } from "./program.js";

/** Poll `asset.list` this often while an asset is still ingesting (until daemon asset events, #69). */
const INGEST_POLL_MS = 2_000;

/** Nested clip sources the preview can follow: `timelines/<id>.json`, the files `timeline.show` reads by id. */
const NESTED_SOURCE = /^timelines\/([A-Za-z0-9][A-Za-z0-9_-]*)\.json$/;

/**
 * The {@link Program} of the timeline the timeline panel shows, live: from
 * the shared timeline feeds (one read per change for every panel; nested
 * timelines on their own feeds) and `asset.list`, re-read on each revision
 * and while proxies are being built. Null until both are known.
 */
export function useProgram(): Program | null {
  const { view } = useTimelineView(SELECTION_TIMELINE);
  const assets = useAssets(view?.revision ?? null);
  const resolution = useResolution();
  const nested = useNestedViews(view);
  return useMemo(
    () => (view && assets ? compileProgram(view, assets, { resolution, nested }) : null),
    [view, assets, resolution, nested],
  );
}

/**
 * Views of every timeline `root` nests, directly or through other nested
 * timelines, by clip `source`, followed live on the shared feeds. A source
 * not read yet (or unreadable) is absent: the preview shows a placeholder.
 */
function useNestedViews(root: TimelineView | null): ReadonlyMap<string, TimelineView> {
  const [version, setVersion] = useState(0);
  const watched = useRef(new Map<string, () => void>());
  const reachable = useMemo(() => {
    const found = new Map<string, TimelineView | null>();
    const queue = root ? [root] : [];
    while (queue.length > 0) {
      for (const track of queue.pop()!.tracks) {
        for (const clip of track.clips) {
          const source = clip.type === "timeline" ? clip["source"] : undefined;
          if (typeof source !== "string" || found.has(source)) continue;
          const id = NESTED_SOURCE.exec(source)?.[1];
          const view = id ? timelineState(id).view : null;
          found.set(source, view);
          if (view) queue.push(view);
        }
      }
    }
    return found;
    // `version` re-reads the feeds' states after any of them changes.
  }, [root, version]);

  useEffect(() => {
    const ids = new Set([...reachable.keys()].flatMap((source) => NESTED_SOURCE.exec(source)?.[1] ?? []));
    for (const [id, stop] of watched.current) {
      if (ids.has(id)) continue;
      stop();
      watched.current.delete(id);
    }
    for (const id of ids) if (!watched.current.has(id)) watched.current.set(id, watchTimeline(id, () => setVersion((n) => n + 1)));
  }, [reachable]);

  useEffect(() => {
    const current = watched.current;
    return () => {
      for (const stop of current.values()) stop();
      current.clear();
    };
  }, []);

  return useMemo(() => {
    const views = new Map<string, TimelineView>();
    for (const [source, view] of reachable) if (view) views.set(source, view);
    return views;
  }, [reachable]);
}

function useAssets(revision: number | null): ReadonlyMap<string, AssetInfo> | null {
  const [assets, setAssets] = useState<{ key: string; map: ReadonlyMap<string, AssetInfo> } | null>(null);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;
    const poll = async () => {
      let list: AssetInfo[];
      try {
        list = await window.frameshell.media.assets();
      } catch {
        list = [];
      }
      if (disposed) return;
      // Same list, same map: the program is not recompiled (nor re-sent to the engine).
      const key = JSON.stringify(list.map((a) => [a.path, a.hash, a.state, a.proxy, a.sidecar?.path ?? null, a.media?.video ?? null]));
      setAssets((current) => (current?.key === key ? current : { key, map: new Map(list.map((a) => [a.path, a])) }));
      if (list.some((a) => a.state === "pending" || a.state === "processing")) timer = setTimeout(() => void poll(), INGEST_POLL_MS);
    };
    void poll();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [revision]);
  return assets?.map ?? null;
}

/** Project frame size from `frameshell.json` `resolution`, followed live; 1920x1080 until read or when unset. */
export function useResolution(): { width: number; height: number } {
  const [resolution, setResolution] = useState({ width: 1920, height: 1080 });
  useEffect(() => {
    let disposed = false;
    const read = async () => {
      try {
        const config = JSON.parse(await window.frameshell.files.read("frameshell.json")) as { resolution?: { width?: unknown; height?: unknown } };
        const { width, height } = config.resolution ?? {};
        if (disposed || typeof width !== "number" || typeof height !== "number" || width <= 0 || height <= 0) return;
        setResolution((current) => (current.width === width && current.height === height ? current : { width, height }));
      } catch {
        // Unreadable or mid-save: keep the last good size.
      }
    };
    void read();
    const off = window.frameshell.files.onChanged((paths) => {
      if (paths.includes("frameshell.json")) void read();
    });
    return () => {
      disposed = true;
      off();
    };
  }, []);
  return resolution;
}
