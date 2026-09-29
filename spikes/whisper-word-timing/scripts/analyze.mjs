// PROTOTYPE. Compares runs in out/ with no human ground truth:
//  1. text agreement between engines (WER),
//  2. boundary offsets between engines on aligned words,
//  3. audio-energy checks: do reported boundaries land in silence or in speech,
//  4. variant consistency: same engine, same words, shifted audio; hallucinations in inserted silence.
// Writes results/summary.json and results/summary.md.
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { MEDIA, OUT, RESULTS, HOP, readWav, energyDb, speechThreshold, silences, pct, mean } from './lib.mjs';

const REF = 'fw-f32-cpu'; // cross-engine reference: independent implementation, same weights.
const PAUSE_MIN = 0.2; // s. Energy pause long enough to be a cut candidate.
const SNAP_WIN = 0.1; // s. ± window for valley snapping (ticket #12).
const CLIP_TOL = 0.02; // s. Two energy frames; below this an "error" is quantization.
const DTW_BIAS = 0.14; // s. Median-ish lateness of whisper.cpp DTW onsets vs energy onsets, measured here.
const AUDIBLE_DB = 40; // dB below speech level still counted as speech.
const MATCH_WIN = 1.0; // s. Max distance to pair a pause edge with a reported boundary.

const runs = {};
for (const f of readdirSync(OUT).filter((f) => f.endsWith('.words.json'))) {
  const r = JSON.parse(readFileSync(join(OUT, f), 'utf8'));
  runs[`${r.run}__${r.audio}`] = r;
}

const audio = {};
for (const a of ['original', 'variant']) {
  const db = energyDb(readWav(join(MEDIA, `${a}.wav`)).pcm);
  // Audibility threshold: within AUDIBLE_DB of the speech level (p90), and above the floor.
  // Fixture's floor-relative threshold is too sensitive on noise-gated audio (floor -90 dBFS):
  // it would call inaudible decay tails "speech".
  const base = speechThreshold(db);
  const th = { ...base, thr: Math.max(base.floor + 10, base.loud - AUDIBLE_DB) };
  audio[a] = { db, ...th, pauses: silences(db, th.thr, PAUSE_MIN) };
}
const variantMap = JSON.parse(readFileSync(join(MEDIA, 'variant.json'), 'utf8'));

const norm = (s) => s.normalize('NFC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
/** Normalized word tokens, keeping index back to the source word. */
function tokens(words) {
  const out = [];
  words.forEach((w, i) => { for (const t of norm(w.text).split(' ').filter(Boolean)) out.push({ t, i }); });
  return out;
}

/** Levenshtein alignment. Returns edit distance and matched index pairs (exact text match). */
function align(a, b) {
  const n = a.length, m = b.length;
  const d = Array.from({ length: n + 1 }, (_, i) => { const r = new Uint32Array(m + 1); r[0] = i; return r; });
  for (let j = 0; j <= m; j++) d[0][j] = j;
  for (let i = 1; i <= n; i++) for (let j = 1; j <= m; j++) {
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1].t === b[j - 1].t ? 0 : 1));
  }
  const pairs = [];
  let i = n, j = m;
  while (i > 0 && j > 0) {
    if (a[i - 1].t === b[j - 1].t && d[i][j] === d[i - 1][j - 1]) { pairs.push([i - 1, j - 1]); i--; j--; }
    else if (d[i][j] === d[i - 1][j - 1] + 1) { i--; j--; }
    else if (d[i][j] === d[i - 1][j] + 1) i--;
    else j--;
  }
  return { dist: d[n][m], pairs: pairs.reverse() };
}

const ms = (x) => (Number.isFinite(x) ? Math.round(x * 1000) : null);
const stats = (arr) => ({ n: arr.length, mean: ms(mean(arr.map(Math.abs))), p95: ms(pct(arr.map(Math.abs), 95)), worst: ms(Math.max(...arr.map(Math.abs))), signedMean: ms(mean(arr)) });
const rate = (k, n) => (n ? +((100 * k) / n).toFixed(1) : null);
const at = (db, t) => db[Math.min(db.length - 1, Math.max(0, Math.round(t / HOP)))];

/**
 * Timing views of a run. whisper.cpp DTW gives one time per token (its onset), so a DTW
 * word end is the next word's DTW onset: no gap information.
 */
