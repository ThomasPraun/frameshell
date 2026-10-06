import type { TranscriptWord } from "@frameshell/plugin-api";
import { ENERGY_HOP_S, type EnergyProfile, energyEnvelope, energyProfile, profileLevel } from "../media/energy.js";
import { normalizeWordText } from "./ids.js";
import type { Pcm16 } from "./window.js";

/** A word lasting longer than this (seconds) is checked for speech inside. Spoken words rarely pass 1.2 s. */
export const LONG_WORD_S = 1.5;
/** Seconds at a long word's start that may be the word itself; speech after them is other words. */
const WORD_HEAD_S = 1;
/** Speech (seconds of loud hops) after the head that marks a long word as holding other words. */
const SPEECH_INSIDE_MIN_S = 0.4;
/** Audio kept around a long word when it is re-transcribed alone: its onset may lag speech this much. */
const WINDOW_MARGIN_S = 0.3;
/**
 * Long words this close (seconds between one's end and the next's start)
 * share one window, gap included: a swallowed phrase can run across the gap
 * (#117: `incluido.` then `La`).
 */
const MERGE_GAP_S = 2;
/** A window word this close to the next engine word's onset, same text, is that word heard early (ADR 0003: DTW onset worst ~1 s). */
const NEXT_ONSET_LAG_S = 1;

/** Outcome of {@link recoverLongWords}. */
export interface RecoveredWords {
  /** Engine words with each recovered long word replaced by the words found in it, in time order. */
  words: TranscriptWord[];
  /** Words added by splitting long words. */
  recovered: number;
  /** Parallel to `words`: still long, with speech inside after recovery. */
  speechInside: boolean[];
}

/** Input of {@link recoverLongWords}. */
export interface RecoverLongWordsOptions {
  /** Engine words, in time order. */
  words: readonly TranscriptWord[];
  /** Transcription audio; read only when a word is long. Null: not a PCM WAV, nothing is checked. */
  loadPcm(): Promise<Pcm16 | null>;
  /**
   * Re-transcribe `[from, to)` of that audio alone; words on its clock.
   * A rejection keeps the long word as it is (it is still marked).
   */
  transcribeWindow(pcm: Pcm16, from: number, to: number): Promise<TranscriptWord[]>;
}

/**
 * Recover words whisper swallowed into one long word (#117: a repeated
 * phrase came back as `incluido.` spanning 5 s). A word longer than
 * {@link LONG_WORD_S} whose energy shows speech after its first second is
 * re-transcribed alone; such words close together share one window spanning
 * the gap between them. When the window finds more words starting inside
 * that span than it replaces, they replace it, timed inside the span. Window
 * words that repeat a neighbour (the previous word's tail heard in the
 * leading margin, the next word heard before its lagging onset) are dropped,
 * so no word appears twice. A long word with silence inside is left alone:
 * that is a pause the word's `end` swallowed, a safe place to cut. Words
 * still long with speech inside afterwards are flagged in `speechInside`,
 * so no one cuts inside them.
 */
export async function recoverLongWords(options: RecoverLongWordsOptions): Promise<RecoveredWords> {
  const { words } = options;
  const none = { words: [...words], recovered: 0, speechInside: words.map(() => false) };
  if (!words.some(isLong)) return none;
  const pcm = await options.loadPcm();
  if (!pcm) return none;
  const profile = energyProfile(energyEnvelope(pcm.samples, pcm.sampleRate));
  const suspect = (word: TranscriptWord | undefined): boolean => !!word && isLong(word) && hasSpeechInside(word, profile);
  const out: TranscriptWord[] = [];
  let recovered = 0;
  for (let i = 0; i < words.length; ) {
    const word = words[i]!;
    if (!suspect(word)) {
      out.push(word);
      i++;
      continue;
    }
    let last = i;
    while (suspect(words[last + 1]) && words[last + 1]!.start - words[last]!.end < MERGE_GAP_S) last++;
    const run = words.slice(i, last + 1);
    const span = { start: word.start, end: words[last]!.end };
    i = last + 1;
    let found: TranscriptWord[];
    try {
      found = await options.transcribeWindow(pcm, Math.max(0, span.start - WINDOW_MARGIN_S), span.end + WINDOW_MARGIN_S);
    } catch {
      out.push(...run);
      continue;
    }
    const inside = placeInside(dropNeighbours(found, span, out.at(-1), words[i]), span);
    if (inside.length <= run.length) {
      out.push(...run);
      continue;
    }
    out.push(...inside);
    recovered += inside.length - run.length;
  }
  return { words: out, recovered, speechInside: out.map(suspect) };
}

function isLong(word: TranscriptWord): boolean {
  return word.end - word.start > LONG_WORD_S;
}

/** Loud hops after the word's head add up to {@link SPEECH_INSIDE_MIN_S}. */
function hasSpeechInside(word: TranscriptWord, profile: EnergyProfile): boolean {
  let loud = 0;
  for (let t = word.start + WORD_HEAD_S; t < word.end; t += ENERGY_HOP_S) {
    const level = profileLevel(profile, t);
    // +Infinity = past the audio, not speech.
    if (level >= 0 && Number.isFinite(level)) loud += ENERGY_HOP_S;
  }
  return loud >= SPEECH_INSIDE_MIN_S - 1e-9;
}

/**
 * Window words that are not a neighbour heard again: before `span`, the
 * previous word's tail (same text, or ending by the span's start); inside
 * it, the next word heard before its lagging onset (same text, within
 * {@link NEXT_ONSET_LAG_S}).
 */
function dropNeighbours(
  found: readonly TranscriptWord[],
  span: { start: number; end: number },
  previous: TranscriptWord | undefined,
  next: TranscriptWord | undefined,
): TranscriptWord[] {
  const previousText = previous && normalizeWordText(previous.text);
  const nextText = next && normalizeWordText(next.text);
  return found.filter((word) => {
    const text = normalizeWordText(word.text);
    if (word.start < span.start && (word.end <= span.start || text === previousText)) return false;
    if (next && text === nextText && next.start - word.start <= NEXT_ONSET_LAG_S) return false;
    return true;
  });
}

/**
 * Window words that start inside `span` (onsets may lead it by the window
 * margin), clamped into it with non-decreasing starts, so the splice keeps
 * the transcript in time order and never overlaps the neighbours.
 */
function placeInside(found: readonly TranscriptWord[], span: { start: number; end: number }): TranscriptWord[] {
  const placed: TranscriptWord[] = [];
  for (const word of found) {
    if (word.start < span.start - WINDOW_MARGIN_S || word.start >= span.end) continue;
    const start = Math.min(span.end, Math.max(word.start, span.start, placed.at(-1)?.start ?? 0));
    const end = Math.max(start, Math.min(word.end, span.end));
    placed.push({ ...word, start, end });
  }
  return placed;
}
