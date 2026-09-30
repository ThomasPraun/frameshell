// Live render states of the shown timeline's generated clips; see `clip-renders.ts` for the event folding.
import type { TimelineView } from "@frameshell/protocol";
import { useEffect, useMemo, useRef, useState } from "react";
import { type ClipRenders, applyClipJob } from "./clip-renders.js";

const EMPTY: ClipRenders = new Map();

const hasGenerated = (view: TimelineView) =>
  view.tracks.some((track) => track.kind === "video" && track.clips.some((clip) => clip.type !== "media" && clip.type !== "timeline"));

/**
 * Render states of the generated clips `view` shows, nested ones included
 * (by flattened id `<nested clip>/<clip>`, as `clip.renders` reports them),
 * live: re-read on every revision of `view` or of a timeline it nests, and
 * whenever a render finishes; progress follows `clip` job events. Empty
 * while none of them has generated clips (no daemon call).
 */
export function useClipRenders(view: TimelineView | null, nested: ReadonlyMap<string, TimelineView>): ClipRenders {
  const [renders, setRenders] = useState<ClipRenders>(EMPTY);
  const [reads, setReads] = useState(0);
  // Events arrive outside React renders: fold them into the newest state, not a stale closure.
  const latest = useRef(renders);
  const timeline = view?.timeline ?? null;
  const revision = view?.revision ?? null;
  const nestedRevisions = useMemo(() => [...nested.values()].map((v) => `${v.timeline}@${v.revision}`).join(","), [nested]);
  const generated = useMemo(() => (view ? hasGenerated(view) || [...nested.values()].some(hasGenerated) : false), [view, nested]);

  useEffect(() => {
    if (!timeline || !generated) {
      setRenders(EMPTY);
      return;
    }
    let disposed = false;
    window.frameshell.clips.renders(timeline).then(
      ({ clips }) => {
        if (!disposed) setRenders(new Map(clips.map((info) => [info.clip, info])));
      },
      () => {
        // Daemon unreachable or timeline invalid: keep the last states; the next revision re-reads.
      },
    );
    return () => {
      disposed = true;
    };
  }, [timeline, revision, nestedRevisions, generated, reads]);

  useEffect(() => {
    if (!generated) return;
    return window.frameshell.clips.onJob((job) => {
      if (!job) {
        setReads((n) => n + 1);
        return;
      }
      const applied = applyClipJob(latest.current, job);
      latest.current = applied.renders;
      setRenders(applied.renders);
      if (applied.refetch) setReads((n) => n + 1);
    });
  }, [generated]);
  latest.current = renders;

  return renders;
}
