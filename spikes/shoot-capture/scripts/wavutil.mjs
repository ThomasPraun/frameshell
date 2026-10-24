import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { FFMPEG } from './lib.mjs';
/** 16 kHz mono s16le samples of a wav (via ffmpeg, so any header layout works). */
export function loadPcm(wav) {
  const pcm = wav.replace(/\.wav$/, '.pcm');
  if (!existsSync(pcm)) spawnSync(FFMPEG, ['-v', 'error', '-y', '-i', wav, '-f', 's16le', '-ar', '16000', '-ac', '1', pcm]);
  const b = readFileSync(pcm);
  return new Int16Array(b.buffer, b.byteOffset, b.length / 2);
}
export function wavBuffer(samples) {
  const n = samples.length * 2; const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + n, 4); h.write('WAVEfmt ', 8); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(16000, 24); h.writeUInt32LE(32000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(n, 40);
  return Buffer.concat([h, Buffer.from(samples.buffer, samples.byteOffset, n)]);
}
export function writeWav(file, samples) { writeFileSync(file, wavBuffer(samples)); }
