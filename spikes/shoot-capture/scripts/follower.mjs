// Teleprompter follower prototype (pure). Script words + latest recognized words -> index of the last spoken script word.
// Local alignment (Smith-Waterman) of the recent hypothesis tail against a window of the script around the current position.

const ONES = ['cero', 'uno', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho', 'nueve', 'diez', 'once', 'doce', 'trece', 'catorce', 'quince', 'dieciseis', 'diecisiete', 'dieciocho', 'diecinueve', 'veinte'];
const TENS = { 30: 'treinta', 40: 'cuarenta', 50: 'cincuenta', 60: 'sesenta', 70: 'setenta', 80: 'ochenta', 90: 'noventa' };

/** Spanish number words for 0-99, so "30" and "treinta" compare equal. */
export function numberToWords(n) {
  if (n <= 20) return ONES[n];
  if (n < 30) return 'veinti' + ONES[n - 20];
  const t = Math.floor(n / 10) * 10;
  return n % 10 === 0 ? TENS[t] : `${TENS[t]} y ${ONES[n % 10]}`;
}

/** lowercase, no accents, no punctuation, digits spelled out; may return several words. */
export function normalize(text) {
  const t = text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/(\d+)/g, (m) => ` ${+m < 100 ? numberToWords(+m) : m} `)
    .replace(/[^a-z0-9ñ\s]/g, ' ');
  return t.split(/\s+/).filter(Boolean);
}

/** Markdown script -> flat word list [{raw, norm, sentence}] (headings, emphasis, links, code stripped). */
export function tokenizeScript(md) {
  const clean = md.replace(/^#+\s.*$/gm, '').replace(/```[\s\S]*?```/g, '').replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*_`>#-]+/g, ' ');
  const words = []; let sentence = 0;
  for (const para of clean.split(/\n+/)) {
    for (const sent of para.split(/(?<=[.!?¿?])\s+/)) {
      let any = false;
      for (const raw of sent.split(/\s+/).filter(Boolean)) {
        for (const norm of normalize(raw)) { words.push({ raw, norm, sentence }); any = true; }
      }
      if (any) sentence++;
    }
  }
  return words;
}

function lev(a, b) {
  const m = a.length, n = b.length; let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) { const cur = [i]; for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = cur; }
  return prev[n];
}
/** Similarity of a recognized word to a script word: 2 exact, ~1.3 near, 1 truncated prefix, else negative. */
export function wordScore(h, s) {
  if (h === s) return 2;
  if (h.length >= 4 && s.length >= 4) {
    const d = lev(h, s);
    if (d <= 1 || (d <= 2 && Math.min(h.length, s.length) >= 8)) return 1.3;
  }
  if (h.length >= 3 && s.length > h.length && s.startsWith(h)) return 1; // cut at window edge
  return -1.2;
}

export const DEFAULTS = { tail: 8, back: 12, ahead: 28, farForward: 6, minScoreNear: 3, minScoreFar: 5.2, gapScript: -0.9, gapHyp: -0.8 };

/** @returns {{idx:number}} idx = index of last spoken script word, -1 before the first. */
export function createFollower(scriptWords, opts = {}) {
  return { words: scriptWords.map((w) => w.norm), idx: -1, opts: { ...DEFAULTS, ...opts } };
}

/** Pure step. hyp = recognized words (raw strings) of the latest recognition window, newest last. */
export function advance(state, hyp) {
  const o = state.opts; const S = state.words;
  const H = hyp.flatMap(normalize).slice(-o.tail);
  if (!H.length) return { state, changed: false };
  const lo = Math.max(0, state.idx - o.back), hi = Math.min(S.length - 1, state.idx + o.ahead);
  const W = hi - lo + 1; if (W <= 0) return { state, changed: false };
  // DP over H (rows) x script window (cols). Local alignment, tracking matched-word count.
  const sc = Array.from({ length: H.length + 1 }, () => new Float64Array(W + 1));
  const mt = Array.from({ length: H.length + 1 }, () => new Int16Array(W + 1));
  let best = { score: 0, i: 0, j: 0, m: 0 };
  for (let i = 1; i <= H.length; i++) for (let j = 1; j <= W; j++) {
    const ws = wordScore(H[i - 1], S[lo + j - 1]);
    const cands = [
      [sc[i - 1][j - 1] + ws, mt[i - 1][j - 1] + (ws > 0 ? 1 : 0)],
      [sc[i][j - 1] + o.gapScript, mt[i][j - 1]],
      [sc[i - 1][j] + o.gapHyp, mt[i - 1][j]],
      [0, 0],
    ];
    let b = cands[0]; for (const c of cands) if (c[0] > b[0]) b = c;
    sc[i][j] = b[0]; mt[i][j] = b[1];
    // only count ends that are a real match of the last hyp word, prefer later hyp rows, then nearer to idx
    if (ws > 0 && b[0] === cands[0][0]) {
      const better = b[0] > best.score + 1e-9 || (Math.abs(b[0] - best.score) < 1e-9 && Math.abs(lo + j - 1 - (state.idx + 1)) < Math.abs(lo + best.j - 1 - (state.idx + 1)));
      if (better) best = { score: b[0], i, j, m: b[1] };
    }
  }
  if (best.m === 0) return { state, changed: false };
  const pos = lo + best.j - 1; const delta = pos - state.idx;
  const lastStrong = wordScore(H[best.i - 1], S[pos]) >= 1.3;
  let ok;
  if (delta === 0) ok = false;
  else if (delta < 0) ok = best.m >= 3 && best.score >= o.minScoreFar; // restart of a sentence
  else if (delta <= o.farForward) ok = (best.m >= 2 && best.score >= o.minScoreNear) || (best.m === 1 && delta <= 2 && S[pos].length >= 4 && lastStrong);
  else ok = best.m >= 3 && best.score >= o.minScoreFar; // skip ahead needs more evidence
  if (!ok) return { state, changed: false };
  return { state: { ...state, idx: pos }, changed: true, jump: delta, evidence: { score: +best.score.toFixed(2), matched: best.m } };
}
