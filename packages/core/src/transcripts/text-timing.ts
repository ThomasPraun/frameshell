// Times for a transcript that came as plain text (ADR 0046 decision 11): a text-only cloud model gives spelling,
// case and punctuation; whisper.cpp on this machine gives timed words of the same audio. The text is laid over them.
import type { TranscriptWord } from "@frameshell/plugin-api";
import { normalizeToken, similarity } from "@frameshell/schema";
import { MIN_SIMILARITY } from "./align.js";

/** A word of the text with its times, and the timed words it took them from. */
export interface TimedTextWord extends TranscriptWord {
  /** Indexes into the timed words this word matched (one) or was spread over (zero or more). */
  from: number[];
}

/** What {@link timeText} found. */
export interface TimedText {
  /** One entry per word of the text, in order. */
  words: TimedTextWord[];
  /** Words of the text whose spelling matched a timed word; the others were timed between their neighbours. */
  matched: number;
}

/** Half width of the alignment band, at least: how far the two word lists may drift apart, in words. */
const MIN_BAND = 150;
/** Share of the longer list added to the band, for long recordings where the drift grows. */
const BAND_SHARE = 0.05;

/**
 * Lay `text` over `timed`, the words whisper.cpp heard in the same audio, on the same clock. Words of the text are
 * split at spaces; a token with no letters or digits (`—`, `¿`) joins the next word, or the previous one at the end.
 * Each word whose normalized spelling is close to a timed word (similarity at least {@link MIN_SIMILARITY}, matched
 * in order by a weighted LCS) takes that word's times. Words between two matches share the time of the timed words
 * between them, in proportion to their length; when there are none (`cannot` heard as `can not`), they share the time
 * of the matched word before them (else after). With no match at all the words share the span of all timed words,
 * else `[0, seconds]`. Times have 3 decimals; every word ends at or after its start; starts never go back.
 */
export function timeText(text: string, timed: readonly TranscriptWord[], seconds: number): TimedText {
  const words = textWords(text);
  const keys = words.map(normalizeToken);
  const heard = timed.map((word) => normalizeToken(word.text));
  const pairs = alignTokens(keys, heard);
  const out: TimedTextWord[] = words.map((word) => ({ text: word, start: 0, end: 0, from: [] }));
  for (const [i, j] of pairs) {
    out[i]!.start = timed[j]!.start;
    out[i]!.end = timed[j]!.end;
    out[i]!.from = [j];
  }

  // Runs of unmatched words between anchors (matched pairs), with the timed words between those anchors.
  const anchors: [number, number][] = [[-1, -1], ...pairs, [words.length, timed.length]];
  for (let a = 0; a + 1 < anchors.length; a++) {
    const [i0, j0] = anchors[a]!;
    const [i1, j1] = anchors[a + 1]!;
    const run = range(i0 + 1, i1);
    if (run.length === 0) continue;
    const between = range(j0 + 1, j1);
    if (between.length > 0) {
      spread(out, run, timed[between[0]!]!.start, timed[between.at(-1)!]!.end, words);
      for (const i of run) out[i]!.from = between;
      continue;
    }
    if (pairs.length === 0) {
      // Nothing matched and nothing heard: spread over the audio.
      spread(out, run, 0, Math.max(0, seconds), words);
      continue;
    }
    // No timed word between the anchors: share the matched word before (else after).
    const host = i0 >= 0 ? i0 : i1;
    const shared = host === i0 ? [i0, ...run] : [...run, i1];
    spread(out, shared, out[host]!.start, out[host]!.end, words);
    for (const i of run) out[i]!.from = [...out[host]!.from];
  }

  let floor = 0;
  for (const word of out) {
    word.start = Math.max(floor, round(word.start));
    word.end = Math.max(word.start, round(word.end));
    floor = word.start;
  }
  return { words: out, matched: pairs.length };
}

