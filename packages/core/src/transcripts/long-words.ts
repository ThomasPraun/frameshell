import type { TranscriptWord } from "@frameshell/plugin-api";
import { ENERGY_HOP_S, type EnergyProfile, energyEnvelope, energyProfile, profileLevel } from "../media/energy.js";
import type { Pcm16 } from "./window.js";

/** A word lasting longer than this (seconds) is checked for speech inside. Spoken words rarely pass 1.2 s. */
export const LONG_WORD_S = 1.5;
/** Seconds at a long word's start that may be the word itself; speech after them is other words. */
const WORD_HEAD_S = 1;
/** Speech (seconds of loud hops) after the head that marks a long word as holding other words. */
const SPEECH_INSIDE_MIN_S = 0.4;
/** Audio kept around a long word when it is re-transcribed alone: its onset may lag speech this much. */
const WINDOW_MARGIN_S = 0.3;

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
 * re-transcribed alone; when that finds more than one word starting inside
 * its span, they replace it, timed inside the span. A long word with silence
 * inside is left alone: that is a pause the word's `end` swallowed, a safe
 * place to cut. Words still long with speech inside afterwards are flagged
 * in `speechInside`, so no one cuts inside them.
 */
export async function recoverLongWords(options: RecoverLongWordsOptions): Promise<RecoveredWords> {
  const { words } = options;
  const none = { words: [...words], recovered: 0, speechInside: words.map(() => false) };
  if (!words.some(isLong)) return none;
  const pcm = await options.loadPcm();
  if (!pcm) return none;
  const profile = energyProfile(energyEnvelope(pcm.samples, pcm.sampleRate));
  const out: TranscriptWord[] = [];
  let recovered = 0;
  for (const word of words) {
    if (!isLong(word) || !hasSpeechInside(word, profile)) {
      out.push(word);
      continue;
    }
    let found: TranscriptWord[];
    try {
      found = await options.transcribeWindow(pcm, Math.max(0, word.start - WINDOW_MARGIN_S), word.end + WINDOW_MARGIN_S);
    } catch {
      out.push(word);
      continue;
    }
    const inside = placeInside(found, word);
    if (inside.length < 2) {
      out.push(word);
      continue;
    }
    out.push(...inside);
    recovered += inside.length - 1;
  }
  return { words: out, recovered, speechInside: out.map((word) => isLong(word) && hasSpeechInside(word, profile)) };
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
 * Window words that start inside `span` (onsets may lead it by the window
 * margin), clamped into it with non-decreasing starts, so the splice keeps
 * the transcript in time order and never overlaps the neighbours.
 */
function placeInside(found: readonly TranscriptWord[], span: TranscriptWord): TranscriptWord[] {
  const placed: TranscriptWord[] = [];
  for (const word of found) {
    if (word.start < span.start - WINDOW_MARGIN_S || word.start >= span.end) continue;
    const start = Math.min(span.end, Math.max(word.start, span.start, placed.at(-1)?.start ?? 0));
    const end = Math.max(start, Math.min(word.end, span.end));
    placed.push({ ...word, start, end });
  }
  return placed;
}
