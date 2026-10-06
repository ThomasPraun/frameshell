import type { TranscriptWord } from "@frameshell/plugin-api";
import { type Transcript, type TranscriptFileWord, wordIdNumber } from "@frameshell/schema";

/** A re-found word may move this far (seconds) and keep its id. */
const SAME_WORD_WINDOW = 0.5;

/** Outcome of {@link assignWordIds}. */
export interface AssignedWords {
  words: TranscriptFileWord[];
  edits: Transcript["edits"];
  reusedIds: number;
  droppedEdits: string[];
  /** High-water mark to persist as the transcript's `nextWordId`. */
  nextWordId: number;
}

/**
 * Give fresh engine words stable ids. A word found again in the previous
 * transcript (same normalized text, start within 0.5 s, in order) keeps its
 * id and its human edit; other words get new ids from the previous
 * `nextWordId`, so an id dropped by any earlier run is never handed out again.
 * Without `nextWordId` (hand-written file), new ids start above every word
 * and edit id in it.
 */
export function assignWordIds(fresh: readonly TranscriptWord[], previous: Transcript | null): AssignedWords {
  const old = previous?.words ?? [];
  // reduce, not Math.max(...ids): long transcripts would overflow the argument list.
  let next = [...old.map((word) => word.id), ...Object.keys(previous?.edits ?? {})].reduce(
    (max, id) => Math.max(max, wordIdNumber(id) + 1),
    previous?.nextWordId ?? 1,
  );
  let cursor = 0;
  let reusedIds = 0;
  const words = fresh.map((word): TranscriptFileWord => {
    const text = normalizeWordText(word.text);
    let id: string | undefined;
    for (let k = cursor; k < old.length && old[k]!.start <= word.start + SAME_WORD_WINDOW; k++) {
      const candidate = old[k]!;
      if (Math.abs(candidate.start - word.start) <= SAME_WORD_WINDOW && normalizeWordText(candidate.text) === text) {
        id = candidate.id;
        cursor = k + 1;
        reusedIds++;
        break;
      }
    }
    return {
      id: id ?? formatId(next++),
      text: word.text,
      start: round(word.start),
      end: round(Math.max(word.end, word.start)),
      ...(word.confidence === undefined ? {} : { confidence: word.confidence }),
    };
  });
  const ids = new Set(words.map((word) => word.id));
  const edits: Transcript["edits"] = {};
  const droppedEdits: string[] = [];
  for (const [id, edit] of Object.entries(previous?.edits ?? {})) {
    if (ids.has(id)) edits[id] = edit;
    else droppedEdits.push(id);
  }
  return { words, edits, reusedIds, droppedEdits, nextWordId: next };
}

/** Word text compared across runs: case and punctuation differ ("Hola," vs "hola"); the word does not. */
export function normalizeWordText(text: string): string {
  return text.toLocaleLowerCase().replace(/[\p{P}\p{S}\s]+/gu, "");
}

function formatId(n: number): string {
  return `w_${String(n).padStart(6, "0")}`;
}

/** SPEC §5.3: times stored with 3 decimals. */
function round(seconds: number): number {
  return Math.round(seconds * 1000) / 1000;
}
