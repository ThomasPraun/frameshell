// PROTOTYPE (#384 G0). Which YUV->RGB conversion does each decode path do? Compares each against a
// float64 bt709 limited-range conversion of the decoded YUV (media/blocks.yuv, nearest chroma),
// on block interiors and in-gamut pixels only.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const W = 1920, H = 1080;
const yuv = fs.readFileSync(path.join(root, 'media/blocks.yuv'));
const Y = yuv.subarray(0, W * H), U = yuv.subarray(W * H, (W * H * 5) / 4), V = yuv.subarray((W * H * 5) / 4);
const matrices = { bt709: [0.2126, 0.0722], bt601: [0.299, 0.114] };
function conv(x, y, [kr, kb], full) {
  const yy = full ? Y[y * W + x] / 255 : (Y[y * W + x] - 16) / 219;
  const cb = (U[(y >> 1) * (W / 2) + (x >> 1)] - 128) / (full ? 255 : 224);
  const cr = (V[(y >> 1) * (W / 2) + (x >> 1)] - 128) / (full ? 255 : 224);
  const r = yy + 2 * (1 - kr) * cr, b = yy + 2 * (1 - kb) * cb;
  return [r, (yy - kr * r - kb * b) / (1 - kr - kb), b];
}
/** Chroma sample equal to its 8 neighbours in both planes: chroma upsampling cannot matter there. */
function flatChroma(cx, cy) {
  const w = W / 2, c = cy * w + cx;
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const o = (cy + dy) * w + cx + dx;
    if (U[o] !== U[c] || V[o] !== V[c]) return false;
  }
  return true;
}
const files = {
  'ffmpeg exact bt709': 'media/blocks.ff-exact.rgb',
  'ffmpeg auto, tagged': 'media/blocks.ff-auto-tagged.rgb',
  'ffmpeg auto, untagged': 'media/blocks.ff-auto-untagged.rgb',
  'Chromium GL, tagged': 'results/blocks.tagged.gl0.rgb',
  'Chromium GL, untagged': 'results/blocks.untagged.gl0.rgb',
};
for (const [mname, m] of Object.entries(matrices))
  for (const full of [false]) for (const flat of [false, true]) {
    for (const [k, f] of Object.entries(files)) {
      const a = fs.readFileSync(path.join(root, f));
      const max = [0, 0, 0], sum = [0, 0, 0]; let n = 0;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        if (!(x % 8 > 1 && x % 8 < 6 && y % 8 > 1 && y % 8 < 6)) continue;
        if (flat && !flatChroma(x >> 1, y >> 1)) continue;
        const c = conv(x, y, m, full);
        if (c.some((v) => v < 0 || v > 1)) continue;
        n++;
        for (let i = 0; i < 3; i++) { const d = Math.abs(a[(y * W + x) * 3 + i] - Math.round(c[i] * 255)); max[i] = Math.max(max[i], d); sum[i] += d; }
      }
      console.log(`${k.padEnd(24)} vs float ${mname} limited${flat ? ', flat chroma' : ''}: max ${max.join('/')} mean ${sum.map((s) => (s / n).toFixed(3)).join('/')} (n=${n})`);
    }
  }
