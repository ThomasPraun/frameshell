import { createHash } from "node:crypto";
import { type ShootScript, personNameKey } from "@frameshell/schema";
import { MIN_SIMILARITY, normalizeToken, similarity } from "../transcripts/align.js";
import { type NumberLanguage, numberLanguage, spellNumber } from "./numbers.js";

/**
 * Compare one take against its shoot script (ADR 0023 decision 4), with no clock on the script side.
 *
 * 1. Both sides become normalized tokens (digits spelled out as said).
 * 2. A weighted LCS aligns script tokens to heard tokens. Skipping heard tokens inside a line costs a
 *    little, between lines nothing, so a repeated line matches its last complete attempt and the
 *    earlier attempts fall between lines.
 * 3. Lines mostly matched set the covered span; unmatched heard runs are then read as moved lines,
 *    `FREE` speech, restarts, changed words, and what is left as added speech.
 */

/** A transcribed word of the take, in take seconds. */
export interface HeardWord {
  text: string;
  start: number;
  end: number;
  /** Name of who says it (transcript speaker name or linked person); null when unknown. */
  speaker: string | null;
}

/** Kinds of {@link Deviation}, as ADR 0023 lists them. */
export const DEVIATION_KINDS = ["missing", "changed", "added", "moved", "restart", "pause", "speaker", "length", "free"] as const;
/** See {@link DEVIATION_KINDS}. */
export type DeviationKind = (typeof DEVIATION_KINDS)[number];

/** One difference between a take and its script. */
export interface Deviation {
  /** Stable while the kind, the script line and the heard words stay the same. */
  id: string;
  kind: DeviationKind;
  /** Scene slug; null for speech before the first or after the last scene. */
  scene: string | null;
  /** 1-based file line of the script line; null when no line applies (`length`). */
  line: number | null;
  /** What the script says there (a cue's note for `free`, `<n> s` for `length`, the name for `speaker`). */
  expected: string;
  /** What the take says there. */
  heard: string;
  /** Indexes into the line's `words`, inclusive; null when no script words apply. */
  words: { from: number; to: number } | null;
  /** Take seconds; null when nothing was heard. */
  at: { start: number; end: number } | null;
  /** True when the difference may be the transcription's: a number, a close spelling, one short word. */
  maybeTranscription: boolean;
}

/** How one script line came out in the take. */
export interface LineOutcome {
  scene: string;
  line: number;
  /** `outside`: not in the part of the script the take covers. */
  status: "said" | "partial" | "missing" | "moved" | "outside";
  at: { start: number; end: number } | null;
}

/** Result of {@link compareTake}. */
export interface TakeComparison {
  /** Slugs of the scenes the take covers any line of, in script order. */
  scenes: string[];
  /** Every spoken line of the script, in order. */
  lines: LineOutcome[];
  deviations: Deviation[];
}

/** Score lost per heard token skipped inside a line: a later complete attempt beats a patched earlier one. */
const INSIDE_SKIP = 0.3;
/** Share of a line's tokens matched for the line to count as said. */
const SAID_RATIO = 0.5;
/** Share of a missing line's tokens an unmatched heard run must hold to be that line, moved. */
const MOVED_RATIO = 0.6;
/** Share of an unmatched run's tokens found in a neighbouring line for the run to be a restart of it. */
const RESTART_RATIO = 0.6;
/** Silence inside a line reported as a pause (ADR 0023). */
const PAUSE_S = 1.5;
/** Scene length off its expected length by more than this share is reported (ADR 0023). */
const LENGTH_TOLERANCE = 0.25;
/** Unscripted speech shorter than this is reported (ADR 0023). */
const FREE_MIN_S = 5;
/** Topic mode: similarity at which a heard token counts as a content word of the line. */
const TOPIC_SIMILARITY = 0.8;
/** Topic mode: content words are tokens of at least this many characters. */
const CONTENT_LENGTH = 4;

