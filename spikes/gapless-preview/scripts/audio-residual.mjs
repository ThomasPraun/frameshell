// PROTOTYPE. Sample-exact check for audio-clocked runs (A2, B, B-bufsrc): rebuilds the expected
// program audio from the PCM sidecar (same 2 ms fades) and lists where the recorded output
// deviates by more than 0.02. Usage: node scripts/audio-residual.mjs A2 B B-bufsrc
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pcm = readFileSync(join(root, 'media', 'proxy.pcm'));
const pcmAt = (i) => pcm.readInt16LE(i * 2) / 32768;
for (const run of process.argv.slice(2)) {
  const R = JSON.parse(readFileSync(join(root, 'out', `${run}.json`), 'utf8'));
  const b = readFileSync(join(root, 'out', `${run}.f32`));
  const x = new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
  const spf = R.sampleRate / R.fps;
  const off = Math.round(R.startCtx * R.sampleRate) - R.recFirstFrame;
  const cutAt = new Set(R.segs.map((s) => s.pF * spf));
  const runs = [];
  let o = 0, start = -1, prev = -1e9, bad = 0;
  for (const s of R.segs) {
    const n = (s.outF - s.inF) * spf;
    for (let i = 0; i < n; i++) {
      let e = pcmAt(s.inF * spf + i);
      if (i < 96) e *= i / 96;
      if (n - 1 - i < 96) e *= (n - 1 - i) / 96;
      if (Math.abs(x[off + o + i] - e) > 0.02) {
        bad++;
        const j = o + i;
        if (j - prev > 480) { if (start >= 0) runs.push([start, prev]); start = j; }
        prev = j;
      }
    }
    o += n;
  }
  if (start >= 0) runs.push([start, prev]);
  const nearCut = (j) => [...cutAt].some((c) => Math.abs(c - j) < 0.1 * R.sampleRate);
  const atCuts = runs.filter(([a]) => nearCut(a)).length;
  console.log(`${run}: ${o} samples compared, ${bad} deviate; ${runs.length} deviation bursts (${atCuts} within 100 ms of a cut)`);
  for (const [a, z] of runs.slice(0, 20)) console.log(`  program ${(a / R.sampleRate).toFixed(3)} s, ${((z - a + 1) / (R.sampleRate / 1000)).toFixed(1)} ms${nearCut(a) ? ' (cut)' : ''}`);
}
