// "Play in the mix" (#803): which music candidate the preview plays while the Audition dialog asks for it. Preview
// only: the timeline keeps its own mutes, nothing is written or journaled.
import { useSyncExternalStore } from "react";
import type { MixSolo } from "./model.js";

let solo: MixSolo | null = null;
const listeners = new Set<() => void>();

/** The one solo of the window's preview. */
export const mixSolo = {
  get: (): MixSolo | null => solo,
  /** Play `next` in the preview's mix; null gives the timeline's own mutes back. */
  set(next: MixSolo | null): void {
    if (next === solo) return;
    solo = next;
    for (const listener of listeners) listener();
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

/** The solo the preview applies; re-renders when it changes. */
export function useMixSolo(): MixSolo | null {
  return useSyncExternalStore(mixSolo.subscribe, mixSolo.get);
}
