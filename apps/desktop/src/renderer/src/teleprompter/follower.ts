// Live follower (ADR 0024 decision 6), ported from the spike's `follower.mjs` (docs/research/shoot-capture.md Q6):
// each recognition window's last words are aligned locally (Smith-Waterman) against the script around the reader,
// and the reader moves only on enough evidence: a few words forward, more for a skip or a restart. Pure.
import { type NumberLanguage, editDistance, spokenTokens } from "@frameshell/schema";
import type { PromptStream } from "./model.js";

/** Tuned on synthetic speech in the spike; one place so real recordings can re-tune them. */
export const FOLLOW_OPTIONS = {
  /** Heard tokens aligned per window: the newest ones. */
  tail: 8,
  /** Script tokens searched behind and ahead of the last spoken one. */
  back: 12,
  ahead: 28,
  /** Up to this many tokens forward is a step; more is a skip and needs the far evidence. */
  farForward: 6,
  /** A step needs 2 matched tokens scoring this much; a skip or a move back, 3 matched scoring `minScoreFar`. */
  minScoreNear: 3,
  minScoreFar: 5.2,
  gapScript: -0.9,
  gapHeard: -0.8,
  /** Seconds without speech at a window's end that end a `[FREE: …]` slot, once something was said in it. */
  freePause: 1.2,
  /** A window where any 3 tokens in a row repeat this often is a recognizer loop and is ignored. */
  loopRepeats: 3,
};

/** {@link FOLLOW_OPTIONS} or a variant of it. */
export type FollowOptions = typeof FOLLOW_OPTIONS;

/** The spoken tokens of a prompt stream, each with the stop it belongs to. */
export interface FollowScript {
  tokens: string[];
  /** Stop of each token. */
  stops: number[];
}

/** Where the follower is. */
export interface FollowState {
  /** Index of the last spoken token; -1 before the first. */
  last: number;
  /** Stops before this one count as passed: a FREE slot left behind. */
  floor: number;
  /** A `[FREE: …]` slot the reader is in, and whether speech was heard there yet; null when none. */
  hold: { stop: number; heard: boolean } | null;
}

/** One recognition window. */
export interface HeardWindow {
  /** Recognized words in order, newest last. */
  words: readonly string[];
  /** Seconds at the window's end with no recognized word. */
  silence: number;
}

/** What one window did. */
export interface FollowStep {
  state: FollowState;
  /** The current stop changed. */
  moved: boolean;
  /** Sentences jumped over, most of them unheard: provisional skipped marks. */
  skipped: number[];
}

/** Tokens of `stream`'s spoken words, numbers spelled out in `language`. FREE slots have none. */
export function followScript(stream: PromptStream, language: NumberLanguage | null): FollowScript {
  const script: FollowScript = { tokens: [], stops: [] };
  stream.stops.forEach((stop, index) => {
    if (stop.kind !== "word") return;
    for (const token of spokenTokens(stop.text, language)) {
      script.tokens.push(token);
      script.stops.push(index);
    }
  });
  return script;
}

/** The follower placed at stop `stop`, as after the person moved there: everything before it said. */
export function followAt(stream: PromptStream, script: FollowScript, stop: number): FollowState {
  let last = -1;
  while (last + 1 < script.stops.length && script.stops[last + 1]! < stop) last++;
  const hold = stream.stops[stop]?.kind === "free" ? { stop, heard: false } : null;
  return { last, floor: stop, hold };
}

/** The stop the reader is on: the held slot, else the first stop after the last spoken token not left behind. */
export function followStop(stream: PromptStream, script: FollowScript, state: FollowState): number {
  if (state.hold) return state.hold.stop;
  const spoken = state.last >= 0 ? script.stops[state.last]! : -1;
  // A word said only in part (a number of several tokens) is still the current one.
  const partial = state.last >= 0 && script.stops[state.last + 1] === spoken;
  const next = partial ? spoken : spoken + 1;
  return Math.min(Math.max(next, state.floor), stream.stops.length - 1);
}

/** Score of a heard token against a script token: 2 equal, 1.3 a near spelling, 1 a word cut at the window's edge, else negative. */
export function tokenScore(heard: string, expected: string): number {
  if (heard === expected) return 2;
  if (heard.length >= 4 && expected.length >= 4) {
    const distance = editDistance(heard, expected);
    if (distance <= 1 || (distance <= 2 && Math.min(heard.length, expected.length) >= 8)) return 1.3;
  }
  if (heard.length >= 3 && expected.length > heard.length && expected.startsWith(heard)) return 1;
  return -1.2;
}

/** Whether `tokens` hold a recognizer loop: some 3 tokens in a row repeated `repeats` times or more. */
export function isLoop(tokens: readonly string[], repeats = FOLLOW_OPTIONS.loopRepeats): boolean {
  const seen = new Map<string, number>();
  for (let i = 0; i + 3 <= tokens.length; i++) {
    const gram = tokens.slice(i, i + 3).join(" ");
    const count = (seen.get(gram) ?? 0) + 1;
    if (count >= repeats) return true;
    seen.set(gram, count);
  }
  return false;
}

