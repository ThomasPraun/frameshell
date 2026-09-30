// ADR 0001 measurement analysis for the real preview, ported from spikes/gapless-preview/scripts (analyze.mjs,
// audio-residual.mjs, repeated-quanta.mjs, check-thresholds.mjs). Pure: raw logs in, metrics and verdicts out.

/** Kept segment of the cut list: source frames `[inF, outF)` play from program frame `pF`. */
export interface Segment {
  inF: number;
  outF: number;
  pF: number;
}

/** Everything one measured playback produced. */
export interface RunLog {
  fps: number;
  sampleRate: number;
  segments: Segment[];
  /** Per display frame (page rAF): [performance ms, source frame shown or -1]. */
  probes: [number, number][];
  /** Program sample `sample` played at context frame `frame`. */
  anchor: { frame: number; sample: number };
  /** Context frame of `audio[0]`; audio is the graph output as the recorder heard it (mono). */
  audioStart: number;
  audio: Float32Array;
  /** Recorder blocks that did not follow the previous one. */
  audioGaps: number;
  /** AudioContext output timestamps: context seconds heard at page performance ms. */
  timestamps: { contextTime: number; performanceTime: number }[];
  /** Expected program sample `p` = `expected(p)`, fades included; null when not checked. */
  expected: ((sample: number) => number) | null;
}

const pct = (a: number[], p: number) => {
  if (a.length === 0) return Number.NaN;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
};
const mean = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : Number.NaN);
const r1 = (x: number) => (Number.isFinite(x) ? Math.round(x * 10) / 10 : Number.NaN);

/** Metrics named as in ADR 0001's results table. */
export interface Summary {
  cuts: number;
  cutsMeasured: number;
  programS: number;
  wallS: number;
  video: {
    strayFramesTotal: number;
    cutsWithStrayFrames: number;
    droppedFramesTotal: number;
    cutsWithFreezeGe1Frame: number;
    freezeMsMean: number;
    freezeMsP95: number;
    freezeMsMax: number;
    interiorDrops: number;
    interiorFrames: number;
    invalidProbes: number;
    rafP99: number;
  };
  audio: {
    cutsWithClick: number;
    cutsWithGapGe1ms: number;
    cutsWithOverlap: number;
    repeatedQuanta: number;
    deviatingSamples: number | null;
    comparedSamples: number | null;
    recorderGaps: number;
  };
  avOffsetAtCutMs: { n: number; mean: number; p5: number; p95: number };
}

/** Analyze one run (same definitions as the spike). */
export function analyze(run: RunLog): Summary {
  const video = analyzeVideo(run);
  const audio = analyzeAudio(run);
  const av: number[] = [];
  for (const cut of video.cuts) {
    if (cut.missing) continue;
    const spliceCtx = (run.anchor.frame + run.segments[cut.k + 1]!.pF * (run.sampleRate / run.fps) - run.anchor.sample) / run.sampleRate;
    av.push(cut.videoCutT - ctxToPerf(run, spliceCtx));
  }
  const measured = video.cuts.filter((c) => !c.missing);
  const freezes = measured.map((c) => c.freezeMs);
  return {
    cuts: run.segments.length - 1,
    cutsMeasured: measured.length,
    programS: r1(run.segments.reduce((s, x) => s + x.outF - x.inF, 0) / run.fps),
    wallS: r1(video.wallS),
    video: {
      strayFramesTotal: measured.reduce((s, c) => s + c.strayFrames, 0),
      cutsWithStrayFrames: measured.filter((c) => c.strayFrames > 0).length,
      droppedFramesTotal: measured.reduce((s, c) => s + c.dropped, 0),
      cutsWithFreezeGe1Frame: measured.filter((c) => c.dup >= 1).length,
      freezeMsMean: r1(mean(freezes)),
      freezeMsP95: r1(pct(freezes, 0.95)),
      freezeMsMax: r1(Math.max(...freezes)),
      interiorDrops: video.interiorDrops,
      interiorFrames: video.interiorFrames,
      invalidProbes: video.invalid,
      rafP99: r1(pct(video.rafDt, 0.99)),
    },
    audio: {
      cutsWithClick: audio.cuts.filter((c) => c.click).length,
      cutsWithGapGe1ms: audio.cuts.filter((c) => c.silenceMs >= 1).length,
      cutsWithOverlap: audio.cuts.filter((c) => c.overlap).length,
      repeatedQuanta: audio.repeatedQuanta,
      deviatingSamples: audio.deviating,
      comparedSamples: audio.compared,
      recorderGaps: run.audioGaps,
    },
    avOffsetAtCutMs: { n: av.length, mean: r1(mean(av)), p5: r1(pct(av, 0.05)), p95: r1(pct(av, 0.95)) },
  };
}