const DIAG = 1;
const UP = 2;
const LEFT = 3;

interface ScriptToken {
  text: string;
  /** Index into the flattened spoken lines. */
  line: number;
  /** Index into that line's `words`. */
  word: number;
}

interface HeardToken {
  text: string;
  word: number;
}

interface FlatLine {
  scene: string;
  sceneIndex: number;
  line: number;
  words: string[];
  speaker: string | null;
  text: string;
  /** Cues of the line that are `FREE` slots, at a word index. */
  free: { at: number; note: string }[];
  /** First token index of each word, plus one past the end. */
  tokenStart: number[];
}

/** Compare `heard` (in time order) against `script`. `language` is the transcript's, for numbers. */
export function compareTake(script: ShootScript, heard: readonly HeardWord[], language: string | null): TakeComparison {
  const spell = numberLanguage(language);
  const lines: FlatLine[] = [];
  const e: ScriptToken[] = [];
  script.scenes.forEach((scene, sceneIndex) => {
    for (const line of scene.lines) {
      const free = line.cues.filter((cue) => cue.free).map((cue) => ({ at: cue.at, note: cue.text ?? "" }));
      if (line.words.length === 0 && free.length === 0) continue;
      const index = lines.length;
      const tokenStart: number[] = [];
      line.words.forEach((word, w) => {
        tokenStart.push(e.length);
        for (const text of tokens(word, spell)) e.push({ text, line: index, word: w });
      });
      tokenStart.push(e.length);
      lines.push({ scene: scene.slug, sceneIndex, line: line.line, words: line.words, speaker: line.speaker, text: line.text, free, tokenStart });
    }
  });
  const h: HeardToken[] = [];
  heard.forEach((word, index) => {
    for (const text of tokens(word.text, spell)) h.push({ text, word: index });
  });
  const out = script.shoot.follow === "topics" ? compareTopics(lines, e, h, heard) : compareWords(script, lines, e, h, heard);
  const lineText = new Map(lines.map((line) => [line.line, line.text]));
  return { ...out, deviations: withIds(out.deviations, lineText) };
}