function views(r) {
  const v = { tok: r.words.map((w) => ({ ...w })) };
  if (r.words.some((w) => w.dtwStart !== undefined)) {
    v.dtw = r.words.map((w, i) => ({ ...w, start: w.dtwStart ?? w.start, end: r.words[i + 1]?.dtwStart ?? w.end }));
    // Constant lead correction. DTW_BIAS was estimated on this same fixture: optimistic.
    v['dtw-bias'] = v.dtw.map((w) => ({ ...w, start: w.start - DTW_BIAS, end: w.end - DTW_BIAS }));
  }
  return v;
}

/** Energy checks on one word list against its audio. */
function energyChecks(words, A, noEnds) {
  const { db, thr, pauses } = A;
  // (a) Pause edges. Engine-independent pairing: the reported word end nearest to the
  // pause start, and the reported word start nearest to the pause end, within ±MATCH_WIN.
  // Nearest-match flatters every engine equally; unmatched edges count as missed.
  const endErr = [], startErr = [];
  let endClip = 0, startClip = 0, endMiss = 0, startMiss = 0, nPause = 0;
  let endResid = 0, startResid = 0; // clip deeper than SNAP_WIN: snapping within window cannot rescue
  const first = words[0].start, last = words[words.length - 1].end;
  const nearest = (key, t) => words.reduce((b, w) => (Math.abs(w[key] - t) < Math.abs(b - t) ? w[key] : b), Infinity) - t;
  for (const p of pauses) {
    if (p.end < first || p.start > last) continue; // leading/trailing silence
    nPause++;
    const s = nearest('start', p.end); // > 0: starts after speech resumes -> cut clips head
    if (Math.abs(s) > MATCH_WIN) startMiss++; else { startErr.push(s); if (s > CLIP_TOL) startClip++; if (s > SNAP_WIN) startResid++; }
    if (noEnds) continue;
    const e = nearest('end', p.start); // < 0: ends before speech stops -> cut clips tail
    if (Math.abs(e) > MATCH_WIN) endMiss++; else { endErr.push(e); if (e < -CLIP_TOL) endClip++; if (e < -SNAP_WIN) endResid++; }
  }
  // (b) Every inter-word boundary: cut at midpoint of reported gap.
  let inside = 0, insideSnapped = 0, valleyExists = 0;
  const gain = [], dist = [];
  const n = words.length - 1;
  for (let i = 0; i < n; i++) {
    const t = (words[i].end + words[i + 1].start) / 2;
    const e0 = at(db, t);
    if (e0 >= thr) inside++;
    let best = t, be = e0;
    for (let d = -SNAP_WIN; d <= SNAP_WIN + 1e-9; d += HOP) { const e = at(db, t + d); if (e < be) { be = e; best = t + d; } }
    if (be >= thr) insideSnapped++; else valleyExists++;
    gain.push(e0 - be); dist.push(best - t);
  }
  return {
    pauseEdges: { pauses: nPause, end: noEnds ? null : stats(endErr), start: stats(startErr), endClipPct: noEnds ? null : rate(endClip, nPause), startClipPct: rate(startClip, nPause), endMissPct: noEnds ? null : rate(endMiss, nPause), startMissPct: rate(startMiss, nPause), endClipBeyondSnapPct: noEnds ? null : rate(endResid, nPause), startClipBeyondSnapPct: rate(startResid, nPause) },
    allBoundaries: { n, insideSpeechPct: rate(inside, n), insideAfterSnapPct: rate(insideSnapped, n), snapGainDbMean: +mean(gain).toFixed(1), snapShift: stats(dist) },
  };
}

/** Maps a variant time to original time; null inside inserted audio. */
function toOriginal(t) {
  let shift = 0;
  for (const ins of variantMap.inserts) {
    if (t >= ins.variantStart && t < ins.variantEnd) return null;
    if (t >= ins.variantEnd) shift += ins.len;
  }
  return t - shift;
}

const summary = { reference: REF, params: { DTW_BIAS, PAUSE_MIN, SNAP_WIN, CLIP_TOL, MATCH_WIN, AUDIBLE_DB }, audio: {}, runs: {} };
for (const [a, A] of Object.entries(audio)) summary.audio[a] = { floorDb: +A.floor.toFixed(1), speechDb: +A.loud.toFixed(1), thrDb: +A.thr.toFixed(1), pauses: A.pauses.length };

