// PROTOTYPE. Checks out/summary.json against the ADR 0001 pass thresholds for #15 and prints
// which ones each technique fails. Threshold 4's sample-exact clause is not in summary.json:
// run audio-residual.mjs for it. Wall time is rounded to 0.1 s in the summary.
// Usage: node scripts/check-thresholds.mjs
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const S = JSON.parse(readFileSync(join(root, 'out', 'summary.json'), 'utf8'));
const pct = (a, b) => (100 * a) / b;
for (const [name, r] of Object.entries(S)) {
  const v = r.video, a = r.audio, av = r.avOffsetAtCutMs;
  const t = {
    1: [v.cutsWithStrayFrames === 0 && v.droppedFramesTotal === 0,
      `stray ${v.strayFramesTotal}, dropped at cuts ${v.droppedFramesTotal}`],
    2: [pct(v.cutsWithFreezeGe1Frame, r.cuts) <= 5 && v.freezeMsP95 <= 17 && v.freezeMsMax <= 167,
      `freeze cuts ${pct(v.cutsWithFreezeGe1Frame, r.cuts).toFixed(1)} %, p95 ${v.freezeMsP95}, max ${v.freezeMsMax} ms`],
    3: [pct(v.interiorDrops, v.interiorFrames) <= 0.1,
      `interior drops ${v.interiorDrops}/${v.interiorFrames} = ${pct(v.interiorDrops, v.interiorFrames).toFixed(2)} %`],
    4: [a.cutsWithClick === 0 && a.cutsWithGapGe1ms === 0 && a.cutsWithOverlap === 0 && a.repeatedQuanta === 0,
      `clicks ${a.cutsWithClick}, gaps ${a.cutsWithGapGe1ms}, overlaps ${a.cutsWithOverlap}, repeated quanta ${a.repeatedQuanta}`],
    5: [Math.abs(av.p5) <= 20 && Math.abs(av.p95) <= 20, `A/V p5 ${av.p5}, p95 ${av.p95} ms`],
    6: [pct(Math.abs(r.wallS - r.programS), r.programS) <= 0.1,
      `wall ${r.wallS} s vs ${r.programS} s = ${pct(Math.abs(r.wallS - r.programS), r.programS).toFixed(2)} %`],
  };
  const failed = Object.keys(t).filter((k) => !t[k][0]);
  console.log(`${name}: ${failed.length ? `fails ${failed.join(', ')}` : 'passes 1-6'}`);
  for (const [k, [ok, msg]] of Object.entries(t)) console.log(`  ${k} ${ok ? 'pass' : 'FAIL'}  ${msg}`);
}
