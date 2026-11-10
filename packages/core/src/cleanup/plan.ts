import { type CleanupCandidate, type CleanupResult, CLEANUP_BREATH_DEFAULT_S, CLEANUP_MIN_CONFIDENCE_DEFAULT, CLEANUP_PAUSES_DEFAULT_S } from "@frameshell/protocol";
import { normalizeToken, similarity } from "@frameshell/schema";
import { ENERGY_HOP_S } from "../media/energy.js";
import { FrameGrid } from "../timeline/grid.js";

/**
 * Cuts for dead air and false starts (#455), planned on the timeline clock from the words the timeline keeps and the
 * audio energy under them. Pure: `speech.ts` gathers the inputs, `daemon.ts` makes the cuts.
 */

/** A kept transcript word, placed on the timeline. */
export interface SpeechWord {
  id: string;
  /** As the person corrected it, else as transcribed. */
  text: string;
  /** Project-relative transcript file. */
  transcript: string;
  speaker: string | null;
  /** Timeline seconds the word starts and ends, clamped to the clip that plays it. */
  at: number;
  end: number;
  /** The word hides speech the transcript lacks: never cut around it. */
  speechInside: boolean;
}

/** The speech's sound on the timeline clock. */
export interface SpeechAudio {
  /** dB above the quiet threshold at timeline second `t` (negative = quiet); +Infinity where no speech clip plays. */
  level(t: number): number;
  /** Whether speech clips cover every instant of [from, to). */
  covers(from: number, to: number): boolean;
}

/** What {@link planCleanup} was asked for. */
export interface CleanupPlanOptions {
  fps: number;
  /** Shortest gap to cut as a pause; false = no pause cuts. */
  pauses?: number | false;
  breath?: number;
  retakes?: boolean;
  minConfidence?: number;
}

/** A planned cut before it gets an id. */
type PlannedCut = Omit<CleanupCandidate, "id">;

type Skipped = CleanupResult["skipped"][number];

/** How far into the words around a gap a quiet run may reach: whisper stretches a word over the silence after it. */
const REACH_S = 0.3;
/** Quiet looked for ahead of the first word of a clip. */
const NO_PREVIOUS_S = 0.5;
/** A quiet run shorter than this is not a place to put a cut edge. */
const EDGE_RUN_MIN_S = 0.05;
/** Retakes: longest phrase, words allowed between two attempts, and time from the end of one to the start of the next. */
const RETAKE_MAX_WORDS = 6;
const RETAKE_MAX_BETWEEN = 2;
const RETAKE_WINDOW_S = 2;
/** Retakes: a gap this long between two attempts reads as a stop before the restart. */
const RETAKE_STOP_S = 0.25;
/** Retakes: token similarity at which two spellings are the same word. */
const TOKEN_SIMILARITY = 0.8;
/** Retakes: confidence by phrase length (index = words, 1 to 6). */
const RETAKE_BASE = [0, 0.35, 0.55, 0.7, 0.8, 0.9, 0.9];

/** Pauses and retakes of `words` (timeline order) worth cutting, and the places that were looked at and left. */
export function planCleanup(words: readonly SpeechWord[], audio: SpeechAudio, options: CleanupPlanOptions): { cuts: PlannedCut[]; skipped: Skipped[] } {
  const grid = new FrameGrid(options.fps);
  const breath = options.breath ?? CLEANUP_BREATH_DEFAULT_S;
  const floor = options.minConfidence ?? CLEANUP_MIN_CONFIDENCE_DEFAULT;
  const pauses = options.pauses === undefined ? CLEANUP_PAUSES_DEFAULT_S : options.pauses;
  const skipped: Skipped[] = [];
  const retakes = options.retakes === true ? findRetakes(words, audio, grid, breath, skipped) : [];
  const found = pauses === false ? [] : findPauses(words, audio, grid, breath, pauses, skipped);
  // A retake takes the pauses around and inside it with it, leaving one breath on each side.
  const cuts = [...retakes, ...found.filter((pause) => !retakes.some((retake) => pause.start < retake.end && retake.start < pause.end))];
  const kept = cuts.filter((cut) => {
    if (cut.confidence >= floor) return true;
    skipped.push({ kind: cut.kind, at: cut.start, reason: `confidence ${cut.confidence} is under the floor of ${floor}: ${cut.reason}` });
    return false;
  });
  kept.sort((a, b) => a.start - b.start);
  skipped.sort((a, b) => a.at - b.at);
  return { cuts: kept, skipped };
}