for (const [id, r] of Object.entries(runs)) {
  const A = audio[r.audio];
  const ref = runs[`${REF}__${r.audio}`];
  const out = { run: r.run, audio: r.audio, words: r.words.length, audioSec: +r.audioSec.toFixed(1), wallSec: +r.wallSec.toFixed(1), rtf: +r.rtf.toFixed(3), engineSec: r.engineSec && +r.engineSec.toFixed(1), metalCompileSec: r.metalCompileSec && +r.metalCompileSec.toFixed(1), load1: [r.load1Before, r.load1After].map((x) => +x.toFixed(1)), views: {} };
  const tb = tokens(r.words);
  if (ref && ref !== r) {
    const ta = tokens(ref.words);
    const al = align(ta, tb);
    out.werVsRef = +((100 * al.dist) / ta.length).toFixed(2);
    out._pairs = al.pairs.map(([x, y]) => [ta[x].i, tb[y].i]);
  }
  const base = runs[`wcpp-f16-metal__${r.audio}`];
  if (base && base !== r) {
    const ta = tokens(base.words);
    out.werVsWcppF16 = +((100 * align(ta, tb).dist) / ta.length).toFixed(2);
  }
  for (const [vn, words] of Object.entries(views(r))) {
    const v = { energy: energyChecks(words, A, vn.startsWith('dtw')) };
    if (out._pairs) {
      const ds = [], de = [];
      const seen = new Set();
      for (const [x, y] of out._pairs) {
        if (seen.has(y)) continue; // one timing per word even if it split into several tokens
        seen.add(y);
        ds.push(words[y].start - ref.words[x].start);
        de.push(words[y].end - ref.words[x].end);
      }
      v.vsRef = { start: stats(ds), end: vn.startsWith('dtw') ? null : stats(de) };
    }
    if (r.audio === 'variant' && runs[`${r.run}__original`]) {
      const orig = views(runs[`${r.run}__original`])[vn];
      const to = tokens(orig), tv = tokens(words);
      const al = align(to, tv);
      const shift = [];
      for (const [x, y] of al.pairs) {
        const t = toOriginal(words[tv[y].i].start);
        if (t !== null) shift.push(t - orig[to[x].i].start);
      }
      v.variantConsistency = { werVsOwnOriginal: +((100 * al.dist) / to.length).toFixed(2), startDrift: stats(shift) };
      const inRegion = (ins) => words.filter((w) => w.start >= ins.variantStart && w.start < ins.variantEnd);
      v.inserted = variantMap.inserts.map((ins) => {
        const ws = inRegion(ins);
        const o = { kind: ins.kind, at: ins.at, len: ins.len, wordsInside: ws.length, text: ws.map((w) => w.text).join('').trim().slice(0, 120) };
        if (ins.kind === 'repeat') {
          // Timestamps may smear words into the region, so count words in a ±3 s window
          // around the insert and subtract the same window of the original: the retake
          // was transcribed iff extra == words in the source phrase.
          const [s, e] = ins.src;
          o.srcWords = orig.filter((w) => w.start >= s && w.start < e).length;
          const nv = words.filter((w) => w.start >= ins.variantStart - 3 && w.start < ins.variantEnd + 3).length;
          const no = orig.filter((w) => w.start >= ins.at - 3 && w.start < ins.at + 3).length;
          o.extraWords = nv - no;
          // Wider text window: smeared timestamps can push the retake outside ±3 s.
          const win = words.filter((w) => w.start >= ins.variantStart - 8 && w.start < ins.variantEnd + 8);
          o.windowText = win.map((w) => w.text).join('').trim();
          // Retake transcribed iff some 4-gram appears twice without overlap.
          const tk = norm(o.windowText).split(' ');
          const seen4 = new Map();
          o.retakeInText = false;
          for (let k = 0; k + 4 <= tk.length; k++) {
            const g = tk.slice(k, k + 4).join(' ');
            if (seen4.has(g) && k - seen4.get(g) >= 4) o.retakeInText = true;
            if (!seen4.has(g)) seen4.set(g, k);
          }
        }
        return o;
      });
    }
    out.views[vn] = v;
  }
  delete out._pairs;
  summary.runs[id] = out;
}

mkdirSync(RESULTS, { recursive: true });
writeFileSync(join(RESULTS, 'summary.json'), JSON.stringify(summary, null, 2));

