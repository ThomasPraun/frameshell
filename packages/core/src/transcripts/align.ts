/** A transcribed word on some clock, in seconds. */
export interface TimedWord {
  text: string;
  start: number;
  end: number;
}

/**
 * How one expected word was found in a re-transcription.
 * `heard` holds indexes into the heard list.
 * - `heard`: its text was found in its time slot; `similarity` 1 = same
 *   normalized text, lower = close spelling (`Jimena` / `Ximena`).
 * - `different`: speech was heard in its slot but with other text (`veinte`
 *   heard as `20`, or only part of a multi-word edit). The audio is there.
 * - `missing`: nothing was heard in its slot.
 */
export type WordHearing =
  | { status: "heard"; similarity: number; heard: number[] }
  | { status: "different"; heard: number[] }
  | { status: "missing" };

/** Seconds a heard token may sit from its expected one and still match: DTW onset error p95 0.3 s, worst ~1 s (ADR 0003). */
const MATCH_WINDOW_S = 2;
/** Score lost at the edge of the window, so a repeated phrase goes to its nearest copy. */
const TIME_PENALTY = 0.2;
/** Lowest text similarity a 1:1 match accepts. */
const MIN_SIMILARITY = 0.6;
/** Lowest similarity a split/merge match accepts: stricter, or `a`+`todos` would absorb a lost `a` into `todos`. */
const MIN_MERGE_SIMILARITY = 0.9;
/** An unmatched heard token this close to an expected word's span means speech was there. */
const SLOT_TOLERANCE_S = 0.3;

/** One comparable unit: a word may hold several (`a todos`), punctuation holds none. */
interface Token {
  text: string;
  /** Interpolated inside its word, so tokens stay in time order. */
  time: number;
  word: number;
}

/** Traceback steps. */
const UP = 1; // Skip expected token.
const LEFT = 2; // Skip heard token.
const DIAG = 3; // 1:1 match.
const MERGE_EXPECTED = 4; // Two expected tokens = one heard (`can not` / `cannot`).
const MERGE_HEARD = 5; // One expected token = two heard (`today` / `to day`).

/**
 * Align the words a source transcript expects against a re-transcription of
 * the same speech on the same clock, tolerating how whisper varies between
 * runs: case, punctuation, accents, onset jitter up to ~2 s, words split or
 * merged differently, close spellings, inserted words, and a repeated phrase
 * collapsed into one (the nearest copy in time keeps the match).
 *
 * Token-level weighted LCS: matches score by text similarity minus a small
 * time penalty; skips are free. Only pairs within {@link MATCH_WINDOW_S} are
 * compared, so time and memory stay near linear for real speech. Both lists
 * must be in time order (provider contract); returns one entry per expected
 * word.
 */