/** Where `audio` is quiet around a gap: the longest quiet run in [lo, hi] that touches [gapLo, gapHi]. */
function quietRun(audio: SpeechAudio, lo: number, hi: number, gapLo: number, gapHi: number): { a: number; b: number } | null {
  const hops = Math.max(0, Math.ceil((hi - lo) / ENERGY_HOP_S - 1e-9));
  let best: { a: number; b: number } | null = null;
  let bestLength = 0;
  let from = -1;
  for (let i = 0; i <= hops; i++) {
    const quiet = i < hops && audio.level(lo + (i + 0.5) * ENERGY_HOP_S) < 0;
    if (quiet) {
      if (from < 0) from = i;
      continue;
    }
    if (from < 0) continue;
    const a = lo + from * ENERGY_HOP_S;
    const b = Math.min(hi, lo + i * ENERGY_HOP_S);
    from = -1;
    if (b < gapLo - ENERGY_HOP_S || a > gapHi + ENERGY_HOP_S) continue;
    if (b - a > bestLength) [best, bestLength] = [{ a, b }, b - a];
  }
  return best;
}

/** The quiet run around the gap between `prev` and `next`, looking up to {@link REACH_S} into either word. */
function runBetween(audio: SpeechAudio, prev: SpeechWord | null, next: SpeechWord): { a: number; b: number } | null {
  // Nothing before `next`: the half second ahead of it is the gap.
  const lo = prev ? Math.max(prev.at, prev.end - REACH_S) : next.at - NO_PREVIOUS_S;
  const hi = Math.min(next.end, next.at + REACH_S);
  return quietRun(audio, lo, hi, prev ? Math.min(prev.end, next.at) : lo, Math.max(prev ? prev.end : next.at, next.at));
}

function findPauses(words: readonly SpeechWord[], audio: SpeechAudio, grid: FrameGrid, breath: number, pauses: number, skipped: Skipped[]): PlannedCut[] {
  const cuts: PlannedCut[] = [];
  for (let i = 1; i < words.length; i++) {
    const [prev, next] = [words[i - 1]!, words[i]!];
    const gap = next.at - prev.end;
    if (gap < pauses - 1e-9) continue;
    const skip = (reason: string) => skipped.push({ kind: "pause", at: prev.end, reason: `${seconds(gap)} s between ${quote(prev)} and ${quote(next)}: ${reason}` });
    if (prev.speechInside || next.speechInside) {
      skip("a word hides speech the transcript lacks");
      continue;
    }
    if (!audio.covers(prev.end, next.at)) {
      skip("other material than the transcribed speech lies there");
      continue;
    }
    const run = runBetween(audio, prev, next);
    if (!run || run.b - run.a < pauses - 1e-9) {
      skip(run ? `only ${seconds(run.b - run.a)} s of it is quiet` : "the audio is not quiet there");
      continue;
    }
    const from = grid.ceil(run.a + breath);
    const to = grid.floor(run.b - breath);
    if (grid.frame(to) <= grid.frame(from)) {
      skip("nothing is left to cut after the breath");
      continue;
    }
    cuts.push({
      kind: "pause",
      start: from,
      end: to,
      duration: round(to - from),
      words: [],
      transcript: null,
      reason: `${seconds(run.b - run.a)} s of silence between ${quote(prev)} and ${quote(next)}`,
      confidence: round(Math.min(1, (run.b - run.a) / gap)),
      clean: true,
    });
  }
  return cuts;
}

interface Attempt {
  /** Indexes into the words: the removed words are [first, until). */
  first: number;
  until: number;
  /** Words in the repeated phrase. */
  length: number;
  between: number;
}

