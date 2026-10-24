// Q6: run the follower over the recognition events saved by q5 and score it against the ground-truth word times.
import path from 'node:path';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { ROOT } from './lib.mjs';
import { createFollower, advance } from './follower.mjs';
import { truth, scriptWords } from './truth.mjs';

const only = process.argv.find((a) => a.startsWith('--only='))?.slice(7);
const dir = path.join(ROOT, 'out/q5');
const sw = scriptWords();
const rows = [];
for (const f of readdirSync(dir).filter((f) => /^(cli|server)\..*\.json$/.test(f) && (!only || f.includes(only)))) {
  const { row, events } = JSON.parse(readFileSync(path.join(dir, f), 'utf8'));
  const fx = row.id.split('.').pop();
  const T = truth(fx);
  const anchors = T.words.filter((w) => w.scriptIdx !== null);
  // first time (reporting clock) the follower index reached >= i
  const reach = new Map(); let st = createFollower(sw); const log = [];
  let wrongAhead = 0, wrongAhead4 = 0, backJumps = 0, bigJumps = 0;
  for (const e of events) {
    const r = advance(st, e.words.map((w) => w.text)); st = r.state;
    // truth at the end of this window's audio: highest script idx fully spoken
    const spoken = anchors.filter((a) => a.end <= e.we).reduce((m, a) => Math.max(m, a.scriptIdx), -1);
    if (r.changed) {
      log.push({ t: +e.tReport.toFixed(2), idx: st.idx, jump: r.jump, truth: spoken });
      if (r.jump < 0) backJumps++;
      if (r.jump > 6) bigJumps++;
      if (st.idx > spoken + 2) wrongAhead++;
      if (st.idx > spoken + 4) wrongAhead4++;
      for (let i = st.idx; i >= 0 && !reach.has(i); i--) reach.set(i, e.tReport);
    }
  }
  const lagStart = [], lagEnd = []; let missed = 0;
  for (const a of anchors) {
    // an anchor counts as reached when the follower first reports idx >= scriptIdx; ignore reaches before the word was spoken (restart repeats)
    const t = reach.get(a.scriptIdx);
    if (t === undefined) { missed++; continue; }
    lagStart.push(t - a.start); lagEnd.push(t - a.end);
  }
  const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? +s[Math.min(s.length - 1, Math.floor(s.length * p))].toFixed(2) : null; };
  // recovery after skip (b): first anchor after the skipped sentence (script sentence 2)
  let recovery = null;
  if (fx === 'b') {
    const firstAfter = anchors.find((a) => sw[a.scriptIdx].sentence === 3 && a.scriptIdx === sw.findIndex((w) => w.sentence === 3));
    const t = reach.get(firstAfter.scriptIdx); recovery = t === undefined ? 'never' : { word: firstAfter.w, lagFromWordStartS: +(t - firstAfter.start).toFixed(2), lagFromWordEndS: +(t - firstAfter.end).toFixed(2) };
  }
  // final position vs end of script
  rows.push({ id: row.id, latencyP50Ms: row.latencyMs.p50, anchors: anchors.length, missed, lagBehindWordEndS: { p50: q(lagEnd, 0.5), p90: q(lagEnd, 0.9), max: q(lagEnd, 1) }, lagBehindWordStartS: { p50: q(lagStart, 0.5), p90: q(lagStart, 0.9) }, aheadBy3plus: wrongAhead, aheadBy5plus: wrongAhead4, backJumps, bigForwardJumps: bigJumps, finalIdx: st.idx, scriptWords: sw.length, recovery });
}
rows.sort((a, b) => a.id.localeCompare(b.id));
for (const r of rows) console.log(JSON.stringify(r));
writeFileSync(path.join(ROOT, 'out/q6-report.json'), JSON.stringify(rows, null, 2));
