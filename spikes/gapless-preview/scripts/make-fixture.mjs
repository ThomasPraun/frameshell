// PROTOTYPE. Generates the synthetic fixture for spike #2:
//   media/source.mp4    30 min 1080p30, long GOP, burned-in frame barcode + counter, 220 Hz sine
//   media/proxy.mp4     960x540 CFR 30 fps H.264, GOP 15, no B-frames, faststart, AAC 48 kHz
//   media/proxy.pcm     mono s16le 48 kHz decoded from the proxy audio (Web Audio sidecar)
//   media/cutlist.json  ~200 cuts, kept segments 0.5-20 s, frame-snapped, seeded
// Usage: node scripts/make-fixture.mjs [--minutes 30] [--force]
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ffmpeg from 'ffmpeg-static';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const media = join(root, 'media');
mkdirSync(media, { recursive: true });

const args = process.argv.slice(2);
const minutes = Number(args[args.indexOf('--minutes') + 1] || 30) || 30;
const force = args.includes('--force');
const FPS = 30;
const duration = minutes * 60;

function run(argv) {
  const t0 = Date.now();
  console.log('ffmpeg', argv.join(' '));
  const r = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-stats', '-y', ...argv], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`ffmpeg failed (${r.status})`);
  console.log(`  done in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
}

const hasDrawtext = spawnSync(ffmpeg, ['-hide_banner', '-filters'], { encoding: 'utf8' }).stdout.includes(' drawtext ');
const font = ['/System/Library/Fonts/Menlo.ttc', '/System/Library/Fonts/Supplemental/Arial.ttf'].find(existsSync);

// Barcode: 16 cells x 80 px. Row 0 = bits of N (LSB left), row 1 = complement (validity check).
const bit = 'mod(floor(N/pow(2,floor(X/80))),2)';
const barcode = `color=c=black:s=1280x80:r=${FPS}:d=${duration},format=gray,geq=lum='if(lt(Y,40),255*${bit},255*(1-${bit}))'`;
let vchain = `[0:v][1:v]overlay=0:0:shortest=1`;
if (hasDrawtext && font) {
  vchain += `,drawtext=fontfile=${font}:text='%{frame_num}  %{pts\\:hms}':x=40:y=120:fontsize=72:fontcolor=white:box=1:boxcolor=black@0.7`;
} else {
  console.warn('drawtext unavailable: only the machine-readable barcode is burned in');
}

const source = join(media, 'source.mp4');
if (force || !existsSync(source)) {
  run([
    '-f', 'lavfi', '-i', `testsrc2=s=1920x1080:r=${FPS}:d=${duration}`,
    '-f', 'lavfi', '-i', barcode,
    '-f', 'lavfi', '-i', `aevalsrc=0.5*sin(2*PI*220*t):s=48000:d=${duration}`,
    '-filter_complex', `${vchain}[v]`,
    '-map', '[v]', '-map', '2:a',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28', '-g', '300', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k',
    source,
  ]);
}

// Proxy recipe under test: short GOP, CFR, no B-frames (decode order == display order).
const proxy = join(media, 'proxy.mp4');
if (force || !existsSync(proxy)) {
  run([
    '-i', source,
    '-vf', 'scale=960:540', '-r', String(FPS), '-fps_mode', 'cfr',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '24', '-g', '15', '-keyint_min', '15',
    '-sc_threshold', '0', '-bf', '0', '-pix_fmt', 'yuv420p', '-profile:v', 'high',
    '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2',
    '-movflags', '+faststart',
    proxy,
  ]);
}

const pcm = join(media, 'proxy.pcm');
if (force || !existsSync(pcm)) {
  run(['-i', proxy, '-vn', '-ac', '1', '-ar', '48000', '-f', 's16le', pcm]);
}

// Seeded cut list: log-uniform kept lengths 0.5-20 s, removed gaps 0.2-4 s.
let seed = 0x5eed2;
const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const logUniform = (a, b) => Math.exp(Math.log(a) + rand() * (Math.log(b) - Math.log(a)));
const snap = (s) => Math.round(s * FPS) / FPS;
const segments = [];
let t = snap(1 + rand() * 2);
while (segments.length < 201) {
  const len = snap(logUniform(0.5, 20));
  if (t + len > duration - 1) break;
  segments.push({ in: Number(t.toFixed(3)), out: Number(snap(t + len).toFixed(3)) });
  t = snap(t + len + logUniform(0.2, 4));
}
const programDuration = segments.reduce((s, x) => s + (x.out - x.in), 0);
writeFileSync(join(media, 'cutlist.json'), JSON.stringify({ fps: FPS, source: 'proxy.mp4', segments }, null, 2));
console.log(`cut list: ${segments.length} segments, ${segments.length - 1} cuts, program ${programDuration.toFixed(1)} s`);
for (const f of [source, proxy, pcm]) console.log(f, (statSync(f).size / 2 ** 20).toFixed(1), 'MiB');