export function alignWords(expected: readonly TimedWord[], heard: readonly TimedWord[]): WordHearing[] {
  const e = tokenize(expected);
  const h = tokenize(heard);
  const n = e.length;
  const m = h.length;
  // Score rows i-2, i-1, i; row 0 is all zeros.
  let prev2 = new Float64Array(m + 1);
  let prev = new Float64Array(m + 1);
  let cur = new Float64Array(m + 1);
  // Steps stored only inside each row's band; outside it the step is implied (see traceback).
  const bandLo = new Int32Array(n + 1);
  const bandHi = new Int32Array(n + 1);
  const steps: Uint8Array[] = [new Uint8Array(0)];
  let lo = 1;
  let hi = 0;
  for (let i = 1; i <= n; i++) {
    const t = e[i - 1]!.time;
    while (lo <= m && h[lo - 1]!.time < t - MATCH_WINDOW_S) lo++;
    while (hi < m && h[hi]!.time <= t + MATCH_WINDOW_S) hi++;
    bandLo[i] = lo;
    bandHi[i] = hi;
    const row = new Uint8Array(Math.max(0, hi - lo + 1));
    // Left of the band no match is possible: the best is the row above.
    for (let j = 0; j < Math.min(lo, m + 1); j++) cur[j] = prev[j]!;
    for (let j = lo; j <= hi; j++) {
      let best = prev[j]!;
      let step = UP;
      if (cur[j - 1]! > best) {
        best = cur[j - 1]!;
        step = LEFT;
      }
      const penalty = (TIME_PENALTY * Math.abs(h[j - 1]!.time - t)) / MATCH_WINDOW_S;
      const one = similarity(e[i - 1]!.text, h[j - 1]!.text);
      if (one >= MIN_SIMILARITY && prev[j - 1]! + one - penalty > best) {
        best = prev[j - 1]! + one - penalty;
        step = DIAG;
      }
      if (i >= 2) {
        const merged = similarity(e[i - 2]!.text + e[i - 1]!.text, h[j - 1]!.text);
        if (merged >= MIN_MERGE_SIMILARITY && prev2[j - 1]! + 2 * merged - penalty > best) {
          best = prev2[j - 1]! + 2 * merged - penalty;
          step = MERGE_EXPECTED;
        }
      }
      if (j >= 2) {
        const merged = similarity(e[i - 1]!.text, h[j - 2]!.text + h[j - 1]!.text);
        if (merged >= MIN_MERGE_SIMILARITY && prev[j - 2]! + merged - penalty > best) {
          best = prev[j - 2]! + merged - penalty;
          step = MERGE_HEARD;
        }
      }
      cur[j] = best;
      row[j - lo] = step;
    }
    // Right of the band no heard token can match anything up to here: carry the row's best.
    for (let j = Math.max(lo, hi + 1); j <= m; j++) cur[j] = cur[j - 1]!;
    steps.push(row);
    [prev2, prev, cur] = [prev, cur, prev2];
  }

  // Traceback: token matches as (expected token → heard tokens, similarity).
  const matchedE: ({ heard: number[]; similarity: number } | undefined)[] = new Array(n);
  const matchedH = new Uint8Array(m);
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    let step: number;
    if (j < bandLo[i]!) step = UP;
    else if (j > bandHi[i]!) step = LEFT;
    else step = steps[i]![j - bandLo[i]!]!;
    if (step === UP) i--;
    else if (step === LEFT) j--;
    else if (step === DIAG) {
      matchedE[i - 1] = { heard: [j - 1], similarity: similarity(e[i - 1]!.text, h[j - 1]!.text) };
      matchedH[j - 1] = 1;
      i--;
      j--;
    } else if (step === MERGE_EXPECTED) {
      const sim = similarity(e[i - 2]!.text + e[i - 1]!.text, h[j - 1]!.text);
      matchedE[i - 1] = { heard: [j - 1], similarity: sim };
      matchedE[i - 2] = { heard: [j - 1], similarity: sim };
      matchedH[j - 1] = 1;
      i -= 2;
      j--;
    } else {
      matchedE[i - 1] = { heard: [j - 2, j - 1], similarity: similarity(e[i - 1]!.text, h[j - 2]!.text + h[j - 1]!.text) };
      matchedH[j - 1] = 1;
      matchedH[j - 2] = 1;
      i--;
      j -= 2;
    }
  }

  // Unmatched expected tokens: was other speech heard in their slot, between the same matched neighbours?
  const differentE: (number[] | undefined)[] = new Array(n);
  const nextAnchor = new Int32Array(n + 1).fill(m);
  for (let k = n - 1; k >= 0; k--) nextAnchor[k] = matchedE[k] ? Math.min(...matchedE[k]!.heard) : nextAnchor[k + 1]!;
  let prevAnchor = -1;
  for (let k = 0; k < n; k++) {
    const match = matchedE[k];
    if (match) {
      prevAnchor = Math.max(...match.heard);
      continue;
    }
    const word = expected[e[k]!.word]!;
    const overlapping: number[] = [];
    for (let x = prevAnchor + 1; x < nextAnchor[k + 1]!; x++) {
      if (matchedH[x]) continue;
      const other = heard[h[x]!.word]!;
      if (other.start <= word.end + SLOT_TOLERANCE_S && other.end >= word.start - SLOT_TOLERANCE_S) overlapping.push(x);
    }
    if (overlapping.length > 0) differentE[k] = overlapping;
  }

  // Tokens back to words.
  const byWord = expected.map(() => ({ tokens: 0, matched: 0, similarity: 1, heard: new Set<number>(), different: false }));
  e.forEach((token, k) => {
    const word = byWord[token.word]!;
    word.tokens++;
    const match = matchedE[k];
    if (match) {
      word.matched++;
      word.similarity = Math.min(word.similarity, match.similarity);
      for (const x of match.heard) word.heard.add(h[x]!.word);
    } else if (differentE[k]) {
      word.different = true;
      for (const x of differentE[k]!) word.heard.add(h[x]!.word);
    }
  });
  return byWord.map((word): WordHearing => {
    const heardWords = [...word.heard].sort((a, b) => a - b);
    if (word.matched === word.tokens) return { status: "heard", similarity: round(word.similarity), heard: heardWords };
    if (word.matched > 0 || word.different) return { status: "different", heard: heardWords };
    return { status: "missing" };
  });
}

/** Comparable tokens of `words`, spread evenly over each word's span. */
function tokenize(words: readonly TimedWord[]): Token[] {
  const tokens: Token[] = [];
  words.forEach((word, index) => {
    const parts = word.text.split(/\s+/).map(normalizeToken).filter((part) => part.length > 0);
    const step = parts.length > 1 ? (word.end - word.start) / parts.length : 0;
    parts.forEach((text, k) => tokens.push({ text, time: word.start + k * step, word: index }));
  });
  return tokens;
}

/** `text` as the aligner compares it: tokens normalized by {@link normalizeToken}, space-joined. */
export function comparableText(text: string): string {
  return text.split(/\s+/).map(normalizeToken).filter((part) => part.length > 0).join(" ");
}

/** Lowercase, accents and punctuation gone: `¿Está?` → `esta`. Whisper varies all three between runs. */
function normalizeToken(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLocaleLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, "");
}

/** 1 - edit distance / longer length. Tokens of up to 2 characters must be equal: `de` vs `el` is not a spelling variant. */
function similarity(a: string, b: string): number {
  if (a === b) return 1;
  const longer = Math.max(a.length, b.length);
  if (longer <= 2) return 0;
  return 1 - levenshtein(a, b) / longer;
}

function levenshtein(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, k) => k);
  for (let x = 1; x <= a.length; x++) {
    const next = [x];
    for (let y = 1; y <= b.length; y++) {
      next[y] = Math.min(row[y]! + 1, next[y - 1]! + 1, row[y - 1]! + (a[x - 1] === b[y - 1] ? 0 : 1));
    }
    row = next;
  }
  return row[b.length]!;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