function compareWords(script: ShootScript, lines: FlatLine[], e: ScriptToken[], h: HeardToken[], heard: readonly HeardWord[]): Omit<TakeComparison, "deviations"> & { deviations: Omit<Deviation, "id">[] } {
  const matchE = align(e, h);
  const matchH = new Int32Array(h.length).fill(-1);
  matchE.forEach((j, i) => {
    if (j !== -1) matchH[j] = i;
  });

  const ratio = (li: number) => {
    const line = lines[li]!;
    const [from, to] = [line.tokenStart[0]!, line.tokenStart.at(-1)!];
    if (to === from) return 0;
    let matched = 0;
    for (let i = from; i < to; i++) if (matchE[i] !== -1) matched++;
    return matched / (to - from);
  };
  const said = lines.map((_, li) => ratio(li) >= SAID_RATIO);
  let first = said.indexOf(true);
  let last = said.lastIndexOf(true);
  const deviations: Omit<Deviation, "id">[] = [];
  const unmatchE = (i: number) => {
    if (matchE[i] !== -1) matchH[matchE[i]!] = -1;
    matchE[i] = -1;
  };
  if (first === -1) {
    e.forEach((_, i) => unmatchE(i));
    if (heard.length > 0) deviations.push(added(null, null, heard, [...heard.keys()]));
    return { scenes: [], lines: lines.filter((line) => line.words.length > 0).map((line) => ({ scene: line.scene, line: line.line, status: "outside", at: null })), deviations };
  }
  e.forEach((token, i) => {
    if (token.line < first || token.line > last) unmatchE(i);
  });

  /** Heard tokens taken by a moved line, `FREE` speech, a restart or a changed run. */
  const consumed = new Uint8Array(h.length);
  const runs = () => {
    const found: number[][] = [];
    let run: number[] = [];
    for (let j = 0; j <= h.length; j++) {
      if (j < h.length && matchH[j] === -1 && !consumed[j]) run.push(j);
      else if (run.length > 0) {
        found.push(run);
        run = [];
      }
    }
    return found;
  };

  // Moved: a line of the covered scenes not said in place, found whole in an unmatched run.
  const firstScene = lines[first]!.sceneIndex;
  const lastScene = lines[last]!.sceneIndex;
  const moved = new Set<number>();
  lines.forEach((line, li) => {
    if (said[li] || line.sceneIndex < firstScene || line.sceneIndex > lastScene || line.words.length === 0) return;
    const lineTokens = range(line.tokenStart[0]!, line.tokenStart.at(-1)!);
    for (const run of runs()) {
      const pairs = lcs(lineTokens.map((i) => e[i]!.text), run.map((j) => h[j]!.text));
      if (pairs.length < MOVED_RATIO * lineTokens.length) continue;
      for (const [a, b] of pairs) {
        matchE[lineTokens[a]!] = run[b]!;
        matchH[run[b]!] = lineTokens[a]!;
      }
      moved.add(li);
      const at = span(heard, pairs.map(([, b]) => h[run[b]!]!.word));
      deviations.push({ kind: "moved", scene: line.scene, line: line.line, expected: line.text, heard: wordsText(heard, heardWordsOf(h, run.slice(pairs[0]![1], pairs.at(-1)![1] + 1))), words: { from: 0, to: line.words.length - 1 }, at, maybeTranscription: false });
      break;
    }
  });
  for (const li of moved) {
    first = Math.min(first, li);
    last = Math.max(last, li);
  }
  // `FREE`-only lines right around the said ones, in the same scene, are part of what the take covers.
  const freeOnly = (li: number) => lines[li]!.words.length === 0;
  while (first > 0 && freeOnly(first - 1) && lines[first - 1]!.sceneIndex === lines[first]!.sceneIndex) first--;
  while (last < lines.length - 1 && freeOnly(last + 1) && lines[last + 1]!.sceneIndex === lines[last]!.sceneIndex) last++;

  /** Heard index of the nearest matched script token before token `i` (exclusive), or -1. */
  const heardBefore = (i: number) => {
    for (let k = i - 1; k >= 0; k--) if (matchE[k] !== -1 && !moved.has(e[k]!.line)) return matchE[k]!;
    return -1;
  };
  const heardAfter = (i: number) => {
    for (let k = i; k < e.length; k++) if (matchE[k] !== -1 && !moved.has(e[k]!.line)) return matchE[k]!;
    return h.length;
  };
  const freeBetween = (lo: number, hi: number) => range(lo + 1, hi).filter((j) => matchH[j] === -1 && !consumed[j]);

  // FREE slots: unscripted speech between the script words around the cue.
  for (let li = first; li <= last; li++) {
    const line = lines[li]!;
    for (const slot of line.free) {
      const at = line.tokenStart[Math.min(slot.at, line.words.length)]!;
      const inside = freeBetween(heardBefore(at), heardAfter(at));
      for (const j of inside) consumed[j] = 1;
      const words = heardWordsOf(h, inside);
      const where = span(heard, words);
      if (!where || where.end - where.start < FREE_MIN_S) {
        deviations.push({ kind: "free", scene: line.scene, line: line.line, expected: slot.note, heard: wordsText(heard, words), words: null, at: where, maybeTranscription: false });
      }
    }
  }

  // Restarts: an unmatched run that repeats the line next to it.
  for (const run of runs()) {
    const before = scriptTokenBefore(matchH, run[0]!);
    const after = scriptTokenAfter(matchH, run.at(-1)!);
    const candidates = [after, before].filter((i): i is number => i !== null).map((i) => e[i]!.line);
    for (const li of new Set(candidates)) {
      const line = lines[li]!;
      const lineTokens = range(line.tokenStart[0]!, line.tokenStart.at(-1)!).map((i) => e[i]!.text);
      if (lcs(run.map((j) => h[j]!.text), lineTokens).length < RESTART_RATIO * run.length) continue;
      for (const j of run) consumed[j] = 1;
      const words = heardWordsOf(h, run);
      deviations.push({ kind: "restart", scene: line.scene, line: line.line, expected: line.text, heard: wordsText(heard, words), words: null, at: span(heard, words), maybeTranscription: false });
      break;
    }
  }

  // Missing and changed words inside the covered lines.
  for (let li = first; li <= last; li++) {
    const line = lines[li]!;
    if (moved.has(li) || line.words.length === 0) continue;
    const [from, to] = [line.tokenStart[0]!, line.tokenStart.at(-1)!];
    for (let i = from; i < to; ) {
      if (matchE[i] !== -1) {
        i++;
        continue;
      }
      let k = i;
      while (k < to && matchE[k] === -1) k++;
      const inside = freeBetween(heardBefore(i), heardAfter(k));
      for (const j of inside) consumed[j] = 1;
      const words = { from: e[i]!.word, to: e[k - 1]!.word };
      const expected = line.words.slice(words.from, words.to + 1).join(" ");
      const heardWords = heardWordsOf(h, inside);
      if (heardWords.length > 0) {
        const heardText = wordsText(heard, heardWords);
        deviations.push({ kind: "changed", scene: line.scene, line: line.line, expected, heard: heardText, words, at: span(heard, heardWords), maybeTranscription: changedMaybe(expected, heardText) });
      } else {
        deviations.push({ kind: "missing", scene: line.scene, line: line.line, expected, heard: "", words, at: null, maybeTranscription: shortOrNumber(expected) });
      }
      i = k;
    }
  }

  // Close spellings the aligner accepted are still differences.
  for (let li = first; li <= last; li++) {
    const line = lines[li]!;
    line.words.forEach((word, w) => {
      const own = range(line.tokenStart[w]!, line.tokenStart[w + 1]!);
      if (own.length === 0 || own.some((i) => matchE[i] === -1) || own.every((i) => e[i]!.text === h[matchE[i]!]!.text)) return;
      const heardWords = heardWordsOf(h, own.map((i) => matchE[i]!));
      deviations.push({ kind: "changed", scene: line.scene, line: line.line, expected: word, heard: wordsText(heard, heardWords), words: { from: w, to: w }, at: span(heard, heardWords), maybeTranscription: true });
    });
  }

  // Added: what is still unmatched, given to the line before it (or after, at the start).
  for (const run of runs()) {
    const before = scriptTokenBefore(matchH, run[0]!);
    const after = scriptTokenAfter(matchH, run.at(-1)!);
    const owner = before ?? after;
    const line = owner === null ? null : lines[e[owner]!.line]!;
    deviations.push(added(line?.scene ?? null, line?.line ?? null, heard, heardWordsOf(h, run)));
  }

  // Pauses inside a line, and who said it.
  for (let li = first; li <= last; li++) {
    const line = lines[li]!;
    const matched = range(line.tokenStart[0]!, line.tokenStart.at(-1)!).filter((i) => matchE[i] !== -1);
    for (let k = 1; k < matched.length; k++) {
      const a = h[matchE[matched[k - 1]!]!]!.word;
      const b = h[matchE[matched[k]!]!]!.word;
      if (b <= a || heard[b]!.start - heard[a]!.end <= PAUSE_S) continue;
      const words = { from: e[matched[k - 1]!]!.word, to: e[matched[k]!]!.word };
      deviations.push({ kind: "pause", scene: line.scene, line: line.line, expected: "", heard: "", words, at: { start: heard[a]!.end, end: heard[b]!.start }, maybeTranscription: false });
    }
    if (line.speaker === null || matched.length === 0) continue;
    const votes = new Map<string, { name: string; count: number }>();
    for (const word of new Set(matched.map((i) => h[matchE[i]!]!.word))) {
      const name = heard[word]!.speaker;
      if (name === null) continue;
      const vote = votes.get(personNameKey(name)) ?? { name, count: 0 };
      vote.count++;
      votes.set(personNameKey(name), vote);
    }
    const top = [...votes.values()].sort((a, b) => b.count - a.count)[0];
    if (top && personNameKey(top.name) !== personNameKey(line.speaker)) {
      const at = span(heard, matched.map((i) => h[matchE[i]!]!.word));
      deviations.push({ kind: "speaker", scene: line.scene, line: line.line, expected: line.speaker, heard: top.name, words: { from: 0, to: line.words.length - 1 }, at, maybeTranscription: false });
    }
  }

  const outcomes: LineOutcome[] = [];
  lines.forEach((line, li) => {
    if (line.words.length === 0) return;
    const at = span(heard, range(line.tokenStart[0]!, line.tokenStart.at(-1)!).filter((i) => matchE[i] !== -1).map((i) => h[matchE[i]!]!.word));
    const r = ratio(li);
    const status = li < first || li > last ? "outside" : moved.has(li) ? "moved" : r >= SAID_RATIO ? "said" : r > 0 ? "partial" : "missing";
    outcomes.push({ scene: line.scene, line: line.line, status, at: status === "outside" ? null : at });
  });

  // Length of each scene the take covers whole.
  const scenes = [...new Set(lines.slice(first, last + 1).map((line) => line.scene))];
  for (const scene of script.scenes) {
    if (scene.expected === null || !scenes.includes(scene.slug)) continue;
    const own = outcomes.filter((outcome) => outcome.scene === scene.slug);
    if (own.length === 0 || own.some((outcome) => outcome.status === "outside")) continue;
    const times = own.flatMap((outcome) => (outcome.at ? [outcome.at] : []));
    if (times.length === 0) continue;
    const length = Math.max(...times.map((at) => at.end)) - Math.min(...times.map((at) => at.start));
    if (Math.abs(length - scene.expected) <= LENGTH_TOLERANCE * scene.expected) continue;
    deviations.push({ kind: "length", scene: scene.slug, line: null, expected: `${scene.expected} s`, heard: `${round(length)} s`, words: null, at: { start: Math.min(...times.map((at) => at.start)), end: Math.max(...times.map((at) => at.end)) }, maybeTranscription: false });
  }
  return { scenes, lines: outcomes, deviations: sortDeviations(deviations) };
}

