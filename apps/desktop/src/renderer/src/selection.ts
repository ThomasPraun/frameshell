import { useSyncExternalStore } from "react";

/**
 * What the user has selected, app-wide (SPEC §10). The one selection store
 * of the renderer: the canvas timeline (#14) marks and sets selected clips,
 * the script editor highlights their scenes and selects a scene's clips, the
 * transcript view (#21) selects words and with them a timeline range.
 *
 * Why here and not in the timeline: the canvas keeps only view state
 * (scroll, zoom, hover) and has no selection of its own, while selection is
 * read and set by panels that do not draw clips. The History panel (#18)
 * selects a transaction or operation here: its clips are selected and the
 * timeline highlights what it changed. Timeline editing (#16)
 * acts on it, `ui_state` and `ui_select` (#33) read and set it, "Ask agent"
 * (#49) quotes it, and the player (#15) may follow it. Those extend
 * {@link Selection} here; never keep a second store.
 *
 * Clip ids and ranges are those of {@link SELECTION_TIMELINE}.
 */
/**
 * Who made a selection. Panels react differently to their own selections
 * than to others': the timeline scrolls a clip into view only on a reveal
 * request (a script heading, a History row), never under the user's click;
 * a click on a layer in the preview selects its clip without moving the playhead.
 */
export type SelectionOrigin = "timeline" | "script" | "history" | "transcript" | "preview";

/** Timeline seconds `[from, to)`. */
export interface TimeRange {
  readonly from: number;
  readonly to: number;
}

/**
 * A selected transcript word. Carries its source span so the store can
 * re-place it on any later revision without the transcript file.
 */
export interface SelectedWord {
  /** Transcript file, project-relative, e.g. `transcripts/take.words.json`. */
  readonly transcript: string;
  /** Asset the transcript belongs to. */
  readonly asset: string;
  /** Word id in that file, e.g. `w_000123`. */
  readonly word: string;
  /** Text as shown (human edit applied). */
  readonly text: string;
  /** Source-asset seconds. */
  readonly start: number;
  readonly end: number;
}

/**
 * A request to bring something into view, made with a selection from another
 * panel: a clip, or a range (words). Compared by identity: each request is a
 * new object, so the same heading clicked twice scrolls twice, while pruning
 * keeps the object and never scrolls.
 */
export type RevealRequest =
  /** A clip: the first of the selection when it was made. */
  | {
      readonly clip: string;
      /**
       * Where to look when the clip is not on the timeline (a clip a
       * transaction removed): track id and timeline seconds.
       */
      readonly place?: { readonly track: string; readonly start: number; readonly end: number | null };
      readonly range?: undefined;
    }
  /** Timeline range of selected words when they were selected. */
  | { readonly range: TimeRange; readonly clip?: undefined; readonly place?: undefined };

export interface Selection {
  /** Selected clip ids, in selection order; empty when nothing or words are selected. */
  readonly clips: readonly string[];
  /** Selected words, in transcript order; empty unless words are selected. */
  readonly words: readonly SelectedWord[];
  /** Timeline range the selected words play in; null unless words are selected. */
  readonly range: TimeRange | null;
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

const EMPTY: Selection = { clips: [], words: [], range: null, origin: null, reveal: null, history: null };
let current: Selection = EMPTY;
const listeners = new Set<() => void>();

function replace(next: Selection): void {
  current = next;
  for (const listener of listeners) listener();
}

const sameRange = (a: TimeRange | null, b: TimeRange | null) => a === b || (!!a && !!b && a.from === b.from && a.to === b.to);

/** Smallest range holding every range; null for none. */
export function unionRange(ranges: readonly (TimeRange | null)[]): TimeRange | null {
  let from = Infinity;
  let to = -Infinity;
  for (const range of ranges) {
    if (!range) continue;
    from = Math.min(from, range.from);
    to = Math.max(to, range.to);
  }
  return from < to ? { from, to } : null;
}

/** Read and replace the selection outside React (event handlers, Monaco callbacks). */
export const selection = {
  /** Current selection; the same object until it changes. */
  get: (): Selection => current,
  /**
   * Replace the selection with clips; no-op (no re-render) when clips and
   * origin are unchanged. `reveal` asks panels to bring the first clip into
   * view, as a new {@link RevealRequest} even when nothing else changed.
   */
  selectClips(ids: readonly string[], origin: SelectionOrigin, options: { reveal?: boolean } = {}): void {
    const reveal = options.reveal === true && ids.length > 0;
    const same = current.words.length === 0 && ids.length === current.clips.length && ids.every((id, i) => id === current.clips[i]);
    if (!reveal && same && current.history === null && (ids.length === 0 || (origin === current.origin && current.reveal === null))) return;
    replace(ids.length === 0 ? EMPTY : { ...EMPTY, clips: [...ids], origin, reveal: reveal ? { clip: ids[0]! } : null });
  },
  /**
   * Select transaction or operation `target` from the History panel, with
   * `clips` = the ones it changed that the timeline still has (maybe none).
   * `reveal` becomes a new request every call: a row clicked again scrolls again.
   */
  selectHistory(target: string, clips: readonly string[], reveal: RevealRequest | null): void {
    replace({ ...EMPTY, clips: [...clips], origin: "history", reveal: reveal ? { ...reveal } : null, history: target });
  },
  /** Add or remove one clip (Shift/Cmd-click). */
  toggleClip(id: string, origin: SelectionOrigin): void {
    const { clips } = current;
    selection.selectClips(clips.includes(id) ? clips.filter((clip) => clip !== id) : [...clips, id], origin);
  },
  /**
   * Replace the selection with transcript words playing in `range` on the
   * timeline. `reveal` asks the timeline to bring the range into view and
   * the player to move there. No words or no range selects nothing.
   */
  selectWords(words: readonly SelectedWord[], range: TimeRange | null, origin: SelectionOrigin, options: { reveal?: boolean } = {}): void {
    if (words.length === 0 || !range) {
      selection.clear();
      return;
    }
    const same =
      words.length === current.words.length &&
      words.every((word, i) => word.transcript === current.words[i]!.transcript && word.word === current.words[i]!.word) &&
      sameRange(range, current.range);
    if (same && !options.reveal && origin === current.origin && current.reveal === null) return;
    replace({ ...EMPTY, words: [...words], range, origin, reveal: options.reveal ? { range } : null });
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
  /**
   * Re-place selected words on a new revision of {@link SELECTION_TIMELINE}:
   * `place` gives a word's timeline range now, null once a cut removed it.
   * Removed words are dropped and the range follows the rest (a ripple moves
   * it). Keeps the origin and reveal request; no-op when nothing changed.
   */
  retainWords(place: (word: SelectedWord) => TimeRange | null): void {
    if (current.words.length === 0) return;
    const placed = current.words.map((word) => ({ word, range: place(word) })).filter((entry) => entry.range !== null);
    const range = unionRange(placed.map((entry) => entry.range));
    if (placed.length === current.words.length && sameRange(range, current.range)) return;
    replace(placed.length === 0 || !range ? EMPTY : { ...current, words: placed.map((entry) => entry.word), range });
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
