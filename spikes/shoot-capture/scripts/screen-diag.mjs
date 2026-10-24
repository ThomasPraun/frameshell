// Owner-run: tries each screen-capture path for 3 s and reports which one starts (npm run manual-screen-diag).
import path from 'node:path';
import { readFileSync, mkdirSync, rmSync } from 'node:fs';
import { ROOT, runElectron, probe } from './lib.mjs';

const mime = 'video/webm;codecs=vp8,opus';
const variants = [
  { id: 'A-display-fakeui', fakeUi: true, stream: {} },
  { id: 'B-display-handler', fakeUi: false, stream: {} },
  { id: 'C-legacy-desktop', fakeUi: false, stream: { displayMode: 'legacy' } },
  { id: 'D-legacy-desktop-audio', fakeUi: false, stream: { displayMode: 'legacy', audio: true } },
  { id: 'E-display-loopback', fakeUi: false, loopbackAudio: true, stream: { audio: true } },
  { id: 'F-display-loopback-nocat', fakeUi: false, loopbackAudio: true, noCat: true, stream: { audio: true } },
  { id: 'G-system-picker', fakeUi: false, systemPicker: true, stream: {}, note: 'macOS picker opens: choose the screen' },
];
const only = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const rows = [];
for (const v of variants.filter((x) => !only.length || only.some((o) => x.id.startsWith(o)))) {
  const dir = path.join(ROOT, 'out', 'screen-diag', v.id); rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
  if (v.note) console.log(`\n>>> ${v.id}: ${v.note}`);
  const cfg = {
    fakeDevices: false, fakeUi: v.fakeUi, systemPicker: v.systemPicker, loopbackAudio: v.loopbackAudio, playTone: !process.argv.includes("--no-tone") && (v.loopbackAudio || v.stream.audio),
    switches: v.noCat ? [['disable-features', 'MacCatapLoopbackAudioForScreenShare']] : [],
    resultFile: path.join(dir, 'run.json'),
    jobs: [{ id: v.id, outDir: dir, seconds: 3, timeslice: 1000, streams: [{ name: 'screen', source: 'display', mime, ...v.stream }] }],
  };
  await runElectron(cfg, { timeoutMs: 60e3 }).done;
  let run; try { run = JSON.parse(readFileSync(path.join(dir, 'run.json'), 'utf8')); } catch { run = { jobs: [{ error: 'no run.json' }] }; }
  const job = run.jobs[0] ?? {};
  if (job.error) { rows.push({ variant: v.id, result: 'FAIL', detail: job.error.split('\n')[0] }); continue; }
  const s = job.streams[0]; const pr = probe(s.file);
  const kinds = (pr.streams ?? []).map((x) => `${x.codec_type}:${x.codec_name}`).join(' ');
  const tracks = (s.displayTracks ?? s.tracks ?? []).map((t) => `${t.kind}${t.settings?.width ? ` ${t.settings.width}x${t.settings.height}` : ''}`).join(', ');
  rows.push({ variant: v.id, result: 'OK', detail: `${s.bytes} bytes; file ${kinds}; tracks ${tracks}` });
}
console.log('\n=== screen-diag ===');
console.table(rows);
