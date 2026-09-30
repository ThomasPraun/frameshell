import { useSyncExternalStore } from "react";

/**
 * What the user has selected, app-wide (SPEC §10). The one selection store
 * of the renderer: the canvas timeline (#14) marks and sets selected clips,
 * the script editor highlights their scenes and selects a scene's clips, the
 * transcript view (#21) selects words and with them a timeline range, the
 * timeline a bare time range, the explorer files, the preview a region.
 *
 * Why here and not in the timeline: the canvas keeps only view state
 * (scroll, zoom, hover) and has no selection of its own, while selection is
 * read and set by panels that do not draw clips. The History panel (#18)
 * selects a transaction or operation here: its clips are selected and the
 * timeline highlights what it changed. A subtitle track (#22) is selected
 * from its lane (alone, or with the words of a cue); the inspector edits its
 * style. Timeline editing (#16)
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
export type SelectionOrigin = "timeline" | "script" | "history" | "transcript" | "explorer" | "preview" | "agent";

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

/** A script scene (SPEC §5.5) picked in the script editor. */
export interface SelectedScene {
  /** Project-relative script, e.g. `scripts/script.md`. */
  readonly script: string;
  /** Heading slug: the `#anchor` of a `scriptRef`. */
  readonly slug: string;
  /** Heading text. */
  readonly title: string;
}

/**
 * A rectangle drawn on the preview. Corners are normalized to the frame
 * (0,0 top left, 1,1 bottom right), `x0 <= x1`, `y0 <= y1`.
 */
export interface SelectedRegion {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
  /** Timeline seconds of the frame it was drawn on. */
  readonly at: number;
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
  /**
   * Timeline range the selected words play in; with no words, a time range
   * selected on the timeline itself. Null otherwise.
   */
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
  /** Project files picked in the explorer (`assets/…` and others), in selection order. */
  readonly files: readonly string[];
  /**
   * Script scene whose clips {@link Selection.clips} are; null otherwise. Kept
   * when pruning empties the clips: the scene is still in the script.
   */
  readonly scene: SelectedScene | null;
  /** Rectangle drawn on the preview; null otherwise. */
  readonly region: SelectedRegion | null;
  /**
   * Track of {@link SELECTION_TIMELINE} picked on its own or whose cue the
   * selected words were picked on (a subtitle track); null otherwise.
   */
  readonly track: string | null;
}

/** Timeline whose clips {@link Selection.clips} names: the one the timeline panel shows. */
export const SELECTION_TIMELINE = "main";

const EMPTY: Selection = {
  clips: [],
  words: [],
  range: null,
  origin: null,
  reveal: null,
  history: null,
  files: [],
  scene: null,
  region: null,
  track: null,
};
let current: Selection = EMPTY;
const listeners = new Set<() => void>();

function replace(next: Selection): void {
  current = next;
  for (const listener of listeners) listener();
}

const sameRange = (a: TimeRange | null, b: TimeRange | null) => a === b || (!!a && !!b && a.from === b.from && a.to === b.to);

/**
 * Where the player follows a reveal request: the playhead time, or null to
 * leave it. Words go to the first frame inside their range, even while
 * playing (click a word to hear it, as in text-based editors). A clip (script
 * heading, History row) goes to `clip.start` only while paused, so selecting
 * elsewhere never jumps playback; `clip` is null when it is nowhere to be found.
 */
