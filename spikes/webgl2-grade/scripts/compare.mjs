// PROTOTYPE (#384 G0). Per-channel error between the shader outputs (results/) and ffmpeg (media/),
// plus a float64 CPU reference of the same trilinear lookup. Prints a table; writes results/parity.json.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const W = 1920, H = 1080;
const load = (p) => new Uint8Array(fs.readFileSync(path.join(root, p)));

function cube(n) {
  const v = [];
  for (const line of fs.readFileSync(path.join(root, `media/look${n}.cube`), 'utf8').split('\n'))
    if (/^[-\d.]/.test(line.trim())) for (const x of line.trim().split(/\s+/)) v.push(+x);
  return v;
}
/** Trilinear lookup like ffmpeg lut3d (float64 here); `out` rounds or truncates to 8 bit. */
function applyLut(rgb, n, table, out) {
  const res = new Uint8Array(rgb.length);
  const at = (r, g, b, c) => table[((b * n + g) * n + r) * 3 + c];
  for (let i = 0; i < rgb.length; i += 3) {
    const p = [rgb[i], rgb[i + 1], rgb[i + 2]].map((x) => (x / 255) * (n - 1));
    const i0 = p.map((x) => Math.min(Math.floor(x), n - 2));
    const f = p.map((x, k) => x - i0[k]);
    for (let c = 0; c < 3; c++) {
      const L = (dr, dg, db) => at(i0[0] + dr, i0[1] + dg, i0[2] + db, c);
      const x00 = L(0, 0, 0) + (L(1, 0, 0) - L(0, 0, 0)) * f[0];
      const x10 = L(0, 1, 0) + (L(1, 1, 0) - L(0, 1, 0)) * f[0];
      const x01 = L(0, 0, 1) + (L(1, 0, 1) - L(0, 0, 1)) * f[0];
      const x11 = L(0, 1, 1) + (L(1, 1, 1) - L(0, 1, 1)) * f[0];
      const y0 = x00 + (x10 - x00) * f[1], y1 = x01 + (x11 - x01) * f[1];
      const v = Math.min(1, Math.max(0, y0 + (y1 - y0) * f[2])) * 255;
      res[i + c] = out === 'round' ? Math.round(v) : Math.floor(v);
    }
  }
  return res;
}

const interior = (i) => { const p = i / 3 | 0, x = p % W, y = (p / W) | 0; return x % 8 > 1 && x % 8 < 6 && y % 8 > 1 && y % 8 < 6; };
function diff(a, b, mask) {
  const max = [0, 0, 0], sum = [0, 0, 0]; let n = 0, over1 = 0, over2 = 0;
  for (let i = 0; i < a.length; i += 3) {
    if (mask && !mask(i)) continue;
    n++; let m = 0;
    for (let c = 0; c < 3; c++) { const d = Math.abs(a[i + c] - b[i + c]); max[c] = Math.max(max[c], d); sum[c] += d; m = Math.max(m, d); }
    if (m > 1) over1++; if (m > 2) over2++;
  }
  return { maxRGB: max.join('/'), meanRGB: sum.map((s) => (s / n).toFixed(3)).join('/'), pctOver1: +((100 * over1) / n).toFixed(3), pctOver2: +((100 * over2) / n).toFixed(3) };
}

const rows = [];
const row = (name, a, b, mask) => { const r = { name, ...diff(a, b, mask) }; rows.push(r); console.log(name.padEnd(64), r.maxRGB.padEnd(10), r.meanRGB.padEnd(20), r.pctOver1, r.pctOver2); };
console.log('comparison'.padEnd(64), 'max R/G/B'.padEnd(10), 'mean R/G/B'.padEnd(20), '%px>1', '%px>2');

