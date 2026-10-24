// Q1b: A/V offset per container. Source flashes a square and beeps at the same instant once a second.
import path from 'node:path';
import { spawn } from 'node:child_process';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { ROOT, runElectron, framePts, FFMPEG, stats } from './lib.mjs';

const SECONDS = +(process.argv.find((a) => a.startsWith('--seconds='))?.slice(10) ?? 25);
const TYPES = ['video/mp4;codecs=avc1.640028,opus', 'video/mp4;codecs=avc1.640028,mp4a.40.2', 'video/webm;codecs=vp8,opus', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=h264,opus'];
const slug = (m) => m.replace(/[^a-z0-9]+/gi, '_');
const raw = (args) => new Promise((res) => { const p = spawn(FFMPEG, args, { stdio: ['ignore', 'pipe', 'ignore'] }); const c = []; p.stdout.on('data', (d) => c.push(d)); p.on('close', () => res(Buffer.concat(c))); });
const rows = [];
for (const mime of TYPES) {
  const dir = path.join(ROOT, 'out/q1b', slug(mime)); mkdirSync(dir, { recursive: true });
  const r = runElectron({ resultFile: path.join(dir, 'run.json'), jobs: [{ id: 'avsync', outDir: dir, seconds: SECONDS, timeslice: 1000, streams: [{ name: 'cam', source: 'sync', mime, w: 640, h: 360, fps: 30 }] }] });
  if (!process.argv.includes('--reuse')) await r.done; else r.p.kill();
  const res = JSON.parse(readFileSync(path.join(dir, 'result.json'), 'utf8')).streams[0];
  const file = res.file;
  const lum = await raw(['-v', 'error', '-i', file, '-vf', 'crop=100:100:520:240,scale=1:1:flags=area,format=gray', '-fps_mode', 'passthrough', '-f', 'rawvideo', '-']);
  const pts = framePts(file);
  const flashStarts = []; let on = false;
  for (let i = 0; i < Math.min(lum.length, pts.length); i++) { const hi = lum[i] > 128; if (hi && !on) flashStarts.push(pts[i]); on = hi; }
  const pcm = await raw(['-v', 'error', '-i', file, '-vn', '-ac', '1', '-ar', '48000', '-f', 's16le', '-']);
  const s = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.length / 2); const hop = 48; // 1 ms
  const onsets = []; let loud = false;
  for (let i = 0; i + hop <= s.length; i += hop) { let e = 0; for (let k = 0; k < hop; k++) e += s[i + k] ** 2; const rms = Math.sqrt(e / hop); if (rms > 3000 && !loud) onsets.push(i / 48000); loud = rms > 1500; }
  // match each flash to the nearest onset
  const diffs = flashStarts.map((f) => { const o = onsets.reduce((b, x) => (Math.abs(x - f) < Math.abs(b - f) ? x : b), Infinity); return Math.abs(o - f) < 0.4 ? (o - f) * 1000 : null; }).filter((x) => x !== null);
  const st = stats(diffs);
  const row = { mime, flashes: flashStarts.length, beeps: onsets.length, matched: diffs.length, audioMinusVideoMs: st && { mean: +st.mean.toFixed(1), sd: +st.sd.toFixed(1), min: +st.min.toFixed(1), max: +st.max.toFixed(1) } };
  console.log(JSON.stringify(row)); rows.push(row);
}
writeFileSync(path.join(ROOT, 'out/q1b-report.json'), JSON.stringify(rows, null, 2));