type VideoCut =
  | { k: number; missing: true }
  | { k: number; missing?: false; dropped: number; strayFrames: number; freezeMs: number; dup: number; videoCutT: number };

function analyzeVideo(run: RunLog) {
  const FDms = 1000 / run.fps;
  const maxFrame = Math.max(...run.segments.map((s) => s.outF)) + 1;
  const segOf = new Int32Array(maxFrame + 1).fill(-1);
  run.segments.forEach((s, k) => segOf.fill(k, s.inF, s.outF));
  const probes = run.probes;
  const invalid = probes.filter((p) => p[1] < 0).length;
  const d: { f: number; t0: number; t1: number; seg: number }[] = [];
  for (const [t, f] of probes) {
    if (d.length && d[d.length - 1]!.f === f) continue;
    d.push({ f, t0: t, t1: 0, seg: f >= 0 && f <= maxFrame ? segOf[f]! : -1 });
  }
  for (let i = 0; i < d.length; i++) d[i]!.t1 = i + 1 < d.length ? d[i + 1]!.t0 : probes[probes.length - 1]![0];
  const firstIdx = new Map<number, number>();
  const lastIdx = new Map<number, number>();
  d.forEach((x, i) => {
    if (x.seg >= 0) {
      if (!firstIdx.has(x.seg)) firstIdx.set(x.seg, i);
      lastIdx.set(x.seg, i);
    }
  });
  const cuts: VideoCut[] = [];
  for (let k = 0; k + 1 < run.segments.length; k++) {
    const a = lastIdx.get(k);
    const b = firstIdx.get(k + 1);
    if (a === undefined || b === undefined || b <= a) {
      cuts.push({ k, missing: true });
      continue;
    }
    const tail = run.segments[k]!.outF - 1 - d[a]!.f;
    const head = d[b]!.f - run.segments[k + 1]!.inF;
    const strays = d.slice(a + 1, b);
    const freeze = d[b]!.t0 - d[a]!.t0 - FDms + (d[b]!.t1 - d[b]!.t0 - FDms);
    cuts.push({
      k,
      dropped: Math.max(0, tail) + Math.max(0, head),
      strayFrames: strays.length,
      freezeMs: freeze,
      dup: Math.max(0, Math.round(freeze / FDms)),
      videoCutT: d[b]!.t0,
    });
  }
  let interiorDrops = 0;
  let interiorFrames = 0;
  run.segments.forEach((s, k) => {
    const a = firstIdx.get(k);
    const b = lastIdx.get(k);
    if (a === undefined || b === undefined) return;
    const shown = new Set<number>();
    for (let i = a; i <= b; i++) if (d[i]!.seg === k) shown.add(d[i]!.f);
    for (let f = s.inF + 1; f < s.outF - 1; f++) {
      interiorFrames++;
      if (!shown.has(f)) interiorDrops++;
    }
  });
  const rafDt: number[] = [];
  for (let i = 1; i < probes.length; i++) rafDt.push(probes[i]![0] - probes[i - 1]![0]);
  const first = firstIdx.get(0);
  const last = lastIdx.get(run.segments.length - 1);
  // The app shows the first frame paused before play and holds the last one after the end (the spike did neither):
  // extrapolate from the first frame after the start and the last frame's display to the program's edges.
  let wallS = Number.NaN;
  if (first !== undefined && last !== undefined) {
    const s0 = run.segments[0]!;
    const sN = run.segments.at(-1)!;
    const programFrames = sN.pF + sN.outF - sN.inF;
    const moved = d.findIndex((x) => x.seg === 0 && x.f > s0.inF);
    if (moved >= 0) {
      const start = d[moved]!.t0 - (d[moved]!.f - s0.inF) * FDms;
      const end = d[last]!.t0 + (programFrames - (sN.pF + d[last]!.f - sN.inF)) * FDms;
      wallS = (end - start) / 1000;
    }
  }
  return { cuts, invalid, interiorDrops, interiorFrames, rafDt, wallS };
}

