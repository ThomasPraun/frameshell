// PROTOTYPE. Turns raw run logs (out/<T>.json, out/<T>.f32, out/<T>.cpu.json) into per-cut metrics.
// Usage: node scripts/analyze.mjs [A1 A2 B B-bufsrc]   -> prints a markdown table, writes out/summary.{json,md}
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'out');
const techs = process.argv.slice(2).length ? process.argv.slice(2) : ['A1', 'A2', 'B', 'B-bufsrc'];

const pct = (a, p) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
const r1 = (x) => (Number.isFinite(x) ? Math.round(x * 10) / 10 : null);

function analyzeVideo(R) {
  const FDms = 1000 / R.fps;
  const segOf = new Int32Array(60 * 60 * R.fps * 2).fill(-1);
  R.segs.forEach((s, k) => segOf.fill(k, s.inF, s.outF));
  const probes = R.probe;
  const invalid = probes.filter((p) => p[1] < 0).length;
  // Collapse consecutive identical frame numbers into displays.
  const d = [];
  for (const [t, f] of probes) {
    if (d.length && d[d.length - 1].f === f) continue;
    d.push({ f, t0: t, seg: f >= 0 ? segOf[f] : -1 });
  }
  for (let i = 0; i < d.length; i++) d[i].t1 = i + 1 < d.length ? d[i + 1].t0 : probes[probes.length - 1][0];
  const firstIdx = new Map(), lastIdx = new Map();
  d.forEach((x, i) => { if (x.seg >= 0) { if (!firstIdx.has(x.seg)) firstIdx.set(x.seg, i); lastIdx.set(x.seg, i); } });
  const cuts = [];
  for (let k = 0; k + 1 < R.segs.length; k++) {
    const a = lastIdx.get(k), b = firstIdx.get(k + 1);
    if (a === undefined || b === undefined || b <= a) { cuts.push({ k, missing: true }); continue; }
    const tail = R.segs[k].outF - 1 - d[a].f;
    const head = d[b].f - R.segs[k + 1].inF;
    const strays = d.slice(a + 1, b);
    const gapMs = d[b].t0 - d[a].t0 - FDms; // extra hold of the last old frame
    const firstHoldMs = d[b].t1 - d[b].t0 - FDms; // extra hold of the first new frame
    const freeze = gapMs + firstHoldMs;
    cuts.push({
      k, tail, head, dropped: Math.max(0, tail) + Math.max(0, head),
      strayFrames: strays.length, strayMs: strays.reduce((s, x) => s + (x.t1 - x.t0), 0),
      gapMs, firstHoldMs, freezeMs: freeze, dup: Math.max(0, Math.round(freeze / FDms)),
      videoCutT: d[b].t0,
    });
  }
  // Baseline inside segments (not at cuts): frames never shown and holds longer than 1.5 frames.
  let interiorDrops = 0, interiorFreezes = 0, interiorFrames = 0;
  R.segs.forEach((s, k) => {
    const a = firstIdx.get(k), b = lastIdx.get(k);
    if (a === undefined) return;
    const shown = new Set();
    for (let i = a; i <= b; i++) if (d[i].seg === k) shown.add(d[i].f);
    for (let f = s.inF + 1; f < s.outF - 1; f++) { interiorFrames++; if (!shown.has(f)) interiorDrops++; }
    for (let i = a + 1; i < b; i++) if (d[i].t1 - d[i].t0 > 1.5 * FDms) interiorFreezes++;
  });
  const rafDt = [];
  for (let i = 1; i < probes.length; i++) rafDt.push(probes[i][0] - probes[i - 1][0]);
  const wallS = (d[lastIdx.get(R.segs.length - 1)]?.t1 - d[firstIdx.get(0)]?.t0) / 1000;
  return { cuts, invalid, interiorDrops, interiorFreezes, interiorFrames, rafDt, probeCost: probes.map((p) => p[2]), wallS, probes: probes.length };
}