function findRetakes(words: readonly SpeechWord[], audio: SpeechAudio, grid: FrameGrid, breath: number, skipped: Skipped[]): PlannedCut[] {
  const tokens = words.map((word) => normalizeToken(word.text));
  const spoken = words.map((_, index) => index).filter((index) => tokens[index] !== "");
  const same = (x: number, y: number, truncated: boolean): boolean => {
    const [a, b] = [tokens[x]!, tokens[y]!];
    if (words[x]!.speaker !== words[y]!.speaker) return false;
    return a === b || similarity(a, b) >= TOKEN_SIMILARITY || (truncated && a.length >= 2 && b.startsWith(a));
  };
  const found: Attempt[] = [];
  for (let p = 0; p < spoken.length; ) {
    let hit: Attempt | null = null;
    for (let n = Math.min(RETAKE_MAX_WORDS, spoken.length - p); n >= 1 && !hit; n--) {
      for (let between = 0; between <= RETAKE_MAX_BETWEEN && !hit; between++) {
        const q = p + n + between;
        if (q + n > spoken.length) break;
        // A single word repeated is only an attempt when nothing sits between the two.
        if (n === 1 && between > 0) break;
        const last = words[spoken[p + n - 1]!]!;
        if (words[spoken[q]!]!.at - last.end > RETAKE_WINDOW_S) continue;
        let match = true;
        for (let k = 0; k < n && match; k++) match = same(spoken[p + k]!, spoken[q + k]!, k === n - 1);
        if (match) hit = { first: spoken[p]!, until: spoken[q]!, length: n, between };
      }
    }
    if (hit) {
      found.push(hit);
      p = spoken.indexOf(hit.until);
    } else p++;
  }

  const cuts: PlannedCut[] = [];
  for (const attempt of found) {
    const removed = words.slice(attempt.first, attempt.until);
    const [prev, first] = [words[attempt.first - 1] ?? null, words[attempt.first]!];
    const [last, next] = [words[attempt.until - 1]!, words[attempt.until]!];
    const phrase = removed.map((word) => word.text).join(" ");
    const skip = (reason: string) => skipped.push({ kind: "retake", at: first.at, reason: `“${phrase}” said again: ${reason}` });
    if ([prev, ...removed, next].some((word) => word?.speechInside)) {
      skip("a word hides speech the transcript lacks");
      continue;
    }
    const start = edgeAt(audio, prev, first, "start", breath, grid);
    const end = edgeAt(audio, last, next, "end", breath, grid);
    if (grid.frame(end.t) <= grid.frame(start.t)) {
      skip("nothing is left to cut between the two attempts");
      continue;
    }
    if (!audio.covers(start.t, end.t)) {
      skip("other material than the transcribed speech lies there");
      continue;
    }
    const stop = next.at - last.end >= RETAKE_STOP_S;
    const confidence = RETAKE_BASE[attempt.length]! + (stop ? 0.15 : 0) - (attempt.between > 0 ? 0.15 : 0) - (start.clean ? 0 : 0.15) - (end.clean ? 0 : 0.15);
    cuts.push({
      kind: "retake",
      start: start.t,
      end: end.t,
      duration: round(end.t - start.t),
      words: removed.map((word) => ({ id: word.id, text: word.text })),
      transcript: first.transcript,
      reason: `“${phrase}” said again${stop ? " after a stop" : ""}; the last take is kept`,
      confidence: round(Math.min(1, Math.max(0, confidence))),
      clean: start.clean && end.clean,
    });
  }
  return mergeOverlapping(cuts);
}

/**
 * A cut edge in the gap between `prev` and `next`: inside the quiet run there with `breath` kept on the
 * word's side; where the audio is not quiet, the middle of the gap (unclean).
 */
function edgeAt(audio: SpeechAudio, prev: SpeechWord | null, next: SpeechWord, side: "start" | "end", breath: number, grid: FrameGrid): { t: number; clean: boolean } {
  const run = runBetween(audio, prev, next);
  if (run && run.b - run.a >= EDGE_RUN_MIN_S) {
    const middle = (run.a + run.b) / 2;
    return side === "start" ? { t: grid.ceil(Math.min(run.a + breath, middle)), clean: true } : { t: grid.floor(Math.max(run.b - breath, middle)), clean: true };
  }
  const between = prev ? (prev.end + next.at) / 2 : next.at;
  return { t: side === "start" ? grid.ceil(between) : grid.floor(between), clean: false };
}

/** A phrase said three times has two overlapping attempts: one cut. */
function mergeOverlapping(cuts: PlannedCut[]): PlannedCut[] {
  const merged: PlannedCut[] = [];
  for (const cut of [...cuts].sort((a, b) => a.start - b.start)) {
    const before = merged.at(-1);
    if (!before || cut.start >= before.end) {
      merged.push(cut);
      continue;
    }
    before.end = Math.max(before.end, cut.end);
    before.duration = round(before.end - before.start);
    before.words.push(...cut.words);
    before.confidence = Math.min(before.confidence, cut.confidence);
    before.clean = before.clean && cut.clean;
    before.reason = `“${before.words.map((word) => word.text).join(" ")}” said again, more than once; the last take is kept`;
  }
  return merged;
}

const quote = (word: SpeechWord) => `“${word.text}”`;
const round = (value: number) => Math.round(value * 1000) / 1000;
const seconds = (value: number) => round(value).toFixed(2).replace(/0$/, "");