// Markdown tables.
const L = [];
const f = (x) => (x === null || x === undefined ? 'n/a' : x);
const sorted = Object.values(summary.runs).sort((x, y) => (x.audio + x.run).localeCompare(y.audio + y.run));
L.push(`# Spike results (generated by \`npm run analyze\`)`, '');
L.push(`Reference for cross-engine offsets: \`${REF}\`. Energy threshold per file: ${JSON.stringify(summary.audio)}.`, '');
L.push('## Speed and text agreement', '', 'Wall includes process start and model load. Engine s: whisper.cpp `total time` (excludes Metal shader compile) or faster-whisper load + transcribe. Load avg: 1-min load of the machine (8 cores), shared with other jobs during the spike.', '', '| run | audio | words | wall s | RTF (wall) | engine s | Metal shader compile s | load avg before/after | WER vs ref % | WER vs wcpp-f16-metal % |', '|---|---|---|---|---|---|---|---|---|---|');
for (const r of sorted) L.push(`| ${r.run} | ${r.audio} | ${r.words} | ${r.wallSec} | ${r.rtf} | ${f(r.engineSec)} | ${f(r.metalCompileSec)} | ${r.load1.join(' / ')} | ${f(r.werVsRef)} | ${f(r.werVsWcppF16)} |`);
L.push('', '## Boundary offsets vs reference (ms, |x|: mean / p95 / worst; signed mean)', '', '| run | view | audio | start | end |', '|---|---|---|---|---|');
const s3 = (s) => (s && s.n ? `${s.mean} / ${s.p95} / ${s.worst} (${s.signedMean >= 0 ? '+' : ''}${s.signedMean})` : 'n/a');
for (const r of sorted) for (const [vn, v] of Object.entries(r.views)) if (v.vsRef) L.push(`| ${r.run} | ${vn} | ${r.audio} | ${s3(v.vsRef.start)} | ${s3(v.vsRef.end)} |`);
L.push('', '## Energy checks', '', 'Pause edges (energy pauses >= 200 ms): nearest reported word end vs pause start, nearest reported word start vs pause end, within ±1 s (ms; signed mean: end < 0 = ends early, start > 0 = starts late). Speech = energy within 40 dB of the speech level (p90). Clip % = cut at the reported time lands > 20 ms inside speech; clip > 100 ms % = a ±100 ms snap could not rescue it. Miss % = no reported boundary within ±1 s. DTW view has no ends (one time per token).', '');
L.push('| run | view | audio | pauses | end err | end clip % | end miss % | end clip > 100 ms % | start err | start clip % | start miss % | start clip > 100 ms % | all boundaries in speech % | after ±100 ms snap % | snap gain dB |', '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
for (const r of sorted) for (const [vn, v] of Object.entries(r.views)) {
  const e = v.energy;
  L.push(`| ${r.run} | ${vn} | ${r.audio} | ${e.pauseEdges.pauses} | ${s3(e.pauseEdges.end)} | ${f(e.pauseEdges.endClipPct)} | ${f(e.pauseEdges.endMissPct)} | ${f(e.pauseEdges.endClipBeyondSnapPct)} | ${s3(e.pauseEdges.start)} | ${e.pauseEdges.startClipPct} | ${e.pauseEdges.startMissPct} | ${e.pauseEdges.startClipBeyondSnapPct} | ${e.allBoundaries.insideSpeechPct} | ${e.allBoundaries.insideAfterSnapPct} | ${e.allBoundaries.snapGainDbMean} |`);
}
L.push('', '## Variant (inserted silences + repeated phrase)', '', '| run | view | WER vs own original % | start drift (ms) | inserted regions (silence: words timestamped inside it; retake: phrase present twice in text) |', '|---|---|---|---|---|');
for (const r of sorted) for (const [vn, v] of Object.entries(r.views)) if (v.variantConsistency) {
  const ins = v.inserted.map((i) => (i.kind === 'repeat' ? `retake ${i.retakeInText ? "transcribed" : "DROPPED"}` : `sil ${i.len}s: ${i.wordsInside}${i.wordsInside ? ` "${i.text}"` : ''}`)).join('; ');
  L.push(`| ${r.run} | ${vn} | ${v.variantConsistency.werVsOwnOriginal} | ${s3(v.variantConsistency.startDrift)} | ${ins} |`);
}
writeFileSync(join(RESULTS, 'summary.md'), L.join('\n') + '\n');
console.log(L.join('\n'));