/** `follow: topics`: a line is covered when enough of its content words are heard anywhere in the take. */
function compareTopics(lines: FlatLine[], e: ScriptToken[], h: HeardToken[], heard: readonly HeardWord[]): Omit<TakeComparison, "deviations"> & { deviations: Omit<Deviation, "id">[] } {
  const heardTexts = [...new Set(h.map((token) => token.text))];
  const covered = lines.map((line) => {
    if (line.words.length === 0) return false;
    const own = range(line.tokenStart[0]!, line.tokenStart.at(-1)!).map((i) => e[i]!.text);
    const content = own.filter((text) => text.length >= CONTENT_LENGTH);
    const wanted = content.length > 0 ? content : own;
    const found = wanted.filter((text) => heardTexts.some((other) => similarity(text, other) >= TOPIC_SIMILARITY)).length;
    return found >= SAID_RATIO * wanted.length;
  });
  const first = covered.indexOf(true);
  const last = covered.lastIndexOf(true);
  const deviations: Omit<Deviation, "id">[] = [];
  const outcomes: LineOutcome[] = [];
  lines.forEach((line, li) => {
    if (line.words.length === 0) return;
    const inside = first !== -1 && li >= first && li <= last;
    if (inside && !covered[li]) {
      deviations.push({ kind: "missing", scene: line.scene, line: line.line, expected: line.text, heard: "", words: { from: 0, to: line.words.length - 1 }, at: null, maybeTranscription: false });
    }
    outcomes.push({ scene: line.scene, line: line.line, status: !inside ? "outside" : covered[li] ? "said" : "missing", at: null });
  });
  if (first === -1 && heard.length > 0) deviations.push(added(null, null, heard, [...heard.keys()]));
  const scenes = first === -1 ? [] : [...new Set(lines.slice(first, last + 1).map((line) => line.scene))];
  return { scenes, lines: outcomes, deviations };
}