function analyzeAudio(R, tech) {
  const file = join(out, `${tech}.f32`);
  const buf = readFileSync(file);
  const x = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  const SR = R.sampleRate, f0 = R.recFirstFrame;
  const ctxAt = (i) => (f0 + i) / SR;
  const idxAt = (c) => Math.round(c * SR - f0);
  let a = 0; while (a < x.length && Math.abs(x[a]) < 0.1) a++;
  let b = x.length - 1; while (b > a && Math.abs(x[b]) < 0.1) b--;
  // Raw events. Sine 220 Hz @0.5: natural max |dx| = 0.0144, so 0.05 is a real discontinuity.
  const ev = [];
  let run = 0;
  for (let i = a + 1; i <= b; i++) {
    const v = x[i];
    if (Math.abs(v - x[i - 1]) > 0.05) ev.push({ i, type: 'click' });
    if (Math.abs(v) > 0.6) ev.push({ i, type: 'overlap' });
    if (Math.abs(v) < 0.02) run++;
    else { if (run >= 48) ev.push({ i: i - run, endI: i, type: 'silence', ms: (run / SR) * 1000 }); run = 0; }
  }
  // Cluster within 20 ms.
  const cl = [];
  for (const e of ev) {
    const c = cl[cl.length - 1];
    if (c && e.i - c.end < 0.02 * SR) { c.end = Math.max(c.end, e.endI ?? e.i); c.types.add(e.type); c.silenceMs += e.ms || 0; if (e.type === 'click') c.clicks++; }
    else cl.push({ start: e.i, end: e.endI ?? e.i, types: new Set([e.type]), silenceMs: e.ms || 0, clicks: e.type === 'click' ? 1 : 0 });
  }
  const windows = [];
  for (let k = 0; k + 1 < R.segs.length; k++) {
    let lo, hi, sched;
    if (tech === 'A1') {
      const c = R.cuts.find((q) => q.k === k);
      if (!c || c.swapCtx === undefined) { windows.push(null); continue; }
      lo = c.triggerCtx - 0.15; hi = c.swapCtx + 0.25;
    } else {
      sched = R.startCtx + R.segs[k + 1].pF / R.fps;
      lo = sched - 0.1; hi = sched + 0.1;
    }
    windows.push({ lo: idxAt(lo), hi: idxAt(hi), sched });
  }
  const used = new Set();
  const cuts = windows.map((w, k) => {
    if (!w) return { k, missing: true };
    const mine = cl.filter((c) => c.start <= w.hi && c.end >= w.lo);
    mine.forEach((c) => used.add(c));
    // A1: the splice is heard when the new element's audio resumes (end of the last event).
    const spliceCtx = w.sched ?? (mine.length ? ctxAt(Math.max(...mine.map((c) => c.end))) : null);
    return {
      k, click: mine.some((c) => c.clicks > 0), clicks: mine.reduce((s, c) => s + c.clicks, 0),
      silenceMs: mine.reduce((s, c) => s + c.silenceMs, 0), overlap: mine.some((c) => c.types.has('overlap')),
      spliceCtx,
    };
  });
  const spurious = cl.filter((c) => !used.has(c));
  return { cuts, spurious: spurious.length, spuriousSample: spurious.slice(0, 5).map((c) => ({ ctx: r1(ctxAt(c.start)), types: [...c.types] })) };
}

// Context time -> performance.now() time the sample is heard, from nearest output timestamp.
function ctxToPerf(R, c) {
  let best = R.ots[0];
  for (const o of R.ots) if (o.c > 0 && Math.abs(o.c - c) < Math.abs(best.c - c)) best = o;
  return best.p + (c - best.c) * 1000;
}

const summary = {};
const md = [];
for (const tech of techs) {
  const jf = join(out, `${tech}.json`);
  if (!existsSync(jf)) { console.warn('missing', jf); continue; }
  const R = JSON.parse(readFileSync(jf, 'utf8'));
  const V = analyzeVideo(R);
  const A = analyzeAudio(R, tech);
  const vc = V.cuts.filter((c) => !c.missing);
  const ac = A.cuts.filter((c) => !c.missing);
  const av = [];
  for (const c of vc) {
    const a = A.cuts[c.k];
    if (a && a.spliceCtx != null) av.push(c.videoCutT - ctxToPerf(R, a.spliceCtx));
  }
  let cpu = [];
  try { cpu = JSON.parse(readFileSync(join(out, `${tech}.cpu.json`), 'utf8')).map((s) => s.total).slice(2); } catch {}
  const freezes = vc.map((c) => c.freezeMs);
  const S = {
    technique: tech, reason: R.reason, errors: R.errors, cuts: R.segs.length - 1, cutsMeasured: vc.length,
    programS: r1(R.segs.reduce((s, x) => s + x.outF - x.inF, 0) / R.fps), wallS: r1(V.wallS),
    video: {
      cutsWithDroppedFrames: vc.filter((c) => c.dropped > 0).length,
      droppedFramesTotal: vc.reduce((s, c) => s + c.dropped, 0),
      droppedMax: Math.max(0, ...vc.map((c) => c.dropped)),
      cutsWithFreezeGe1Frame: vc.filter((c) => c.dup >= 1).length,
      dupFramesTotal: vc.reduce((s, c) => s + c.dup, 0),
      freezeMsMean: r1(mean(freezes)), freezeMsP95: r1(pct(freezes, 0.95)), freezeMsMax: r1(Math.max(...freezes)),
      cutsWithStrayFrames: vc.filter((c) => c.strayFrames > 0).length, strayFramesTotal: vc.reduce((s, c) => s + c.strayFrames, 0),
      interiorDrops: V.interiorDrops, interiorFrames: V.interiorFrames, interiorFreezes: V.interiorFreezes,
      invalidProbes: V.invalid, probes: V.probes,
      rafP50: r1(pct(V.rafDt, 0.5)), rafP99: r1(pct(V.rafDt, 0.99)), rafMax: r1(Math.max(...V.rafDt)),
      probeCostMsMean: r1(mean(V.probeCost)), probeCostMsP99: r1(pct(V.probeCost, 0.99)),
    },
    audio: {
      cutsWithClick: ac.filter((c) => c.click).length,
      cutsWithGapGe1ms: ac.filter((c) => c.silenceMs >= 1).length,
      gapMsMean: r1(mean(ac.map((c) => c.silenceMs))), gapMsP95: r1(pct(ac.map((c) => c.silenceMs), 0.95)), gapMsMax: r1(Math.max(0, ...ac.map((c) => c.silenceMs))),
      cutsWithOverlap: ac.filter((c) => c.overlap).length,
      glitchesOutsideCuts: A.spurious, glitchSample: A.spuriousSample, recorderGaps: R.recGaps,
    },
    avOffsetAtCutMs: { n: av.length, mean: r1(mean(av)), p5: r1(pct(av, 0.05)), p95: r1(pct(av, 0.95)), absMax: r1(Math.max(...av.map(Math.abs))) },
    cpuTotalPctMean: r1(mean(cpu)),
    extra: { maxDriftS: R.maxDrift, rateChanges: R.rateChanges, lateReveals: R.lateReveals, seekNotReady: R.seekNotReady, starvedRafs: R.starvedRafs, prerollFrames: R.prerollFrames, decoded: R.decoded, outputLatency: R.outputLatency, baseLatency: R.baseLatency, notes: R.notes },
  };
  summary[tech] = S;
  writeFileSync(join(out, `${tech}.cuts.json`), JSON.stringify({ video: V.cuts, audio: A.cuts }, null, 1));
}

