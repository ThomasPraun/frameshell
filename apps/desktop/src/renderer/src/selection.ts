import { useSyncExternalStore } from "react";

/**
 * What the user has selected, app-wide (SPEC §10). The one selection store
 * of the renderer: the canvas timeline (#14) marks and sets selected clips,
 * the script editor highlights their scenes and selects a scene's clips.
 *
 * Why here and not in the timeline: the canvas keeps only view state
 * (scroll, zoom, hover) and has no selection of its own, while selection is
 * read and set by panels that do not draw clips. Timeline editing (#16)
 * acts on it, `ui_state` and `ui_select` (#33) read and set it, "Ask agent"
 * (#49) quotes it, and the player (#15) may follow it. Those extend
 * {@link Selection} (words, time range, other timelines) here; never keep a
 * second store.
 *
 * Clip ids are those of {@link SELECTION_TIMELINE}.
 */
export interface Selection {
  /** Selected clip ids, in selection order; empty when nothing is selected. */
  readonly clips: readonly string[];
}

/** Timeline whose clips {@link Selection.clips} names: the one the timeline panel shows. */
export const SELECTION_TIMELINE = "main";

const EMPTY: Selection = { clips: [] };
let current: Selection = EMPTY;
const listeners = new Set<() => void>();

/** Read and replace the selection outside React (event handlers, Monaco callbacks). */
export const selection = {
  /** Current selection; the same object until it changes. */
  get: (): Selection => current,
  /** Replace the selected clips; no-op (no re-render) when unchanged. */
  selectClips(ids: readonly string[]): void {
    if (ids.length === current.clips.length && ids.every((id, i) => id === current.clips[i])) return;
    current = ids.length === 0 ? EMPTY : { clips: [...ids] };
    for (const listener of listeners) listener();
  },
  /** Add or remove one clip (Shift/Cmd-click). */
  toggleClip(id: string): void {
    const { clips } = current;
    selection.selectClips(clips.includes(id) ? clips.filter((clip) => clip !== id) : [...clips, id]);
  },
  /** Call `listener` after every change. Returns an unsubscribe function. */
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

/** Current selection; re-renders the caller when it changes. */
export function useSelection(): Selection {
  return useSyncExternalStore(selection.subscribe, selection.get);
}
