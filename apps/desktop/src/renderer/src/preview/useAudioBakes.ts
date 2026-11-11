// Ready bakes of clip audio effects (ADR 0031) for the preview's program; `audio.bakes` also queues the missing ones.
import type { TimelineView } from "@frameshell/protocol";
import { audioEffectsOf } from "@frameshell/schema/effects";
import { useEffect, useMemo, useState } from "react";
import { reviewView } from "../review/store.js";
import { type BakedSound, readyBakes } from "./program.js";

/** Re-read `audio.bakes` this often while a bake is queued or running. */
const BAKE_POLL_MS = 2_000;

const EMPTY: ReadonlyMap<string, BakedSound> = new Map();

const hasEffects = (view: TimelineView) => view.tracks.some((track) => track.clips.some((clip) => audioEffectsOf(clip) !== null));

/**
 * Ready bakes of the audio effects `view` and the timelines it nests play, by `bakeRef`: re-read on every
 * revision of any of them and every {@link BAKE_POLL_MS} while a bake is pending. Empty (no daemon call) while
 * no clip has effects; a clip whose bake is not ready plays dry.
 */
export function useAudioBakes(view: TimelineView | null, nested: ReadonlyMap<string, TimelineView>): ReadonlyMap<string, BakedSound> {
  const [bakes, setBakes] = useState<{ key: string; map: ReadonlyMap<string, BakedSound> }>({ key: "", map: EMPTY });
  const timeline = view?.timeline ?? null;
  const revision = view?.revision ?? null;
  const nestedRevisions = useMemo(() => [...nested.values()].map((v) => `${v.timeline}@${v.revision}`).join(","), [nested]);
  const affected = useMemo(() => (view ? hasEffects(view) || [...nested.values()].some(hasEffects) : false), [view, nested]);

  useEffect(() => {
    if (!timeline || !affected) {
      setBakes((current) => (current.key === "" ? current : { key: "", map: EMPTY }));
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;
    const read = async () => {
      try {
        const { bakes: list } = await window.frameshell.media.bakes(timeline, reviewView());
        if (disposed) return;
        const map = readyBakes(list);
        // Same ready set, same map: the program is not recompiled.
        const key = JSON.stringify([...map.entries()]);
        setBakes((current) => (current.key === key ? current : { key, map }));
        if (list.some((bake) => bake.state === "queued" || bake.state === "baking")) timer = setTimeout(() => void read(), BAKE_POLL_MS);
      } catch {
        // Daemon unreachable or timeline invalid: keep the last bakes; the next revision re-reads.
      }
    };
    void read();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [timeline, revision, nestedRevisions, affected]);

  return bakes.map;
}
