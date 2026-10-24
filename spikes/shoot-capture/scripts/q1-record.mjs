// Q1: formats. Fake camera+mic recorded per supported mime type; plus A/V sync with beep+flash source.
import path from 'node:path';
import { readFileSync, mkdirSync } from 'node:fs';
import { ROOT, probe, framePts, frameTiming, runElectron, decodeBarcodes, FFMPEG } from './lib.mjs';
import { spawnSync } from 'node:child_process';

const SECONDS = +(process.argv.find((a) => a.startsWith('--seconds='))?.slice(10) ?? 60);
const TYPES = [
  'video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4;codecs=avc1.640028,mp4a.40.2', 'video/mp4;codecs=avc1,opus', 'video/mp4;codecs=avc1.640028,opus', 'video/mp4',
  'video/webm;codecs=vp8,opus', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=av1,opus', 'video/webm;codecs=h264,opus', 'video/webm',
];
const out = path.join(ROOT, 'out/q1');
const resultFile = path.join(out, 'support.json');
mkdirSync(out, { recursive: true });
const slug = (m) => m.replace(/[^a-z0-9]+/gi, '_');

// pass 1: support only
let r = runElectron({ resultFile, probeTypes: TYPES, jobs: [] });
await r.done;
const support = JSON.parse(readFileSync(resultFile, 'utf8')).support;
console.log(support);
const ok = TYPES.filter((t) => support[t]);
// the distinct "real" encodings worth recording: skip bare containers if a codec-specific type exists is NOT done; record all supported.
const jobs = ok.map((m) => ({ id: slug(m), outDir: path.join(out, slug(m)), seconds: SECONDS, timeslice: 1000, streams: [{ name: 'cam', source: 'fake', mime: m }] }));
// one Electron process per type: clean CPU numbers and a crash only loses that type
const exits = {};
for (const j of jobs) {
  r = runElectron({ resultFile: path.join(j.outDir, 'run.json'), jobs: [j] });
  exits[j.id] = await r.done;
  console.log('exit', j.id, exits[j.id]);
}

const report = { support, seconds: SECONDS, types: {} };
for (const j of jobs) {
  let res;
  try { res = JSON.parse(readFileSync(path.join(j.outDir, 'result.json'), 'utf8')); } catch { report.types[j.id] = { error: 'no result.json (process exit ' + exits[j.id] + ')' }; console.log(j.id, 'FAILED'); continue; }
  const s = res.streams[0];
  const file = s.file;
  const pr = probe(file);
  const v = pr.streams?.find((x) => x.codec_type === 'video'); const a = pr.streams?.find((x) => x.codec_type === 'audio');
  const timing = frameTiming(framePts(file));
  const dec = spawnSync(FFMPEG, ['-v', 'error', '-i', file, '-f', 'null', '-'], { encoding: 'utf8' });
  report.types[j.id] = {
    mime: s.mime, bytes: s.bytes, mbPerMin: +(s.bytes / 1e6 / (SECONDS / 60)).toFixed(2), chunks: s.chunks,
    container: pr.format && { name: pr.format.format_name, duration: pr.format.duration, start_time: pr.format.start_time, bit_rate: pr.format.bit_rate },
    video: v && { codec: v.codec_name, profile: v.profile, size: `${v.width}x${v.height}`, r_frame_rate: v.r_frame_rate, avg_frame_rate: v.avg_frame_rate, start_time: v.start_time, duration: v.duration },
    audio: a && { codec: a.codec_name, rate: a.sample_rate, ch: a.channels, start_time: a.start_time, duration: a.duration },
    avStartOffsetMs: v && a ? +((parseFloat(a.start_time) - parseFloat(v.start_time)) * 1000).toFixed(1) : null,
    timing, cpu: res.cpu, decodeErrors: dec.stderr.trim().split('\n').filter(Boolean).slice(0, 3),
    startLatencyMs: +(s.startEventMs - s.startCallMs).toFixed(1), firstChunkAfterStartMs: +(s.firstChunkMs - s.startEventMs).toFixed(1),
    probeError: pr.error,
  };
  console.log(j.id, JSON.stringify(report.types[j.id]));
}
import { writeFileSync } from 'node:fs';
writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
