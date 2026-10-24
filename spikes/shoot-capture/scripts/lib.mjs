import { existsSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = path.resolve(ROOT, '../..');
const managed = (n) => {
  const d = path.join(REPO, '.cache/test-binaries/binaries/ffmpeg');
  if (!existsSync(d)) return null;
  for (const v of readdirSync(d)) {
    const p = path.join(d, v, `${process.platform}-${process.arch}`, n);
    if (existsSync(p)) return p;
  }
  return null;
};
export const FFMPEG = managed('ffmpeg') ?? require('ffmpeg-static');
export const FFPROBE = managed('ffprobe') ?? require('ffprobe-static').path;
export const ELECTRON = require('electron');

export function probe(file) {
  const r = spawnSync(FFPROBE, ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', file], { encoding: 'utf8', maxBuffer: 1 << 28 });
  if (r.status !== 0) return { error: (r.stderr || '').trim().split('\n').slice(0, 3).join(' | ') };
  return JSON.parse(r.stdout);
}
export function framePts(file, stream = 'v:0') {
  const r = spawnSync(FFPROBE, ['-v', 'error', '-select_streams', stream, '-show_entries', 'frame=pts_time,best_effort_timestamp_time', '-of', 'csv=p=0', file], { encoding: 'utf8', maxBuffer: 1 << 28 });
  if (r.status !== 0) return null;
  return r.stdout.trim().split('\n').filter(Boolean).map((l) => parseFloat(l.split(',')[1] ?? l.split(',')[0])).filter((x) => !isNaN(x));
}
export function stats(a) {
  if (!a.length) return null;
  const m = a.reduce((x, y) => x + y, 0) / a.length;
  const sd = Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / a.length);
  const s = [...a].sort((x, y) => x - y);
  return { n: a.length, mean: m, sd, min: s[0], max: s[s.length - 1], p99: s[Math.floor(s.length * 0.99)] };
}
export function frameTiming(pts) {
  if (!pts || pts.length < 3) return null;
  const sorted = [...pts].sort((a, b) => a - b);
  const d = sorted.slice(1).map((v, i) => (v - sorted[i]) * 1000);
  const st = stats(d);
  const dur = sorted[sorted.length - 1] - sorted[0];
  return {
    frames: sorted.length, first_pts: sorted[0], avg_fps: +((sorted.length - 1) / dur).toFixed(3),
    dt_ms: { mean: +st.mean.toFixed(2), sd: +st.sd.toFixed(2), min: +st.min.toFixed(2), max: +st.max.toFixed(2) },
    gaps_over_1p5x: d.filter((x) => x > st.mean * 1.5).length, gaps_over_100ms: d.filter((x) => x > 100).length,
    pts_monotonic_in_file_order: pts.every((v, i) => i === 0 || v >= pts[i - 1]),
  };
}
// Decode the 24-bit barcode (row 0, 16 px per bit) of every video frame -> [{pts, value}]
export async function decodeBarcodes(file) {
  const pts = framePts(file);
  const bytes = await new Promise((res, rej) => {
    const p = spawn(FFMPEG, ['-v', 'error', '-i', file, '-vf', 'crop=384:16:0:0,scale=24:1:flags=area,format=gray', '-fps_mode', 'passthrough', '-f', 'rawvideo', '-'], { stdio: ['ignore', 'pipe', 'inherit'] });
    const chunks = []; p.stdout.on('data', (c) => chunks.push(c)); p.on('close', () => res(Buffer.concat(chunks))); p.on('error', rej);
  });
  const n = Math.floor(bytes.length / 24); const out = [];
  for (let i = 0; i < n; i++) {
    let v = 0; for (let b = 0; b < 24; b++) v = (v << 1) | (bytes[i * 24 + b] > 128 ? 1 : 0);
    out.push({ pts: pts?.[i], value: v });
  }
  return out;
}
export function runElectron(cfg, { timeoutMs = 3600e3, detached = false } = {}) {
  const cfgFile = path.join(ROOT, 'out', `cfg-${Date.now()}.json`);
  mkdirSync(path.dirname(cfgFile), { recursive: true });
  writeFileSync(cfgFile, JSON.stringify(cfg));
  const p = spawn(ELECTRON, [path.join(ROOT, 'src/main.cjs'), `--cfg=${cfgFile}`], { stdio: ['ignore', 'inherit', 'inherit'], detached });
  const done = new Promise((res) => p.on('close', res));
  return { p, done, timeoutMs };
}

/** Word error rate (substitutions + deletions + insertions) / reference length, on normalized words. */
export function wer(ref, hyp) {
  const n = ref.length, m = hyp.length; if (!n) return m ? 1 : 0;
  let prev = Array.from({ length: m + 1 }, (_, j) => j);
  for (let i = 1; i <= n; i++) { const cur = [i]; for (let j = 1; j <= m; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ref[i - 1] === hyp[j - 1] ? 0 : 1)); prev = cur; }
  return prev[m] / n;
}
