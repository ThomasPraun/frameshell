import type { TranscriptWord } from "@frameshell/plugin-api";
import { HOP_SECONDS } from "./audio.js";

/** One word as whisper.cpp reports it, before timing is fixed. */
export interface EngineWord {
  text: string;
  /** DTW onset, seconds; null when the engine gave none (then `tokenStart` is used). */
  onset: number | null;
  /** Token timestamp start, seconds. Noisy (ADR 0003): fallback only. */
  tokenStart: number;
  confidence?: number;
}

/**
 * Silence shorter than this is a stop closure or a dip, not the gap after a word.
 * 50 ms = 5 frames.
 */
const MIN_GAP_SECONDS = 0.05;

/**
 * DTW onsets lag speech (~140 ms mean, p95 320 ms; ADR 0003), so the next word
 * may already sound this long before its onset. A gap ending earlier than
 * this before the next onset is inside the current word, not after it.
 */
const ONSET_LAG_SECONDS = 0.35;

/**
 * Final word times (ADR 0003): `start` = DTW onset (token start when absent),
 * forced non-decreasing; `end` = next word's start (audio end for the last
 * word) tightened back to the start of the silent gap before it, found in the
 * speech flags. Without such a gap (connected speech) `end` = next start.
 *
 * `speech[i]` covers `[i, i+1) * HOP_SECONDS`; `duration` in seconds.
 */
export function timeWords(words: readonly EngineWord[], speech: readonly boolean[], duration: number): TranscriptWord[] {
  const starts: number[] = [];
  for (const word of words) {
    const raw = word.onset ?? word.tokenStart;
    const previous = starts.at(-1) ?? 0;
    starts.push(round(clamp(Math.max(raw, previous), 0, duration)));
  }
  return words.map((word, index) => {
    const start = starts[index]!;
    const bound = starts[index + 1] ?? round(duration);
    const end = round(Math.max(start, Math.min(bound, gapStart(speech, start, bound) ?? bound)));
    return {
      text: word.text,
      start,
      end: end === start && bound > start ? round(Math.min(bound, start + HOP_SECONDS)) : end,
      ...(word.confidence === undefined ? {} : { confidence: word.confidence }),
    };
  });
}

/**
 * Start (seconds) of the last silent run inside `[start, bound)` that is long
 * enough to be a gap and ends within the onset lag of `bound`; null when none.
 */
function gapStart(speech: readonly boolean[], start: number, bound: number): number | null {
  const first = Math.ceil(start / HOP_SECONDS - 1e-9);
  const last = Math.min(speech.length, Math.floor(bound / HOP_SECONDS + 1e-9));
  const minFrames = Math.round(MIN_GAP_SECONDS / HOP_SECONDS);
  const lagFrames = Math.round(ONSET_LAG_SECONDS / HOP_SECONDS);
  // Frames past the audio (bound beyond the last full frame) count as silence.
  let runEnd = last;
  let i = last - 1;
  while (i >= first && last - runEnd <= lagFrames) {
    if (speech[i]) {
      runEnd = i;
      i--;
      continue;
    }
    let runStart = i;
    while (runStart - 1 >= first && !speech[runStart - 1]) runStart--;
    if (runEnd - runStart >= minFrames || (runEnd === last && runStart === first)) return runStart * HOP_SECONDS;
    i = runStart - 1;
    runEnd = runStart;
  }
  return null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Millisecond precision: finer than whisper's 10 ms and the 3-decimal file format. */
function round(seconds: number): number {
  return Math.round(seconds * 1000) / 1000;
}
