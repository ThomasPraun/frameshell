import { useSyncExternalStore } from "react";

/**
 * What the user has selected, app-wide (SPEC §10). The one selection store
 * of the renderer: the canvas timeline (#14) marks and sets selected clips,
 * the script editor highlights their scenes and selects a scene's clips.
 *
 * Why here and not in the timeline: the canvas keeps only view state
 * (scroll, zoom, hover) and has no selection of its own, while selection is
 * read and set by panels that do not draw clips. The History panel (#18)
 * selects a transaction or operation here: its clips are selected and the
 * timeline highlights what it changed. Timeline editing (#16)
 * acts on it, `ui_state` and `ui_select` (#33) read and set it, "Ask agent"
 * (#49) quotes it, and the player (#15) may follow it. Those extend
 * {@link Selection} (words, time range, other timelines) here; never keep a
 * second store.
 *
 * Clip ids are those of {@link SELECTION_TIMELINE}.
 */
/**
 * Who made a selection. Panels react differently to their own selections
 * than to others': the timeline scrolls a clip into view only when it was
 * selected elsewhere (a script heading, a History row), never under the user's click.
 */
export type SelectionOrigin = "timeline" | "script" | "history";

/**
 * A request to bring a clip into view, made with a selection from another
 * panel. Compared by identity: each request is a new object, so the same
 * heading clicked twice scrolls twice, while pruning keeps the object and
 * never scrolls.
 */
export interface RevealRequest {
  /** Clip to bring into view: the first of the selection when it was made. */
  readonly clip: string;
  /**
   * Where to look when {@link RevealRequest.clip} is not on the timeline
   * (a clip a transaction removed): track id and timeline seconds.
   */
  readonly place?: { readonly track: string; readonly start: number; readonly end: number | null };
}

export interface Selection {
  /** Selected clip ids, in selection order; empty when nothing is selected. */
  readonly clips: readonly string[];
  /** Panel that made this selection; null when empty or pruned to nothing. */
  readonly origin: SelectionOrigin | null;
  /** Latest reveal request, kept until the selection is replaced; null when none. */
  readonly reveal: RevealRequest | null;
  /**
   * Transaction (`tx_…`) or operation (`op_…`) of {@link SELECTION_TIMELINE}'s
   * journal picked in the History panel; the timeline highlights its changes.
   * Null for any other selection. Kept when pruning empties
   * {@link Selection.clips}: what it removed stays highlighted.
   */
  readonly history: string | null;
}

/** Timeline whose clips {@link Selection.clips} names: the one the timeline panel shows. */
export const SELECTION_TIMELINE = "main";

const EMPTY: Selection = { clips: [], origin: null, reveal: null, history: null };
let current: Selection = EMPTY;
const listeners = new Set<() => void>();

function replace(next: Selection): void {
  current = next;
  for (const listener of listeners) listener();
}

/** Read and replace the selection outside React (event handlers, Monaco callbacks). */
export const selection = {
  /** Current selection; the same object until it changes. */
  get: (): Selection => current,
  /**
   * Replace the selected clips; no-op (no re-render) when clips and origin
   * are unchanged. `reveal` asks panels to bring the first clip into view,
   * as a new {@link RevealRequest} even when nothing else changed.
   */
  selectClips(ids: readonly string[], origin: SelectionOrigin, options: { reveal?: boolean } = {}): void {
    const reveal = options.reveal === true && ids.length > 0;
    const same = ids.length === current.clips.length && ids.every((id, i) => id === current.clips[i]);
    if (!reveal && same && current.history === null && (ids.length === 0 || (origin === current.origin && current.reveal === null))) return;
    replace(ids.length === 0 ? EMPTY : { clips: [...ids], origin, reveal: reveal ? { clip: ids[0]! } : null, history: null });
  },
  /**
   * Select transaction or operation `target` from the History panel, with
   * `clips` = the ones it changed that the timeline still has (maybe none).
   * `reveal` becomes a new request every call: a row clicked again scrolls again.
   */
  selectHistory(target: string, clips: readonly string[], reveal: RevealRequest | null): void {
    replace({ clips: [...clips], origin: "history", reveal: reveal ? { ...reveal } : null, history: target });
  },
  /** Add or remove one clip (Shift/Cmd-click). */
  toggleClip(id: string, origin: SelectionOrigin): void {
    const { clips } = current;
    selection.selectClips(clips.includes(id) ? clips.filter((clip) => clip !== id) : [...clips, id], origin);
  },
  /** Select nothing (Esc, another project opened). */
  clear(): void {
    if (current !== EMPTY) replace(EMPTY);
  },
  /**
   * Drop selected clips that are no longer in {@link SELECTION_TIMELINE}
   * (`present` = its clip ids now). Call on every new revision: a removed
   * clip must not stay selected, nor come back selected when an undo
   * restores its id. Keeps the origin and the reveal request (same object:
   * pruning never moves a view); no-op when nothing was dropped.
   */
  retainClips(present: ReadonlySet<string>): void {
    const kept = current.clips.filter((id) => present.has(id));
    if (kept.length === current.clips.length) return;
    replace(kept.length === 0 && current.history === null ? EMPTY : { ...current, clips: kept });
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
