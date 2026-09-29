// PROTOTYPE. Sanity check: the burned-in barcode survives proxy encoding.
// Usage: node scripts/check-barcode.mjs [frame ...]
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ffmpeg from 'ffmpeg-static';

const proxy = join(dirname(fileURLToPath(import.meta.url)), '..', 'media', 'proxy.mp4');
const frames = process.argv.slice(2).map(Number);
for (const n of frames.length ? frames : [0, 1, 777, 1799]) {
  const r = spawnSync(ffmpeg, ['-v', 'error', '-ss', String(Math.max(0, n / 30 - 0.001)), '-i', proxy, '-vf', 'crop=640:40:0:0,format=gray', '-frames:v', '1', '-f', 'rawvideo', '-']);
  const b = r.stdout;
  let a = 0, c = 0;
  for (let i = 0; i < 16; i++) {
    const x = 20 + 40 * i;
    if (b[10 * 640 + x] > 128) a |= 1 << i;
    if (b[30 * 640 + x] > 128) c |= 1 << i;
  }
  console.log(`frame ${n}: decoded ${a}, checksum ${(a ^ c) === 0xffff ? 'ok' : 'BAD'}`);
}