/** Words of `text` at spaces; a token without letters or digits joins its neighbour. */
export function textWords(text: string): string[] {
  const out: string[] = [];
  let pending = "";
  for (const token of text.split(/\s+/).filter(Boolean)) {
    if (!/[\p{L}\p{N}]/u.test(token)) {
      if (out.length > 0 && !/^[¿¡([{«"'“‘]/u.test(token)) out[out.length - 1] += token;
      else pending += token;
      continue;
    }
    out.push(pending + token);
    pending = "";
  }
  if (pending && out.length > 0) out[out.length - 1] += pending;
  return out;
}

/**
 * Pairs `[i, j]` of `a[i]` matched with `b[j]`, both in order: the weighted LCS where a pair scores its similarity
 * (at least {@link MIN_SIMILARITY}) and skips are free. Only cells within a band around the diagonal are computed,
 * so an hour of speech stays a few megabytes.
 */
export function alignTokens(a: readonly string[], b: readonly string[]): [number, number][] {
  const n = a.length;
  const m = b.length;
  if (n === 0 || m === 0) return [];
  const band = Math.max(MIN_BAND, Math.ceil(BAND_SHARE * Math.max(n, m)), Math.ceil(m / n) + 2);
  const width = 2 * band + 1;
  const lo = (i: number) => Math.max(0, Math.round((i * m) / n) - band);
  const hi = (i: number) => Math.min(m, Math.round((i * m) / n) + band);
  // Step taken into cell (i, j): 0 unreached, 1 skip a, 2 skip b, 3 match.
  const steps = new Uint8Array((n + 1) * width);
  let prev = new Float64Array(width).fill(Number.NEGATIVE_INFINITY);
  for (let j = lo(0); j <= hi(0); j++) prev[j - lo(0)] = 0;
  for (let i = 1; i <= n; i++) {
    const from = lo(i);
    const to = hi(i);
    const above = lo(i - 1);
    const aboveTo = hi(i - 1);
    const cur = new Float64Array(width).fill(Number.NEGATIVE_INFINITY);
    const up = (j: number) => (j >= above && j <= aboveTo ? prev[j - above]! : Number.NEGATIVE_INFINITY);
    for (let j = from; j <= to; j++) {
      let best = up(j);
      let step = 1;
      if (j === 0) {
        best = Math.max(best, 0);
      } else {
        const left = j - 1 >= from ? cur[j - 1 - from]! : Number.NEGATIVE_INFINITY;
        if (left > best) {
          best = left;
          step = 2;
        }
        const score = similarity(a[i - 1]!, b[j - 1]!);
        if (a[i - 1] && score >= MIN_SIMILARITY) {
          const diagonal = up(j - 1) + score;
          if (diagonal > best) {
            best = diagonal;
            step = 3;
          }
        }
      }
      cur[j - from] = best;
      steps[i * width + (j - from)] = best === Number.NEGATIVE_INFINITY ? 0 : step;
    }
    prev = cur;
  }

  const pairs: [number, number][] = [];
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    const step = j >= lo(i) && j <= hi(i) ? steps[i * width + (j - lo(i))]! : 0;
    if (step === 3) {
      pairs.push([i - 1, j - 1]);
      i--;
      j--;
    } else if (step === 2) j--;
    else i--; // Skip a, or a cell outside the band: walk back up toward the start.
  }
  return pairs.reverse();
}

/** Give the words at `indexes` consecutive shares of `[start, end]`, in proportion to their length. */
function spread(out: TimedTextWord[], indexes: readonly number[], start: number, end: number, words: readonly string[]): void {
  const weights = indexes.map((i) => Math.max(1, normalizeToken(words[i]!).length));
  const total = weights.reduce((sum, w) => sum + w, 0);
  const span = Math.max(0, end - start);
  let at = start;
  indexes.forEach((index, k) => {
    const share = (span * weights[k]!) / total;
    out[index]!.start = at;
    out[index]!.end = at + share;
    at += share;
  });
}

/** `[from, to)` as a list. */
function range(from: number, to: number): number[] {
  return Array.from({ length: Math.max(0, to - from) }, (_, k) => from + k);
}

/** SPEC §5.3: times with 3 decimals. */
function round(seconds: number): number {
  return Math.round(seconds * 1000) / 1000;
}
