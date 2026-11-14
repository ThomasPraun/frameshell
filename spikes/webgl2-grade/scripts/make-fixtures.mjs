// PROTOTYPE (#384 G0). Writes the synthetic fixtures and the ffmpeg reference outputs into media/.
// Usage: node scripts/make-fixtures.mjs  (FFMPEG=path overrides the pinned test ffmpeg)
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const media = path.join(root, 'media');
fs.mkdirSync(media, { recursive: true });
const ffmpeg =
  process.env.FFMPEG ??
  path.resolve(root, '../../.cache/test-binaries/binaries/ffmpeg/9.0.2/darwin-arm64/ffmpeg');
const W = 1920;
const H = 1080;

const run = (args, input) =>
  execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { input, maxBuffer: 1 << 30 });

// Deterministic PRNG (mulberry32).
function prng(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// A deliberately strong look: S-curve contrast, saturation 1.5, a hue twist and a warm offset,
// so trilinear interpolation error between lattice points is visible.
export function look(r, g, b) {
  const s = (x) => x * x * (3 - 2 * x) * 0.6 + x * 0.4;
  let [R, G, B] = [s(r), s(g), s(b)];
  const y = 0.2126 * R + 0.7152 * G + 0.0722 * B;
  [R, G, B] = [y + (R - y) * 1.5, y + (G - y) * 1.5, y + (B - y) * 1.5];
  [R, G, B] = [R * 0.9 + G * 0.1, G * 0.95 + B * 0.05, B * 0.85 + R * 0.15];
  const c = (x) => Math.min(1, Math.max(0, x));
  return [c(R + 0.03), c(G + 0.005), c(B - 0.03)];
}

for (const n of [33, 65]) {
  const lines = [`TITLE "spike look ${n}"`, `LUT_3D_SIZE ${n}`, 'DOMAIN_MIN 0 0 0', 'DOMAIN_MAX 1 1 1'];
  // .cube order: red changes fastest, then green, then blue.
  for (let b = 0; b < n; b++)
    for (let g = 0; g < n; g++)
      for (let r = 0; r < n; r++) lines.push(look(r / (n - 1), g / (n - 1), b / (n - 1)).map((v) => v.toFixed(6)).join(' '));
  fs.writeFileSync(path.join(media, `look${n}.cube`), lines.join('\n') + '\n');
}

// 1. Random RGB frame (every pixel independent): pure LUT parity, no YUV involved.
{
  const rnd = prng(384);
  const rgb = Buffer.alloc(W * H * 3);
  for (let i = 0; i < rgb.length; i++) rgb[i] = Math.floor(rnd() * 256);
  // Include the exact cube corners and the grey ramp in the first row.
  for (let x = 0; x < 256; x++) rgb.set([x, x, x], x * 3);
  for (let k = 0; k < 8; k++) rgb.set([k & 1 ? 255 : 0, k & 2 ? 255 : 0, k & 4 ? 255 : 0], (256 + k) * 3);
  fs.writeFileSync(path.join(media, 'random.rgb'), rgb);
  run(['-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${W}x${H}`, '-i', '-', path.join(media, 'random.png')], rgb);
  for (const n of [33, 65]) {
    run(['-i', path.join(media, 'random.png'), '-vf', `lut3d=file=${path.join(media, `look${n}.cube`)}:interp=trilinear`,
      '-f', 'rawvideo', '-pix_fmt', 'rgb24', path.join(media, `random.ffmpeg${n}.rgb`)]);
  }
}

// 2. 8x8 blocks of random colour, encoded as bt709 limited-range H.264 (tagged and untagged):
// the video path. Blocks keep 4:2:0 chroma constant inside each block.
{
  const rnd = prng(709);
  const rgb = Buffer.alloc(W * H * 3);
  for (let by = 0; by < H / 8; by++)
    for (let bx = 0; bx < W / 8; bx++) {
      const c = [0, 0, 0].map(() => Math.floor(rnd() * 256));
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) rgb.set(c, ((by * 8 + y) * W + bx * 8 + x) * 3);
    }
  fs.writeFileSync(path.join(media, 'blocks.rgb'), rgb);
  const enc = (tags, out) =>
    run(['-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${W}x${H}`, '-r', '30', '-i', '-', '-frames:v', '2',
      '-vf', 'scale=out_color_matrix=bt709:out_range=tv:flags=accurate_rnd+full_chroma_int,format=yuv420p',
      '-c:v', 'libx264', '-profile:v', 'high', '-crf', '4', '-bf', '0', '-g', '15', '-x264-params', 'aud=1',
      ...tags, '-f', 'h264', path.join(media, out)], Buffer.concat([rgb, rgb]));
  enc(['-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv'], 'blocks.tagged.h264');
  // Untagged: VUI colour description says "unspecified" (2), as from cameras and screen recorders that omit it.
  enc(['-bsf:v', 'h264_metadata=colour_primaries=2:transfer_characteristics=2:matrix_coefficients=2'], 'blocks.untagged.h264');
  const dec = (src, vf, out) =>
    run(['-i', path.join(media, src), '-frames:v', '1', '-vf', vf, '-f', 'rawvideo', '-pix_fmt', 'rgb24', path.join(media, out)]);
  const exact = 'scale=in_color_matrix=bt709:in_range=tv:flags=accurate_rnd+full_chroma_int+bitexact,format=rgb24';
  run(['-i', path.join(media, 'blocks.tagged.h264'), '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'yuv420p', path.join(media, 'blocks.yuv')]);
  dec('blocks.tagged.h264', exact, 'blocks.ff-exact.rgb');
  dec('blocks.tagged.h264', 'format=rgba', 'blocks.ff-auto-tagged.rgb');
  dec('blocks.untagged.h264', 'format=rgba', 'blocks.ff-auto-untagged.rgb');
  for (const n of [33, 65]) {
    const lut = `lut3d=file=${path.join(media, `look${n}.cube`)}:interp=trilinear`;
    dec('blocks.tagged.h264', `${exact},${lut}`, `blocks.ff-exact.lut${n}.rgb`);
    dec('blocks.tagged.h264', `format=rgba,${lut}`, `blocks.ff-auto-tagged.lut${n}.rgb`);
    dec('blocks.untagged.h264', `format=rgba,${lut}`, `blocks.ff-auto-untagged.lut${n}.rgb`);
  }
}

// 3. Playback streams for the cost measurement: 10 s testsrc2 at 1080p30 and the 540p proxy size,
// encoded like the proxy recipe (High, no B-frames, GOP 15, bt709 tv), Annex B with AUDs.
for (const [name, size] of [['bench1080', '1920x1080'], ['bench540', '960x540']]) {
  run(['-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=30:duration=10`,
    '-vf', 'scale=out_color_matrix=bt709:out_range=tv,format=yuv420p',
    '-c:v', 'libx264', '-profile:v', 'high', '-crf', '20', '-bf', '0', '-g', '15', '-x264-params', 'aud=1',
    '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv',
    '-f', 'h264', path.join(media, `${name}.h264`)]);
}
console.log('fixtures in', media);
