// A/V drift inside the 5 min camera file of q3 (flash+beep source): offset of each beep vs its flash over time.
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ROOT, framePts, FFMPEG } from './lib.mjs';
const file = path.join(ROOT, 'out/q3/cam.mp4');
const raw = (args) => new Promise((res) => { const p = spawn(FFMPEG, args, { stdio: ['ignore', 'pipe', 'ignore'] }); const c = []; p.stdout.on('data', (d) => c.push(d)); p.on('close', () => res(Buffer.concat(c))); });
const lum = await raw(['-v', 'error', '-i', file, '-vf', 'crop=100:100:1160:600,scale=1:1:flags=area,format=gray', '-fps_mode', 'passthrough', '-f', 'rawvideo', '-']);
const pts = framePts(file); const fl = []; let on = false;
for (let i = 0; i < Math.min(lum.length, pts.length); i++) { const hi = lum[i] > 128; if (hi && !on) fl.push(pts[i]); on = hi; }
const pcm = await raw(['-v', 'error', '-i', file, '-vn', '-ac', '1', '-ar', '48000', '-f', 's16le', '-']);
const s = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.length / 2); const on2 = []; let loud = false;
for (let i = 0; i + 48 <= s.length; i += 48) { let e = 0; for (let k = 0; k < 48; k++) e += s[i + k] ** 2; const r = Math.sqrt(e / 48); if (r > 3000 && !loud) on2.push(i / 48000); loud = r > 1500; }
const d = fl.map((f) => { const o = on2.reduce((b, x) => (Math.abs(x - f) < Math.abs(b - f) ? x : b), Infinity); return Math.abs(o - f) < 0.4 ? [f, (o - f) * 1000] : null; }).filter(Boolean);
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const first = d.filter((x) => x[0] < 30).map((x) => x[1]), last = d.filter((x) => x[0] > 270).map((x) => x[1]);
const n = d.length, mx = mean(d.map((x) => x[0])), my = mean(d.map((x) => x[1]));
const b = d.reduce((a, x) => a + (x[0] - mx) * (x[1] - my), 0) / d.reduce((a, x) => a + (x[0] - mx) ** 2, 0);
console.log(JSON.stringify({ flashes: fl.length, beeps: on2.length, matched: n, firstMinuteMeanMs: +mean(first).toFixed(1), lastMinuteMeanMs: +mean(last).toFixed(1), slopeMsPerMin: +(b * 60).toFixed(3) }));
