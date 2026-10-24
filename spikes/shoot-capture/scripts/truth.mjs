// Ground truth for the speech fixtures: word times (proportional to characters inside each sentence segment,
// whose bounds are exact because the fixture is concatenated from per-sentence `say` files) and script indices.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from './lib.mjs';
import { SCRIPT, VARIANTS } from './speech-data.mjs';
import { normalize, tokenizeScript, wordScore } from './follower.mjs';

// spoken sentence i of variant -> script sentence index (null = none)
export const MAPPING = { a: [0, 1, 2, 3, 4, 5, 6], b: [0, 1, 3, 4, 4, 5, 6] };

export function scriptWords() { return tokenizeScript(SCRIPT.join('\n\n')); }

export function truth(name) {
  const segs = JSON.parse(readFileSync(path.join(ROOT, `media/speech/${name}.segments.json`), 'utf8'));
  const sw = scriptWords();
  const words = [];
  segs.forEach((seg, si) => {
    const ws = normalize(seg.text); const weights = ws.map((w) => w.length + 2); const tot = weights.reduce((a, b) => a + b, 0);
    // trim ~60 ms of leading/trailing silence say adds
    const t0 = seg.start + 0.06, t1 = seg.end - 0.06; let t = t0;
    const cand = sw.map((w, i) => ({ ...w, i })).filter((w) => w.sentence === MAPPING[name][si]);
    // global alignment of spoken words to the script sentence (NW), to give each spoken word its script index
    const n = ws.length, m = cand.length; const D = Array.from({ length: n + 1 }, () => new Float64Array(m + 1));
    for (let i = 1; i <= n; i++) D[i][0] = -i; for (let j = 1; j <= m; j++) D[0][j] = -j;
    for (let i = 1; i <= n; i++) for (let j = 1; j <= m; j++) D[i][j] = Math.max(D[i - 1][j - 1] + (wordScore(ws[i - 1], cand[j - 1].norm) > 0 ? 2 : -1), D[i - 1][j] - 1, D[i][j - 1] - 1);
    const map = new Array(n).fill(null); let i = n, j = m;
    while (i > 0 && j > 0) {
      if (D[i][j] === D[i - 1][j - 1] + (wordScore(ws[i - 1], cand[j - 1].norm) > 0 ? 2 : -1)) { if (wordScore(ws[i - 1], cand[j - 1].norm) > 0) map[i - 1] = cand[j - 1].i; i--; j--; }
      else if (D[i][j] === D[i - 1][j] - 1) i--; else j--;
    }
    ws.forEach((w, k) => { const d = (t1 - t0) * weights[k] / tot; words.push({ w, start: +t.toFixed(3), end: +(t + d).toFixed(3), scriptIdx: map[k], sentence: si }); t += d; });
  });
  return { segs, words, duration: segs.at(-1).end };
}
