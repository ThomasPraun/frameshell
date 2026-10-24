// Owner-run checks that need a real camera and macOS permissions (Screen Recording, System Audio Recording).
//   npm run manual-screen        real camera + screen recorded together, barcode overlay for ground truth
//   npm run manual-mic           real camera + real microphone (getUserMedia audio hung with fake devices on the dev Mac)
//   npm run manual-sysaudio      screen + system audio (loopback) while the app plays a 440 Hz tone
//   npm run manual-sysaudio -- --no-cat   same with Chromium's CoreAudio Tap path disabled (Electron <= 44 only)
import path from 'node:path';
import { readFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { ROOT, runElectron, probe, framePts, frameTiming, decodeBarcodes, FFMPEG } from './lib.mjs';

const mode = process.argv[2];
const noCat = process.argv.includes('--no-cat');
const SECONDS = 20;
const dir = path.join(ROOT, 'out', mode); rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
const mime = 'video/webm;codecs=vp8,opus';
let cfg;
if (mode === 'manual-screen') {
  cfg = { fakeDevices: false, fakeUi: false, overlayBarcode: true, listSources: true, resultFile: path.join(dir, 'run.json'), jobs: [{ id: 'screen-cam', outDir: dir, seconds: SECONDS, timeslice: 1000, streams: [
    { name: 'screen', source: 'display', mime }, { name: 'cam', source: 'cam', mime }] }] };
} else if (mode === 'manual-mic') {
  cfg = { fakeDevices: false, fakeUi: false, resultFile: path.join(dir, 'run.json'), jobs: [{ id: 'mic', outDir: dir, seconds: SECONDS, timeslice: 1000, streams: [
    { name: 'cam', source: 'cam', audio: true, mime }] }] };
} else if (mode === 'manual-sysaudio') {
  cfg = { fakeDevices: false, fakeUi: false, playTone: true, loopbackAudio: true, listSources: true, switches: noCat ? [['disable-features', 'MacCatapLoopbackAudioForScreenShare']] : [], resultFile: path.join(dir, 'run.json'), jobs: [{ id: 'sysaudio', outDir: dir, seconds: SECONDS, timeslice: 1000, streams: [
    { name: 'screen', source: 'display', audio: true, mime }] }] };
} else { console.error('mode: manual-screen | manual-mic | manual-sysaudio'); process.exit(2); }

const r = runElectron(cfg); await r.done;
let res; try { res = JSON.parse(readFileSync(path.join(dir, 'result.json'), 'utf8')); } catch { console.log('FAILED: no result (permission denied? see console above). Run json:', readFileSync(path.join(dir, 'run.json'), 'utf8')); process.exit(1); }
const report = { mode, noCat, cpu: res.cpu, streams: {} };
for (const s of res.streams) {
  const pr = probe(s.file);
  const e = { bytes: s.bytes, displayTracks: s.displayTracks, container: pr.format?.duration, streams: pr.streams?.map((x) => `${x.codec_type}:${x.codec_name}`), timing: frameTiming(framePts(s.file) ?? []) };
  if (s.name === 'screen' && mode === 'manual-sysaudio') {
    const vd = spawnSync(FFMPEG, ['-v', 'info', '-i', s.file, '-af', 'volumedetect', '-vn', '-f', 'null', '-'], { encoding: 'utf8' }).stderr;
    e.audioVolume = vd.split('\n').filter((l) => /mean_volume|max_volume/.test(l)).map((l) => l.replace(/^.*\] /, ''));
    e.verdict = /max_volume: -91|max_volume: -inf/.test(vd) || !e.streams?.some((x) => x.startsWith('audio')) ? 'SILENT or no audio track: system audio NOT captured' : 'audio present: check max_volume is near the tone level (-10 dB or so)';
  }
  if (s.name === 'screen' && mode === 'manual-screen') {
    const sc = res.dpr ?? 1; // barcode is 16 css px per bit => 16*dpr px in the capture, assuming capture at native resolution
    e.note = `window.devicePixelRatio=${sc}; decode manually if the capture is scaled: ffmpeg crop=${384 * sc}:${16 * sc}:0:0`;
  }
  report.streams[s.name] = e; report.streams[s.name].marks = { startCallMs: s.startCallMs, startEventMs: s.startEventMs, firstChunkMs: s.firstChunkMs };
}
console.log(JSON.stringify(report, null, 2));
writeFileSync(path.join(dir, 'report.json'), JSON.stringify(report, null, 2));