/** Weighted LCS of script against heard tokens; the heard index matched to each script token, or -1. */
function align(e: ScriptToken[], h: HeardToken[]): number[] {
  const n = e.length;
  const m = h.length;
  const matchE = new Array<number>(n).fill(-1);
  if (n === 0 || m === 0) return matchE;
  const sims = new Similarities();
  const steps = new Uint8Array(n * m);
  let prev = new Float64Array(m + 1);
  let cur = new Float64Array(m + 1);
  for (let i = 1; i <= n; i++) {
    // Skipping heard token j costs only while inside a line: between script tokens i-1 and i of one line.
    const skip = i < n && e[i - 1]!.line === e[i]!.line ? INSIDE_SKIP : 0;
    cur[0] = prev[0]!;
    const row = (i - 1) * m;
    const text = e[i - 1]!.text;
    for (let j = 1; j <= m; j++) {
      let best = Number.NEGATIVE_INFINITY;
      let step = UP;
      const sim = sims.get(text, h[j - 1]!.text);
      if (sim >= MIN_SIMILARITY) {
        best = prev[j - 1]! + sim;
        step = DIAG;
      }
      if (prev[j]! > best) {
        best = prev[j]!;
        step = UP;
      }
      if (cur[j - 1]! - skip > best) {
        best = cur[j - 1]! - skip;
        step = LEFT;
      }
      cur[j] = best;
      steps[row + j - 1] = step;
    }
    [prev, cur] = [cur, prev];
  }
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    const step = steps[(i - 1) * m + j - 1];
    if (step === DIAG) {
      matchE[i - 1] = j - 1;
      i--;
      j--;
    } else if (step === UP) i--;
    else j--;
  }
  return matchE;
}