// --- RGB still (no YUV) ---
const still = load('media/random.rgb');
row('still: GL identity readback vs source', load('results/random.gl0.rgb'), still);
for (const n of [33, 65]) {
  const t = cube(n);
  const ff = load(`media/random.ffmpeg${n}.rgb`);
  row(`still ${n}: ffmpeg lut3d vs float64 ref (round)`, ff, applyLut(still, n, t, 'round'));
  row(`still ${n}: ffmpeg lut3d vs float64 ref (truncate)`, ff, applyLut(still, n, t, 'trunc'));
  row(`still ${n}: shader hw-trilinear (RGBA16F) vs ffmpeg`, load(`results/random.gl1.lut${n}.rgb`), ff);
  row(`still ${n}: shader 8-tap (RGBA32F) vs ffmpeg`, load(`results/random.gl2.lut${n}.rgb`), ff);
  row(`still ${n}: shader hw-trilinear + floor vs ffmpeg`, load(`results/random.gl1t.lut${n}.rgb`), ff);
  row(`still ${n}: shader 8-tap + floor vs ffmpeg`, load(`results/random.gl2t.lut${n}.rgb`), ff);
  row(`still ${n}: shader 8-tap vs float64 ref (round)`, load(`results/random.gl2.lut${n}.rgb`), applyLut(still, n, t, 'round'));
  row(`still ${n}: hw-trilinear via ImageBitmap->2D vs ffmpeg`, load(`results/random.2d1.lut${n}.rgb`), ff);
  row(`still ${n}: 8-tap via ImageBitmap->2D vs ffmpeg`, load(`results/random.2d2.lut${n}.rgb`), ff);
}
if (cube(33).length) {
  const ff33 = load('media/random.ffmpeg33.rgb'), ff65 = load('media/random.ffmpeg65.rgb');
  row('still: ffmpeg 33 vs ffmpeg 65 (table size effect)', ff33, ff65);
}

// --- video: decoded bt709 limited H.264 ---
const exact = load('media/blocks.ff-exact.rgb');
const auto = load('media/blocks.ff-auto-tagged.rgb');
row('video: ffmpeg auto (tagged bt709) vs bt709 full_chroma_int', auto, exact, interior);
row('video: ffmpeg auto (untagged) vs ffmpeg auto (tagged)', load('media/blocks.ff-auto-untagged.rgb'), auto, interior);
for (const tag of ['tagged', 'untagged']) {
  row(`video ${tag}: preview 2D drawImage(VideoFrame) vs ffmpeg auto (tagged)`, load(`results/blocks.${tag}.2d.rgb`), auto, interior);
  row(`video ${tag}: GL texImage2D(VideoFrame) vs ffmpeg auto (tagged)`, load(`results/blocks.${tag}.gl0.rgb`), auto, interior);
  row(`video ${tag}: GL vs 2D drawImage (same frame)`, load(`results/blocks.${tag}.gl0.rgb`), load(`results/blocks.${tag}.2d.rgb`));
  row(`video ${tag}: GL with UNPACK colorspace conversion vs without`, load(`results/blocks.${tag}.gl0conv.rgb`), load(`results/blocks.${tag}.gl0.rgb`));
}
for (const n of [33, 65]) {
  const t = cube(n);
  for (const mode of [1, 2]) {
    const name = mode === 1 ? 'hw' : '8-tap';
    const gl = load(`results/blocks.tagged.gl${mode}.lut${n}.rgb`);
    row(`video ${n} ${name}: shader vs float64 ref on GL's own decode (LUT only)`, gl, applyLut(load('results/blocks.tagged.gl0.rgb'), n, t, 'round'));
    row(`video ${n} ${name}: shader vs ffmpeg bt709 full_chroma_int + lut3d`, gl, load(`media/blocks.ff-exact.lut${n}.rgb`), interior);
    row(`video ${n} ${name}: shader vs ffmpeg auto (tagged) + lut3d`, gl, load(`media/blocks.ff-auto-tagged.lut${n}.rgb`), interior);
    row(`video ${n} ${name}: shader (untagged) vs ffmpeg auto (untagged) + lut3d`, load(`results/blocks.untagged.gl${mode}.lut${n}.rgb`), load(`media/blocks.ff-auto-untagged.lut${n}.rgb`), interior);
  }
}
fs.writeFileSync(path.join(root, 'results/parity.json'), JSON.stringify(rows, null, 1));