const rows = [
  ['cuts measured', (s) => `${s.cutsMeasured}/${s.cuts}`],
  ['program / wall (s)', (s) => `${s.programS} / ${s.wallS}`],
  ['cuts with dropped frames', (s) => `${s.video.cutsWithDroppedFrames} (total ${s.video.droppedFramesTotal}, max ${s.video.droppedMax})`],
  ['cuts with freeze >= 1 frame', (s) => `${s.video.cutsWithFreezeGe1Frame} (dup total ${s.video.dupFramesTotal})`],
  ['freeze at cut ms mean / p95 / max', (s) => `${s.video.freezeMsMean} / ${s.video.freezeMsP95} / ${s.video.freezeMsMax}`],
  ['cuts showing wrong (stray) frames', (s) => `${s.video.cutsWithStrayFrames} (total ${s.video.strayFramesTotal})`],
  ['interior drops / freezes (baseline)', (s) => `${s.video.interiorDrops} of ${s.video.interiorFrames} / ${s.video.interiorFreezes}`],
  ['audio: cuts with click', (s) => `${s.audio.cutsWithClick}`],
  ['audio: cuts with gap >= 1 ms', (s) => `${s.audio.cutsWithGapGe1ms}`],
  ['audio gap ms mean / p95 / max', (s) => `${s.audio.gapMsMean} / ${s.audio.gapMsP95} / ${s.audio.gapMsMax}`],
  ['audio: cuts with overlap', (s) => `${s.audio.cutsWithOverlap}`],
  ['audio glitches outside cuts', (s) => `${s.audio.glitchesOutsideCuts}`],
  ['A/V offset at cut ms mean [p5, p95]', (s) => `${s.avOffsetAtCutMs.mean} [${s.avOffsetAtCutMs.p5}, ${s.avOffsetAtCutMs.p95}] (n=${s.avOffsetAtCutMs.n})`],
  ['rAF interval ms p50 / p99 / max', (s) => `${s.video.rafP50} / ${s.video.rafP99} / ${s.video.rafMax}`],
  ['probe cost ms mean / p99', (s) => `${s.video.probeCostMsMean} / ${s.video.probeCostMsP99}`],
  ['CPU all processes % mean', (s) => `${s.cpuTotalPctMean}`],
];
const ts = Object.keys(summary);
md.push(`| metric | ${ts.join(' | ')} |`, `|---|${ts.map(() => '---').join('|')}|`);
for (const [name, f] of rows) md.push(`| ${name} | ${ts.map((t) => f(summary[t])).join(' | ')} |`);
console.log(md.join('\n'));
for (const t of ts) console.log(t, JSON.stringify(summary[t].extra), summary[t].errors.length ? summary[t].errors : '');
writeFileSync(join(out, 'summary.json'), JSON.stringify(summary, null, 2));
writeFileSync(join(out, 'summary.md'), md.join('\n') + '\n');
