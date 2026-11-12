// Ready subject mattes (ADR 0032) for the preview's program; `matte.status` also queues the missing ones.
import type { TimelineView } from "@frameshell/protocol";
import { useEffect, useMemo, useState } from "react";
import { reviewView } from "../review/store.js";
import { readyMattes } from "./program.js";

/** Re-read `matte.status` this often while a matte is queued, being made, or waiting for its proxy. */
const MATTE_POLL_MS = 2_000;

const EMPTY: ReadonlyMap<string, string> = new Map();

const hasBehind = (view: TimelineView) => view.tracks.some((track) => track.kind === "video" && track.behind !== undefined);

/**
 * Ready subject mattes of the plates `view` and the timelines it nests play, by asset: re-read on every revision of
 * any of them and every {@link MATTE_POLL_MS} while one is pending. Empty (no daemon call) while no track is `behind`
 * one; a subject whose matte is not ready shows a note, the plate as it is.
 */
export function useSubjectMattes(view: TimelineView | null, nested: ReadonlyMap<string, TimelineView>): ReadonlyMap<string, string> {
  const [mattes, setMattes] = useState<{ key: string; map: ReadonlyMap<string, string> }>({ key: "", map: EMPTY });
  const timeline = view?.timeline ?? null;
  const revision = view?.revision ?? null;
  const nestedRevisions = useMemo(() => [...nested.values()].map((v) => `${v.timeline}@${v.revision}`).join(","), [nested]);
  const affected = useMemo(() => (view ? hasBehind(view) || [...nested.values()].some(hasBehind) : false), [view, nested]);

  useEffect(() => {
    if (!timeline || !affected) {
      setMattes((current) => (current.key === "" ? current : { key: "", map: EMPTY }));
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;
    const read = async () => {
      try {
        const { mattes: list } = await window.frameshell.media.mattes(timeline, reviewView());
        if (disposed) return;
        const map = readyMattes(list);
        // Same ready set, same map: the program is not recompiled.
        const key = JSON.stringify([...map.entries()]);
        setMattes((current) => (current.key === key ? current : { key, map }));
        if (list.some((matte) => matte.state === "queued" || matte.state === "making" || matte.state === "waiting")) {
          timer = setTimeout(() => void read(), MATTE_POLL_MS);
        }
      } catch {
        // Daemon unreachable or timeline invalid: keep the last mattes; the next revision re-reads.
      }
    };
    void read();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [timeline, revision, nestedRevisions, affected]);

  return mattes.map;
}