function analyzeAudio(run: RunLog) {
  const x = run.audio;
  const SR = run.sampleRate;
  const idxAtCtx = (c: number) => Math.round(c * SR - run.audioStart);
  let a = 0;
  while (a < x.length && Math.abs(x[a]!) < 0.1) a++;
  let b = x.length - 1;
  while (b > a && Math.abs(x[b]!) < 0.1) b--;
  // Sine 220 Hz at 0.5: natural max |dx| = 0.0144, so a jump above 0.05 is a discontinuity.
  type Ev = { i: number; endI?: number; type: "click" | "overlap" | "silence"; ms?: number };
  const events: Ev[] = [];
  let silent = 0;
  for (let i = a + 1; i <= b; i++) {
    const v = x[i]!;
    if (Math.abs(v - x[i - 1]!) > 0.05) events.push({ i, type: "click" });
    if (Math.abs(v) > 0.6) events.push({ i, type: "overlap" });
    if (Math.abs(v) < 0.02) silent++;
    else {
      if (silent >= 48) events.push({ i: i - silent, endI: i, type: "silence", ms: (silent / SR) * 1000 });
      silent = 0;
    }
  }
  const cuts = [];
  const hz = SR / run.fps;
  for (let k = 0; k + 1 < run.segments.length; k++) {
    const sched = (run.anchor.frame + run.segments[k + 1]!.pF * hz - run.anchor.sample) / SR;
    const lo = idxAtCtx(sched - 0.1);
    const hi = idxAtCtx(sched + 0.1);
    const mine = events.filter((e) => e.i <= hi && (e.endI ?? e.i) >= lo);
    cuts.push({
      k,
      click: mine.some((e) => e.type === "click"),
      overlap: mine.some((e) => e.type === "overlap"),
      silenceMs: mine.reduce((s, e) => s + (e.ms ?? 0), 0),
    });
  }
  // 128-frame render quanta identical to the previous one: stale output (a sine never repeats within 128 samples).
  let repeatedQuanta = 0;
  const q0 = Math.ceil((run.audioStart + a) / 128) * 128 - run.audioStart;
  for (let q = q0 + 128; q + 128 <= b; q += 128) {
    let same = 0;
    let loud = 0;
    for (let i = 0; i < 128; i++) {
      if (x[q + i] === x[q - 128 + i]) same++;
      if (Math.abs(x[q + i]!) > 0.01) loud++;
    }
    if (same >= 100 && loud > 50) repeatedQuanta++;
  }
  // Sample-exact check against the program rebuilt from the sidecar (audio-residual.mjs).
  let deviating: number | null = null;
  let compared: number | null = null;
  if (run.expected) {
    deviating = 0;
    compared = 0;
    const total = run.segments.reduce((s, x2) => s + (x2.outF - x2.inF), 0) * hz;
    const offset = run.anchor.frame - run.anchor.sample - run.audioStart;
    for (let p = 0; p < total; p++) {
      const i = offset + p;
      if (i < 0 || i >= x.length) continue;
      compared++;
      if (Math.abs(x[i]! - run.expected(p)) > 0.02) deviating++;
    }
  }
  return { cuts, repeatedQuanta, deviating, compared };
}

