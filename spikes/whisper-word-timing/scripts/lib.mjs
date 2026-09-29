// PROTOTYPE helpers shared by fixture/transcribe/analyze. No error handling beyond runnable.
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import ffmpegPath from 'ffmpeg-static';

/** Spike root directory. */
export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
/** Gitignored media dir. */
export const MEDIA = join(ROOT, 'media');
/** Gitignored raw engine outputs. */
export const OUT = join(ROOT, 'out');
/** Committed small result summaries. */
export const RESULTS = join(ROOT, 'results');
/** All audio is 16 kHz mono s16: whisper's native input. */
export const SR = 16000;

/** Runs ffmpeg-static with args; throws on failure. */
export function ffmpeg(args) {
  const r = spawnSync(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${args.join(' ')}`);
}

/** Reads a 16-bit PCM WAV, walking chunks (ffmpeg may emit LIST before data). */
export function readWav(path) {
  const b = readFileSync(path);
  let off = 12;
  let sr = 0;
  while (off < b.length) {
    const id = b.toString('ascii', off, off + 4);
    const size = b.readUInt32LE(off + 4);
    if (id === 'fmt ') sr = b.readUInt32LE(off + 12);
    if (id === 'data') {
      const pcm = new Int16Array(b.buffer.slice(b.byteOffset + off + 8, b.byteOffset + off + 8 + size));
      return { sr, pcm };
    }
    off += 8 + size + (size % 2);
  }
  throw new Error('no data chunk');
}

/** Writes mono 16-bit PCM WAV. */
export function writeWav(path, pcm, sr = SR) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length * 2, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(sr, 24); h.writeUInt32LE(sr * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(pcm.length * 2, 40);
  writeFileSync(path, Buffer.concat([h, Buffer.from(pcm.buffer, pcm.byteOffset, pcm.length * 2)]));
}

/** Frame hop for energy analysis: 10 ms = whisper.cpp timestamp resolution. */
export const HOP = 0.01;

/**
 * RMS energy in dBFS per 10 ms hop, 20 ms window centred on hop.
 * Index i covers time i*HOP.
 */
export function energyDb(pcm, sr = SR) {
  const hop = Math.round(sr * HOP);
  const win = hop * 2;
  const n = Math.floor(pcm.length / hop);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const c = i * hop;
    const a = Math.max(0, c - win / 2);
    const z = Math.min(pcm.length, c + win / 2);
    let s = 0;
    for (let j = a; j < z; j++) s += pcm[j] * pcm[j];
    out[i] = 10 * Math.log10(s / Math.max(1, z - a) / (32768 * 32768) + 1e-12);
  }
  return out;
}

/** Percentile (0..100) of numeric array; NaN for empty. */
export function pct(arr, p) {
  if (!arr.length) return NaN;
  const s = [...arr].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
}

/** Arithmetic mean; NaN for empty. */
export function mean(arr) {
  return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : NaN;
}

/**
 * Speech/silence threshold in dBFS. Noise floor = 10th percentile of frames;
 * speech level = 90th. Threshold at 25% of the way up (dB). Clean audiobook audio
 * has a wide gap, so the result is not sensitive to the exact fraction.
 */
export function speechThreshold(db) {
  const floor = pct(Array.from(db), 10);
  const loud = pct(Array.from(db), 90);
  return { floor, loud, thr: floor + 0.25 * (loud - floor) };
}

/**
 * Silent runs (energy below thr) of at least minDur seconds.
 * Returns [{start, end}] in seconds.
 */
export function silences(db, thr, minDur) {
  const out = [];
  let s = -1;
  for (let i = 0; i <= db.length; i++) {
    const quiet = i < db.length && db[i] < thr;
    if (quiet && s < 0) s = i;
    if (!quiet && s >= 0) {
      if ((i - s) * HOP >= minDur) out.push({ start: s * HOP, end: i * HOP });
      s = -1;
    }
  }
  return out;
}
