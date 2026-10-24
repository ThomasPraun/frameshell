// Q2: crash safety. Record with timeslice chunks appended by main; SIGKILL the whole process group mid-recording.
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { ROOT, ELECTRON, FFMPEG, probe, framePts, frameTiming } from './lib.mjs';

const KILL_AFTER = +(process.argv.find((a) => a.startsWith('--kill-after='))?.slice(13) ?? 12.5); // seconds after start event
const TYPES = ['video/mp4;codecs=avc1.640028,opus', 'video/mp4;codecs=avc1.640028,mp4a.40.2', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus'];
const slug = (m) => m.replace(/[^a-z0-9]+/gi, '_');
const rows = [];

function boxes(file) {
  // top-level ISO BMFF boxes, to tell fragmented mp4 (moof) from classic (moov at end)
  const b = readFileSync(file); const out = []; let o = 0;
  while (o + 8 <= b.length) { let size = b.readUInt32BE(o); const type = b.toString('latin1', o + 4, o + 8); if (size === 1) size = Number(b.readBigUInt64BE(o + 8)); if (size === 0) size = b.length - o; out.push(type); if (size < 8) break; o += size; }
  const counts = {}; for (const t of out) counts[t] = (counts[t] ?? 0) + 1; return counts;
}

for (const mime of TYPES) {
  const dir = path.join(ROOT, 'out/q2', slug(mime));
  rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
  const cfgFile = path.join(dir, 'cfg.json');
  writeFileSync(cfgFile, JSON.stringify({ resultFile: path.join(dir, 'never.json'), jobs: [{ id: 'crash', outDir: dir, seconds: 60, timeslice: 1000, streams: [{ name: 'cam', source: 'fake', mime }] }] }));
  const p = spawn(ELECTRON, [path.join(ROOT, 'src/main.cjs'), `--cfg=${cfgFile}`], { stdio: 'ignore', detached: true });
  const marks = path.join(dir, 'marks.log');
  while (!existsSync(marks)) await new Promise((r) => setTimeout(r, 50));
  const startWall = +readFileSync(marks, 'utf8').split(' ')[0];
  while (Date.now() - startWall < KILL_AFTER * 1000) await new Promise((r) => setTimeout(r, 10));
  const killWall = Date.now();
  process.kill(-p.pid, 'SIGKILL');
  await new Promise((r) => setTimeout(r, 1500));
  const ext = mime.startsWith('video/mp4') ? 'mp4' : 'webm';
  const file = path.join(dir, `cam.${ext}`);
  const chunkLog = readFileSync(file + '.chunks.log', 'utf8').trim().split('\n').map((l) => l.split(' ').map(Number));
  const row = { mime, killAfterStartS: +((killWall - startWall) / 1000).toFixed(2), chunksWritten: chunkLog.length, bytes: statSync(file).size, lastChunkAgeS: +((killWall - chunkLog.at(-1)[0]) / 1000).toFixed(2) };
  if (ext === 'mp4') row.boxes = boxes(file);
  const pr = probe(file);
  row.rawProbe = pr.error ? { error: pr.error } : { duration: pr.format.duration, streams: pr.streams.map((s) => s.codec_name) };
  const raw = frameTiming(framePts(file) ?? []);
  row.rawFrames = raw?.frames ?? 0;
  const fixed = path.join(dir, `fixed.${ext === 'mp4' ? 'mp4' : 'webm'}`);
  const rm = spawnSync(FFMPEG, ['-v', 'error', '-y', '-i', file, '-c', 'copy', fixed], { encoding: 'utf8' });
  row.remuxExit = rm.status; row.remuxStderr = rm.stderr.trim().split('\n').slice(0, 3).join(' | ');
  if (rm.status === 0) {
    const fp = probe(fixed); const ft = frameTiming(framePts(fixed) ?? []);
    row.remuxed = { duration: fp.format?.duration, videoFrames: ft?.frames, seekableNote: fp.format?.format_name };
    const dec = spawnSync(FFMPEG, ['-v', 'error', '-i', fixed, '-f', 'null', '-'], { encoding: 'utf8' });
    row.remuxDecodeErrors = dec.stderr.trim().split('\n').filter(Boolean).slice(0, 3);
    const fd = Number(fp.format?.duration);
    row.lostSecondsVsKillTime = +(row.killAfterStartS - fd).toFixed(2);
  }
  console.log(JSON.stringify(row)); rows.push(row);
}
mkdirSync(path.join(ROOT, 'out'), { recursive: true });
writeFileSync(path.join(ROOT, 'out/q2-report.json'), JSON.stringify(rows, null, 2));