/** Plain LCS of two token lists by similarity; matched index pairs in order. */
function lcs(a: readonly string[], b: readonly string[]): [number, number][] {
  const score = Array.from({ length: a.length + 1 }, () => new Float64Array(b.length + 1));
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const sim = similarity(a[i - 1]!, b[j - 1]!);
      score[i]![j] = Math.max(score[i - 1]![j]!, score[i]![j - 1]!, sim >= MIN_SIMILARITY ? score[i - 1]![j - 1]! + sim : 0);
    }
  }
  const pairs: [number, number][] = [];
  let i = a.length;
  let j = b.length;
  while (i > 0 && j > 0) {
    const sim = similarity(a[i - 1]!, b[j - 1]!);
    if (sim >= MIN_SIMILARITY && score[i]![j] === score[i - 1]![j - 1]! + sim) {
      pairs.push([i - 1, j - 1]);
      i--;
      j--;
    } else if (score[i - 1]![j]! >= score[i]![j - 1]!) i--;
    else j--;
  }
  return pairs.reverse();
}

/** Similarity of two tokens, cached: the aligner asks for the same pairs again and again. */
class Similarities {
  readonly #cache = new Map<string, number>();

  get(a: string, b: string): number {
    if (a === b) return 1;
    const longer = Math.max(a.length, b.length);
    // Cannot reach MIN_SIMILARITY: the edit distance is at least the length difference.
    if (longer <= 2 || 1 - Math.abs(a.length - b.length) / longer < MIN_SIMILARITY) return 0;
    const key = `${a}\0${b}`;
    let value = this.#cache.get(key);
    if (value === undefined) {
      value = similarity(a, b);
      this.#cache.set(key, value);
    }
    return value;
  }
}

