import type { ClipDiff } from "@frameshell/protocol";
import { useEffect, useState } from "react";
import { useReview } from "./store.js";

/**
 * What the open proposal changes on `timeline`, as the History panel's diff marks, while After is shown; null
 * otherwise. Read again on each proposal step (the proposal grows while the agent works). `tx` names the proposal
 * the marks belong to.
 */
export function useProposalMarks(timeline: string): { tx: string; marks: readonly ClipDiff[] } | null {
  const { proposal, side, version } = useReview();
  const tx = proposal && side === "after" ? proposal.tx : null;
  const [found, setFound] = useState<{ tx: string; marks: readonly ClipDiff[] } | null>(null);
  useEffect(() => {
    if (tx === null) {
      setFound(null);
      return;
    }
    let live = true;
    window.frameshell.review.diff().then(
      (diff) => live && diff.tx === tx && setFound({ tx, marks: diff.timelines.find((entry) => entry.timeline === timeline)?.clips ?? [] }),
      () => live && setFound(null),
    );
    return () => {
      live = false;
    };
  }, [timeline, tx, version]);
  return found && found.tx === tx ? found : null;
}
