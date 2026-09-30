import type { AssetInfo } from "@frameshell/protocol";
import { useEffect, useMemo, useState } from "react";
import { SELECTION_TIMELINE } from "../selection.js";
import { useTimelineView } from "../timeline/useTimelineView.js";
import { type Program, compileProgram } from "./program.js";

/** Poll `asset.list` this often while an asset is still ingesting (until daemon asset events, #69). */
const INGEST_POLL_MS = 2_000;

/**
 * The {@link Program} of the timeline the timeline panel shows, live: from
 * the shared timeline feed (one read per change for every panel) and
 * `asset.list`, re-read on each revision and while proxies are being built.
 * Null until both are known.
 */
export function useProgram(): Program | null {
  const { view } = useTimelineView(SELECTION_TIMELINE);
  const assets = useAssets(view?.revision ?? null);
  return useMemo(() => (view && assets ? compileProgram(view, assets) : null), [view, assets]);
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
      const key = JSON.stringify(list.map((a) => [a.path, a.state, a.proxy, a.sidecar?.path ?? null, a.media?.video?.still ?? null]));
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
