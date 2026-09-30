import { useSyncExternalStore } from "react";

/**
 * What the user has selected, app-wide (SPEC §10). One store so every panel
 * agrees: the timeline marks selected clips, the script editor highlights
 * their scenes, and later "Ask agent" (#49) and `ui_state` (#33) read it.
 *
 * Minimal on purpose: clip ids of the `main` timeline only. The live
 * timeline (#14) and timeline editing (#16) should extend this store
 * (words, time range, other timelines) instead of keeping their own.
 */
export interface Selection {
  /** Selected clip ids, in selection order; empty when nothing is selected. */
  readonly clips: readonly string[];
}

const EMPTY: Selection = { clips: [] };
let current: Selection = EMPTY;
const listeners = new Set<() => void>();

/** Read and replace the selection outside React (event handlers, Monaco callbacks). */
export const selection = {
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
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

/** Current selection; re-renders the caller when it changes. */
export function useSelection(): Selection {
  return useSyncExternalStore(selection.subscribe, selection.get);
}
