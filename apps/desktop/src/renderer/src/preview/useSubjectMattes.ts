// Subject mattes (ADR 0032) of a timeline: the preview's ready ones, and the status the track headers show; `matte.status` also queues the missing ones.
import type { AssetInfo, MatteStateInfo, TimelineView } from "@frameshell/protocol";
import { useEffect, useMemo, useRef, useState } from "react";
import { reviewView } from "../review/store.js";
import { readyMattes } from "./program.js";

/** Re-read `matte.status` this often while a matte is queued, being made, or waiting for its proxy. */
const MATTE_POLL_MS = 2_000;

const EMPTY: ReadonlyMap<string, string> = new Map();

const hasBehind = (view: TimelineView) => view.tracks.some((track) => track.kind === "video" && track.behind !== undefined);

/**
 * The `matte.status` list of the plates `view` and the timelines it nests play; null while none is read, and while no
 * track is `behind` one (no daemon call then). Re-read on every revision of any of them, when an asset's content or
 * proxy changes (a new matte key), and every {@link MATTE_POLL_MS} while one is pending. The preview and the timeline
 * panel each keep their own (either may be in a detached window): the daemon queues a matte once however often it is asked.
 */
export function useMatteStatus(
  view: TimelineView | null,
  nested: ReadonlyMap<string, TimelineView>,
  assets: ReadonlyMap<string, AssetInfo> | null,
): readonly MatteStateInfo[] | null {
  const [state, setState] = useState<{ key: string; list: readonly MatteStateInfo[] | null }>({ key: "", list: null });
  const timeline = view?.timeline ?? null;
  const revision = view?.revision ?? null;
  const nestedRevisions = useMemo(() => [...nested.values()].map((v) => `${v.timeline}@${v.revision}`).join(","), [nested]);
  const contents = useMemo(() => [...(assets?.values() ?? [])].map((a) => `${a.path}:${a.hash}:${a.proxy}`).join(","), [assets]);
  const affected = useMemo(() => (view ? hasBehind(view) || [...nested.values()].some(hasBehind) : false), [view, nested]);

  useEffect(() => {
    if (!timeline || !affected) {
      setState((current) => (current.list === null ? current : { key: "", list: null }));
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;
    const read = async () => {
      try {
        const { mattes: list } = await window.frameshell.media.mattes(timeline, reviewView());
        if (disposed) return;
        // Same list, same state: nothing downstream renders again.
        const key = JSON.stringify(list);
        setState((current) => (current.key === key ? current : { key, list }));
        if (list.some((matte) => matte.state === "queued" || matte.state === "making" || matte.state === "waiting")) {
          timer = setTimeout(() => void read(), MATTE_POLL_MS);
        }
      } catch {
        // Daemon unreachable or timeline invalid: keep the last list; the next revision re-reads.
      }
    };
    void read();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [timeline, revision, nestedRevisions, affected, contents]);

  return state.list;
}

/**
 * Ready subject mattes of the plates `view` and the timelines it nests play, by asset ({@link useMatteStatus} reads
 * them). The same map while the ready set is the same, so a matte's progress does not recompile the program; a subject
 * whose matte is not ready shows a note, the plate as it is.
 */
export function useSubjectMattes(
  view: TimelineView | null,
  nested: ReadonlyMap<string, TimelineView>,
  assets: ReadonlyMap<string, AssetInfo> | null,
): ReadonlyMap<string, string> {
  const list = useMatteStatus(view, nested, assets);
  const last = useRef<{ key: string; map: ReadonlyMap<string, string> }>({ key: "", map: EMPTY });
  return useMemo(() => {
    const map = list === null ? EMPTY : readyMattes(list);
    const key = JSON.stringify([...map.entries()]);
    if (last.current.key !== key) last.current = { key, map: map.size === 0 ? EMPTY : map };
    return last.current.map;
  }, [list]);
}
