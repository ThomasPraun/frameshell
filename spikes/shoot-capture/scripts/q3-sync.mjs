// Q3: two simultaneous MediaRecorders (camera stand-in + screen stand-in), both with a burned-in 24-bit barcode of
// performance.now(). Offset of file = barcode_ms - pts_ms per frame; linear fit gives start offset and drift.
import path from 'node:path';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { ROOT, runElectron, decodeBarcodes, probe } from './lib.mjs';

const SECONDS = +(process.argv.find((a) => a.startsWith('--seconds='))?.slice(10) ?? 300);
const MIME = process.argv.find((a) => a.startsWith('--mime='))?.slice(7) ?? 'video/mp4;codecs=avc1.640028,opus';
const ext = MIME.startsWith('video/mp4') ? 'mp4' : 'webm';
const dir = path.join(ROOT, 'out/q3'); rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });

const job = { id: 'pair', outDir: dir, seconds: SECONDS, timeslice: 1000, streams: [
  { name: 'cam', source: 'sync', mime: MIME, w: 1280, h: 720, fps: 30 },
  { name: 'screen', source: 'canvas', mime: MIME, w: 1920, h: 1080, fps: 30 },
] };
const r = runElectron({ resultFile: path.join(dir, 'run.json'), jobs: [job] });
await r.done;
const res = JSON.parse(readFileSync(path.join(dir, 'result.json'), 'utf8'));

function fit(points) { // least squares y = a + b x
  const n = points.length; const mx = points.reduce((s, p) => s + p[0], 0) / n; const my = points.reduce((s, p) => s + p[1], 0) / n;
  let sxy = 0, sxx = 0; for (const [x, y] of points) { sxy += (x - mx) * (y - my); sxx += (x - mx) ** 2; }
  const b = sxy / sxx; return { a: my - b * mx, b };
}
const out = { seconds: SECONDS, mime: MIME, files: {} };
for (const s of res.streams) {
  const file = s.file;
  const dec = (await decodeBarcodes(file)).filter((d) => d.pts !== undefined);
  const raw = dec.map((d) => [d.pts, d.value - d.pts * 1000]);
  const med = raw.map((p) => p[1]).sort((a, b) => a - b)[Math.floor(raw.length / 2)];
  const pts = raw.filter((p) => Math.abs(p[1] - med) < 300);
  const f = fit(pts);
  const resid = pts.map((p) => p[1] - (f.a + f.b * p[0]));
  const sd = Math.sqrt(resid.reduce((x, y) => x + y * y, 0) / resid.length);
  out.files[s.name] = {
    frames: dec.length, usedFrames: pts.length, pts0WallMs: +f.a.toFixed(2), driftMsPerMin: +(f.b * 60).toFixed(3), residualSdMs: +sd.toFixed(2),
    marks: { startCallMs: +s.startCallMs.toFixed(1), startEventMs: +s.startEventMs.toFixed(1), firstChunkMs: +s.firstChunkMs.toFixed(1) },
    firstFramePtsS: dec[0]?.pts, container: probe(file).format?.duration,
  };
}
const c = out.files.cam, sc = out.files.screen;
out.startOffsetCamMinusScreenMs = +(c.pts0WallMs - sc.pts0WallMs).toFixed(2);
out.relativeDriftMsPerMin = +(c.driftMsPerMin - sc.driftMsPerMin).toFixed(3);
out.relativeDriftOverRunMs = +(out.relativeDriftMsPerMin * SECONDS / 60).toFixed(2);
// which page clock predicts pts0Wall? error = predicted - measured
out.predictionErrorMs = {};
for (const k of ['startCallMs', 'startEventMs', 'firstChunkMs']) {
  out.predictionErrorMs[k] = { cam: +(c.marks[k] - c.pts0WallMs).toFixed(1), screen: +(sc.marks[k] - sc.pts0WallMs).toFixed(1) };
}
console.log(JSON.stringify(out, null, 2));
writeFileSync(path.join(ROOT, 'out/q3-report.json'), JSON.stringify(out, null, 2));
