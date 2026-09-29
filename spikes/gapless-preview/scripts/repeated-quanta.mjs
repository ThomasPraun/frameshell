// PROTOTYPE. Counts non-silent 128-sample render quanta identical to the previous quantum in
// recorded runs (a 220 Hz sine never repeats within 128 samples, so each hit is a glitch).
// Usage: node scripts/repeated-quanta.mjs C-osc C-wsine A1 A2 B
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'out');
for (const run of process.argv.slice(2)) {
  const b = readFileSync(join(out, `${run}.f32`));
  const x = new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
  let rep = 0, loudQ = 0;
  for (let q = 1; (q + 1) * 128 <= x.length; q++) {
    let eq = 0, loud = 0;
    for (let i = 0; i < 128; i++) { if (x[q * 128 + i] === x[(q - 1) * 128 + i]) eq++; if (Math.abs(x[q * 128 + i]) > 0.01) loud++; }
    if (loud > 50) { loudQ++; if (eq >= 100) rep++; }
  }
  console.log(`${run}: ${rep} repeated quanta in ${(loudQ * 128 / 48000).toFixed(0)} s of non-silent audio`);
}