/** Page performance ms at which context time `c` was heard, from the nearest output timestamp. */
function ctxToPerf(run: RunLog, c: number): number {
  let best = run.timestamps[0]!;
  for (const o of run.timestamps) if (o.contextTime > 0 && Math.abs(o.contextTime - c) < Math.abs(best.contextTime - c)) best = o;
  return best.performanceTime + (c - best.contextTime) * 1000;
}

/** ADR 0001 pass thresholds for #15, each with a verdict and the numbers behind it. */
export function checkThresholds(s: Summary): { id: number; pass: boolean; detail: string }[] {
  const pc = (a: number, b: number) => (100 * a) / b;
  const v = s.video;
  const a = s.audio;
  const av = s.avOffsetAtCutMs;
  const exact = a.deviatingSamples === null ? "not checked" : `${a.deviatingSamples} of ${a.comparedSamples} samples deviate`;
  return [
    { id: 1, pass: v.strayFramesTotal === 0 && v.droppedFramesTotal === 0, detail: `stray ${v.strayFramesTotal}, dropped at cuts ${v.droppedFramesTotal}` },
    {
      id: 2,
      pass: pc(v.cutsWithFreezeGe1Frame, s.cuts) <= 5 && v.freezeMsP95 <= 17 && v.freezeMsMax <= 167,
      detail: `freeze cuts ${pc(v.cutsWithFreezeGe1Frame, s.cuts).toFixed(1)} %, p95 ${v.freezeMsP95}, max ${v.freezeMsMax} ms`,
    },
    {
      id: 3,
      pass: pc(v.interiorDrops, v.interiorFrames) <= 0.1,
      detail: `interior drops ${v.interiorDrops}/${v.interiorFrames} = ${pc(v.interiorDrops, v.interiorFrames).toFixed(2)} %`,
    },
    {
      id: 4,
      pass: a.cutsWithClick === 0 && a.cutsWithGapGe1ms === 0 && a.cutsWithOverlap === 0 && a.repeatedQuanta === 0 && (a.deviatingSamples ?? 0) === 0,
      detail: `clicks ${a.cutsWithClick}, gaps ${a.cutsWithGapGe1ms}, overlaps ${a.cutsWithOverlap}, repeated quanta ${a.repeatedQuanta}; ${exact}`,
    },
    { id: 5, pass: Math.abs(av.p5) <= 20 && Math.abs(av.p95) <= 20, detail: `A/V p5 ${av.p5}, p95 ${av.p95} ms (n=${av.n})` },
    {
      id: 6,
      pass: pc(Math.abs(s.wallS - s.programS), s.programS) <= 0.1,
      detail: `wall ${s.wallS} s vs ${s.programS} s = ${pc(Math.abs(s.wallS - s.programS), s.programS).toFixed(2)} %`,
    },
  ];
}

/**
 * The spike's seeded cut list (spikes/gapless-preview/scripts/make-fixture.mjs): kept segments
 * log-uniform 0.5-20 s, removed gaps 0.2-4 s, frame-snapped, at most 201 segments within `duration`.
 */
export function spikeCutList(duration: number, fps: number): Segment[] {
  let seed = 0x5eed2;
  const rand = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  const logUniform = (lo: number, hi: number) => Math.exp(Math.log(lo) + rand() * (Math.log(hi) - Math.log(lo)));
  const snap = (s: number) => Math.round(s * fps) / fps;
  const kept: { in: number; out: number }[] = [];
  let t = snap(1 + rand() * 2);
  while (kept.length < 201) {
    const len = snap(logUniform(0.5, 20));
    if (t + len > duration - 1) break;
    kept.push({ in: Number(t.toFixed(3)), out: Number(snap(t + len).toFixed(3)) });
    t = snap(t + len + logUniform(0.2, 4));
  }
  let acc = 0;
  return kept.map((s) => {
    const inF = Math.round(s.in * fps);
    const outF = Math.round(s.out * fps);
    const segment = { inF, outF, pF: acc };
    acc += outF - inF;
    return segment;
  });
}