/**
 * Follow one recognition window. Windows overlap, so the same words come again and again: a step is idempotent.
 * A lone word, unrelated speech or a recognizer loop never moves the reader. In a FREE slot the reader waits until
 * speech was heard and then stopped for {@link FOLLOW_OPTIONS.freePause}, unless the script goes on with skip-strong
 * evidence.
 */
export function follow(
  stream: PromptStream,
  script: FollowScript,
  state: FollowState,
  window: HeardWindow,
  language: NumberLanguage | null,
  options: FollowOptions = FOLLOW_OPTIONS,
): FollowStep {
  const unchanged: FollowStep = { state, moved: false, skipped: [] };
  const all = window.words.flatMap((word) => spokenTokens(word, language));
  if (state.hold) {
    const hold = all.length > 0 ? { ...state.hold, heard: true } : state.hold;
    if (hold !== state.hold) state = { ...state, hold };
    if (hold.heard && window.silence >= options.freePause) return { state: { ...state, floor: hold.stop + 1, hold: null }, moved: true, skipped: [] };
  }
  const heard = all.slice(-options.tail);
  if (heard.length === 0 || isLoop(all, options.loopRepeats)) return { ...unchanged, state };
  const tokens = script.tokens;
  const lo = Math.max(0, state.last - options.back);
  const hi = Math.min(tokens.length - 1, state.last + options.ahead);
  const width = hi - lo + 1;
  if (width <= 0) return { ...unchanged, state };

  // Local alignment of heard tokens (rows) against the script window (columns), counting matched tokens.
  const cols = width + 1;
  const score = new Float64Array((heard.length + 1) * cols);
  const matched = new Int32Array((heard.length + 1) * cols);
  let best = { score: 0, row: 0, col: 0, matched: 0 };
  const target = state.last + 1;
  for (let i = 1; i <= heard.length; i++) {
    for (let j = 1; j <= width; j++) {
      const at = i * cols + j;
      const diag = (i - 1) * cols + j - 1;
      const left = i * cols + j - 1;
      const up = (i - 1) * cols + j;
      const value = tokenScore(heard[i - 1]!, tokens[lo + j - 1]!);
      const viaDiag = score[diag]! + value;
      let pick = { s: viaDiag, m: matched[diag]! + (value > 0 ? 1 : 0) };
      if (score[left]! + options.gapScript > pick.s) pick = { s: score[left]! + options.gapScript, m: matched[left]! };
      if (score[up]! + options.gapHeard > pick.s) pick = { s: score[up]! + options.gapHeard, m: matched[up]! };
      if (pick.s < 0) pick = { s: 0, m: 0 };
      score[at] = pick.s;
      matched[at] = pick.m;
      // Only a real match of a heard token ends a candidate; ties go to the end nearest the reader.
      if (value > 0 && pick.s === viaDiag) {
        const end = lo + j - 1;
        const better =
          pick.s > best.score + 1e-9 ||
          (Math.abs(pick.s - best.score) < 1e-9 && Math.abs(end - target) < Math.abs(lo + best.col - 1 - target));
        if (better) best = { score: pick.s, row: i, col: j, matched: pick.m };
      }
    }
  }
  if (best.matched === 0) return { ...unchanged, state };
  const position = lo + best.col - 1;
  const jump = position - state.last;
  const strong = tokenScore(heard[best.row - 1]!, tokens[position]!) >= 1.3;
  const far = best.matched >= 3 && best.score >= options.minScoreFar;
  let accept: boolean;
  if (jump === 0) accept = false;
  else if (jump < 0) accept = far;
  else if (jump <= options.farForward) {
    accept = (best.matched >= 2 && best.score >= options.minScoreNear) || (best.matched === 1 && jump <= 2 && tokens[position]!.length >= 4 && strong);
  } else accept = far;
  // In a FREE slot, unscripted speech can match words ahead: only skip-strong evidence leaves it early.
  if (accept && state.hold && !far) accept = false;
  if (!accept) return { ...unchanged, state };

  const before = followStop(stream, script, state);
  let next: FollowState = { last: position, floor: jump < 0 ? 0 : state.floor, hold: null };
  const stop = followStop(stream, script, next);
  if (stream.stops[stop]?.kind === "free") next = { ...next, hold: { stop, heard: false } };
  // Skipped: a sentence jumped over, at least half of what was left of it absent from the window's words. The
  // alignment can bridge a short sentence with gaps, so its path does not tell.
  const landed = followStop(stream, script, next);
  const skipped =
    jump > 0
      ? stream.sentences.flatMap((sentence, index) => {
          if (sentence.end > landed || sentence.end <= before) return [];
          const left = script.tokens.filter((_, token) => script.stops[token]! >= Math.max(sentence.start, before) && script.stops[token]! < sentence.end);
          const bag = [...all];
          const heardThere = left.filter((token) => {
            const found = bag.indexOf(token);
            if (found !== -1) bag.splice(found, 1);
            return found !== -1;
          }).length;
          return left.length > 0 && 2 * heardThere < left.length ? [index] : [];
        })
      : [];
  return { state: next, moved: landed !== before, skipped };
}
