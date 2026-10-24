// Q5 reference: whole-file transcription per model (accuracy without window effects) vs the spoken text.
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { readFileSync, mkdirSync } from 'node:fs';
import { ROOT, wer } from './lib.mjs';
import { normalize } from './follower.mjs';
import { VARIANTS } from './speech-data.mjs';
const out = path.join(ROOT, 'out/q5'); mkdirSync(out, { recursive: true });
for (const model of ['tiny', 'base', 'small', 'tiny-q5_1', 'base-q5_1', 'small-q5_1']) for (const fx of ['a', 'b']) {
  const of = path.join(out, `offline-${model}-${fx}`);
  const t0 = performance.now();
  spawnSync(path.join(ROOT, 'bin/cli/whisper-cli'), ['-m', path.join(ROOT, `models/ggml-${model}.bin`), '-f', path.join(ROOT, `media/speech/${fx}.wav`), '-l', 'es', '-t', '4', '-bs', '1', '-bo', '1', '-oj', '-of', of, '-np']);
  const ms = performance.now() - t0;
  const j = JSON.parse(readFileSync(of + '.json', 'utf8'));
  const hyp = normalize(j.transcription.map((s) => s.text).join(' '));
  const ref = normalize(VARIANTS[fx].join(' '));
  console.log(JSON.stringify({ model, fx, wer: +wer(ref, hyp).toFixed(3), words: ref.length, wallMs: Math.round(ms) }));
}
