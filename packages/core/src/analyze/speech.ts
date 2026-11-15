// Sentences of recognised speech. Pure: `audio.ts` measures them, `service.ts` brings the words.

/** A word the transcription heard, seconds on the film's clock. */
export interface HeardWord {
  text: string;
  start: number;
  end: number;
}

/** Pause between two words, seconds, from which a new sentence starts even when no full stop was written. */
export const SENTENCE_GAP_S = 0.8;
/** Shortest span, seconds, a pace is given for. */
export const PACE_MIN_S = 0.3;

const SENTENCE_END = /[.!?…。！？]["'”’)\]]*$/u;
const IS_WORD = /[\p{L}\p{N}]/u;

/** One sentence: its words in order. */
export interface Sentence {
  start: number;
  end: number;
  words: HeardWord[];
}

/**
 * Sentences of `heard`: a new one after a word that ends with `.`, `!`, `?` or `…`, or after a pause of {@link SENTENCE_GAP_S}.
 * Tokens with no letter or digit (a lone dash) are not words and are dropped.
 */
export function sentencesOf(heard: readonly HeardWord[]): Sentence[] {
  const words = heard.filter((word) => IS_WORD.test(word.text) && Number.isFinite(word.start) && word.end >= word.start).sort((a, b) => a.start - b.start);
  const sentences: Sentence[] = [];
  let current: HeardWord[] = [];
  const close = () => {
    if (current.length === 0) return;
    sentences.push({ start: current[0]!.start, end: Math.max(...current.map((word) => word.end)), words: current });
    current = [];
  };
  for (const word of words) {
    const last = current.at(-1);
    if (last && word.start - last.end >= SENTENCE_GAP_S) close();
    current.push(word);
    if (SENTENCE_END.test(word.text.trim())) close();
  }
  close();
  return sentences;
}

/** Text of a sentence: its words joined by a space, as the transcription wrote them. */
export function sentenceText(sentence: Sentence): string {
  return sentence.words.map((word) => word.text.trim()).join(" ");
}

/** Words per second over the span of `sentence`, 2 decimals; null for a span under {@link PACE_MIN_S}. */
export function paceOf(sentence: Sentence): number | null {
  const span = sentence.end - sentence.start;
  return span < PACE_MIN_S ? null : Math.round((sentence.words.length / span) * 100) / 100;
}