export function revealSeek(
  reveal: RevealRequest,
  clip: { readonly start: number } | null,
  transport: { readonly playing: boolean; readonly fps: number },
): number | null {
  // The transport floors to a frame, which could land before the first word.
  if (reveal.range) return Math.ceil(reveal.range.from * transport.fps - 1e-6) / transport.fps;
  return clip && !transport.playing ? clip.start : null;
}

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
    const onlyClips =
      current.words.length === 0 &&
      current.range === null &&
      current.history === null &&
      current.files.length === 0 &&
      current.scene === null &&
      current.region === null &&
      current.track === null;
    const same = onlyClips && ids.length === current.clips.length && ids.every((id, i) => id === current.clips[i]);
    if (!reveal && same && (ids.length === 0 || (origin === current.origin && current.reveal === null))) return;
    replace(ids.length === 0 ? EMPTY : { ...EMPTY, clips: [...ids], origin, reveal: reveal ? { clip: ids[0]! } : null });
  },
  /**
   * Select transaction or operation `target` from the History panel, with
   * `clips` = the ones it changed that the timeline still has (maybe none).
   * `reveal` becomes a new request every call: a row clicked again scrolls again.
   */
  selectHistory(target: string, clips: readonly string[], reveal: RevealRequest | null, origin: SelectionOrigin = "history"): void {
    replace({ ...EMPTY, clips: [...clips], origin, reveal: reveal ? { ...reveal } : null, history: target });
  },
  /**
   * Replace the whole selection at once (`ui_select`): omitted kinds become
   * empty, nothing given clears it. `reveal` brings the first clip, else the
   * range, into view.
   */
  select(
    parts: { clips?: readonly string[]; words?: readonly SelectedWord[]; range?: TimeRange | null },
    origin: SelectionOrigin,
    options: { reveal?: boolean } = {},
  ): void {
    const clips = [...(parts.clips ?? [])];
    const words = [...(parts.words ?? [])];
    const range = parts.range ? { from: parts.range.from, to: parts.range.to } : null;
    if (clips.length === 0 && words.length === 0 && range === null) {
      selection.clear();
      return;
    }
    const reveal: RevealRequest | null = !options.reveal ? null : clips.length > 0 ? { clip: clips[0]! } : range ? { range } : null;
    replace({ ...EMPTY, clips, words, range, origin, reveal });
  },
  /** Add or remove one clip (Shift/Cmd-click). */
  toggleClip(id: string, origin: SelectionOrigin): void {
    const { clips } = current;
    selection.selectClips(clips.includes(id) ? clips.filter((clip) => clip !== id) : [...clips, id], origin);
  },
  /**
   * Replace the selection with transcript words playing in `range` on the
   * timeline. `reveal` asks the timeline to bring the range into view and
   * the player to move there; `track` names the subtitle track whose cue
   * they were picked on. No words or no range selects nothing.
   */
  selectWords(
    words: readonly SelectedWord[],
    range: TimeRange | null,
    origin: SelectionOrigin,
    options: { reveal?: boolean; track?: string } = {},
  ): void {
    if (words.length === 0 || !range) {
      selection.clear();
      return;
    }
    const track = options.track ?? null;
    const same =
      words.length === current.words.length &&
      words.every((word, i) => word.transcript === current.words[i]!.transcript && word.word === current.words[i]!.word) &&
      sameRange(range, current.range) &&
      track === current.track;
    if (same && !options.reveal && origin === current.origin && current.reveal === null) return;
    replace({ ...EMPTY, words: [...words], range, origin, reveal: options.reveal ? { range } : null, track });
  },
  /** Replace the selection with one track (a subtitle lane clicked); no-op when it is already that alone. */
  selectTrack(id: string, origin: SelectionOrigin): void {
    if (current.track === id && current.words.length === 0 && current.clips.length === 0 && current.origin === origin) return;
    replace({ ...EMPTY, track: id, origin });
  },
  /** Replace the selection with a bare timeline range; an empty range selects nothing. */
  selectRange(range: TimeRange, origin: SelectionOrigin): void {
    if (!(range.to > range.from)) {
      selection.clear();
      return;
    }
    if (current.words.length === 0 && current.clips.length === 0 && sameRange(range, current.range) && origin === current.origin) return;
    replace({ ...EMPTY, range: { from: range.from, to: range.to }, origin });
  },
  /** Replace the selection with project files (explorer); none selects nothing. */
  selectFiles(paths: readonly string[], origin: SelectionOrigin): void {
    if (paths.length === 0) {
      selection.clear();
      return;
    }
    if (origin === current.origin && paths.length === current.files.length && paths.every((path, i) => path === current.files[i])) return;
    replace({ ...EMPTY, files: [...paths], origin });
  },
  /** Add or remove one file (Shift/Cmd-click in the explorer). */
  toggleFile(path: string, origin: SelectionOrigin): void {
    const { files } = current;
    selection.selectFiles(files.includes(path) ? files.filter((file) => file !== path) : [...files, path], origin);
  },
  /**
   * Select script scene `scene` with `clips`, the ones realizing it (maybe
   * none). `reveal` asks panels to bring the first clip into view, a new
   * request every call: a heading clicked again scrolls again.
   */
  selectScene(scene: SelectedScene, clips: readonly string[], options: { reveal?: boolean } = {}): void {
    const reveal = options.reveal === true && clips.length > 0 ? { clip: clips[0]! } : null;
    replace({ ...EMPTY, clips: [...clips], origin: "script", reveal, scene: { ...scene } });
  },
  /** Replace the selection with a rectangle drawn on the preview. */
  selectRegion(region: SelectedRegion, origin: SelectionOrigin): void {
    replace({ ...EMPTY, region: { ...region }, origin });
  },
  /**
   * Drop selected files that no longer exist (`present` = every project
   * file now); no-op when nothing was dropped.
   */
  retainFiles(present: ReadonlySet<string>): void {
    const kept = current.files.filter((path) => present.has(path));
    if (kept.length === current.files.length) return;
    replace(kept.length === 0 ? EMPTY : { ...current, files: kept });
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
   * pruning never moves a view), and a History or scene pick whose clips are
   * all gone; no-op when nothing was dropped.
   */
  retainClips(present: ReadonlySet<string>): void {
    const kept = current.clips.filter((id) => present.has(id));
    if (kept.length === current.clips.length) return;
    const rest = current.history !== null || current.scene !== null || current.words.length > 0 || current.range !== null;
    replace(kept.length === 0 && !rest ? EMPTY : { ...current, clips: kept });
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
    // Clips selected with the words (`ui_select`) stay when every word is cut.
    if ((placed.length === 0 || !range) && current.clips.length === 0) replace(EMPTY);
    else replace({ ...current, words: placed.map((entry) => entry.word), range });
  },
  /**
   * Drop the selected track, and words picked on it, once a new revision of
   * {@link SELECTION_TIMELINE} no longer has it (`present` = its track ids).
   */
  retainTrack(present: ReadonlySet<string>): void {
    if (current.track === null || present.has(current.track)) return;
    replace(EMPTY);
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
