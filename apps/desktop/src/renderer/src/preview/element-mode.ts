// Element mode (ADR 0021): the one generated clip whose composition elements the preview edits, shared by the preview's
// element layer, the engine (which leaves a dragged clip out) and the clip inspector (adjustment list, match counts).
import { useSyncExternalStore } from "react";

/** Element mode state. */
export interface ElementMode {
  /** Top-level clip whose elements the preview edits; null outside element mode. */
  clip: string | null;
  /** Elements each of the clip's adjustment selectors matches at the shown frame; null until its live page answered. */
  counts: Readonly<Record<string, number>> | null;
  /**
   * A drag's live page shows instead of the clip's render: the clip, and its
   * render identity when the drag began. It stays after the drop until the
   * new render or live page is there; null when no drag page shows.
   */
  held: { clip: string; identity: string | null } | null;
}

const OFF: ElementMode = { clip: null, counts: null, held: null };

/** Create an element mode store. The app has one ({@link elementMode}); tests make their own. */
export function createElementMode() {
  let state = OFF;
  const listeners = new Set<() => void>();
  const set = (next: ElementMode) => {
    if (next.clip === state.clip && next.counts === state.counts && next.held === state.held) return;
    state = next;
    for (const listener of listeners) listener();
  };
  return {
    get: (): ElementMode => state,
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** Edit `clip`'s elements (leaving any other clip's). */
    enter(clip: string): void {
      if (state.clip !== clip) set({ clip, counts: null, held: null });
    },
    /** Back to whole clips. */
    leave(): void {
      set(OFF);
    },
    /** Match counts of `clip`'s selectors; ignored once the mode moved to another clip. */
    setCounts(clip: string, counts: Readonly<Record<string, number>>): void {
      if (state.clip === clip) set({ ...state, counts });
    },
    /** Show `clip`'s drag page instead of its render (identity at drag start). */
    hold(clip: string, identity: string | null): void {
      if (state.clip === clip) set({ ...state, held: { clip, identity } });
    },
    /** The render or live page took over: the drag page goes. */
    release(): void {
      if (state.held) set({ ...state, held: null });
    },
  };
}

/** The app's element mode. */
export const elementMode = createElementMode();

/** Current element mode, re-rendering on change. */
export function useElementMode(): ElementMode {
  return useSyncExternalStore(elementMode.subscribe, elementMode.get);
}