/** Comparable tokens of one written or heard word; digits spelled out in `language`. */
function tokens(text: string, language: NumberLanguage | null): string[] {
  return text.split(/\s+/).flatMap((part) => {
    const bare = part.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
    const spelled = language ? spellNumber(bare, language) : null;
    return (spelled ?? [part]).map(normalizeToken).filter((token) => token.length > 0);
  });
}

function added(scene: string | null, line: number | null, heard: readonly HeardWord[], words: number[]): Omit<Deviation, "id"> {
  const text = wordsText(heard, words);
  return { kind: "added", scene, line, expected: "", heard: text, words: null, at: span(heard, words), maybeTranscription: shortOrNumber(text) };
}

/** Script token matched to the nearest matched heard token before heard token `j`; null when none. */
function scriptTokenBefore(matchH: Int32Array, j: number): number | null {
  for (let k = j - 1; k >= 0; k--) if (matchH[k] !== -1) return matchH[k]!;
  return null;
}

function scriptTokenAfter(matchH: Int32Array, j: number): number | null {
  for (let k = j + 1; k < matchH.length; k++) if (matchH[k] !== -1) return matchH[k]!;
  return null;
}

function heardWordsOf(h: readonly HeardToken[], tokens: readonly number[]): number[] {
  return [...new Set(tokens.map((j) => h[j]!.word))].sort((a, b) => a - b);
}

function wordsText(heard: readonly HeardWord[], words: readonly number[]): string {
  return words.map((w) => heard[w]!.text.trim()).join(" ");
}

function span(heard: readonly HeardWord[], words: readonly number[]): { start: number; end: number } | null {
  if (words.length === 0) return null;
  return { start: Math.min(...words.map((w) => heard[w]!.start)), end: Math.max(...words.map((w) => heard[w]!.end)) };
}

function range(from: number, to: number): number[] {
  return Array.from({ length: Math.max(0, to - from) }, (_, k) => from + k);
}

/** A number, or one word of up to 3 letters: transcription often gets these wrong. */
function shortOrNumber(text: string): boolean {
  if (/\p{N}/u.test(text)) return true;
  const words = text.split(/\s+/).filter((word) => normalizeToken(word).length > 0);
  return words.length === 1 && normalizeToken(words[0]!).length <= 3;
}

function changedMaybe(expected: string, heard: string): boolean {
  if (/\p{N}/u.test(expected) || /\p{N}/u.test(heard)) return true;
  const a = expected.split(/\s+/).map(normalizeToken).join("");
  const b = heard.split(/\s+/).map(normalizeToken).join("");
  return similarity(a, b) >= 0.5 || (shortOrNumber(expected) && shortOrNumber(heard));
}

function sortDeviations<T extends Omit<Deviation, "id">>(deviations: T[]): T[] {
  return deviations.sort((a, b) => (a.line ?? Number.MAX_SAFE_INTEGER) - (b.line ?? Number.MAX_SAFE_INTEGER) || (a.at?.start ?? 0) - (b.at?.start ?? 0));
}

/** Ids from what makes a deviation the same one: kind, scene, line text, script words and heard words. */
function withIds(deviations: Omit<Deviation, "id">[], lineText: ReadonlyMap<number, string>): Deviation[] {
  const seen = new Map<string, number>();
  return deviations.map((deviation) => {
    const key = [deviation.kind, deviation.scene ?? "", deviation.line === null ? "" : normalizeText(lineText.get(deviation.line) ?? ""), deviation.words ? `${deviation.words.from}-${deviation.words.to}` : "", normalizeText(deviation.heard), deviation.kind === "length" ? deviation.expected : ""].join("\0");
    const base = `d_${createHash("sha256").update(key).digest("hex").slice(0, 10)}`;
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return { id: count === 0 ? base : `${base}-${count}`, ...deviation };
  });
}

function normalizeText(text: string): string {
  return text.split(/\s+/).map(normalizeToken).filter((token) => token.length > 0).join(" ");
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}
