// Q5/Q6 fixtures: Spanish speech with macOS `say` (voice Paulina, es_MX). media/ is gitignored.
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT, FFMPEG, probe } from './lib.mjs';
import { VARIANTS, SCRIPT } from './speech-data.mjs';

const VOICE = process.argv.find((a) => a.startsWith('--voice='))?.slice(8) ?? 'Paulina';
const RATE = process.argv.find((a) => a.startsWith('--rate='))?.slice(7) ?? '175';
const dir = path.join(ROOT, 'media/speech'); mkdirSync(dir, { recursive: true });
const PAUSE = 0.45;
writeFileSync(path.join(dir, 'script.md'), '# Guion\n\n' + SCRIPT.join('\n\n') + '\n');
for (const [name, sents] of Object.entries(VARIANTS)) {
  const list = []; const segs = []; let t = 0;
  sents.forEach((s, i) => {
    const aiff = path.join(dir, `${name}-${i}.aiff`); const wav = path.join(dir, `${name}-${i}.wav`);
    spawnSync('say', ['-v', VOICE, '-r', RATE, '-o', aiff, s]);
    spawnSync(FFMPEG, ['-v', 'error', '-y', '-i', aiff, '-ar', '16000', '-ac', '1', wav]);
    const d = +probe(wav).format.duration;
    segs.push({ text: s, start: +t.toFixed(3), end: +(t + d).toFixed(3) });
    list.push(`file '${wav}'`); t += d;
    const sil = path.join(dir, `sil.wav`);
    spawnSync(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', `anullsrc=r=16000:cl=mono`, '-t', String(PAUSE), sil]);
    list.push(`file '${sil}'`); t += PAUSE;
  });
  writeFileSync(path.join(dir, `${name}.txt`), list.join('\n'));
  spawnSync(FFMPEG, ['-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', path.join(dir, `${name}.txt`), '-c', 'copy', path.join(dir, `${name}.wav`)]);
  writeFileSync(path.join(dir, `${name}.segments.json`), JSON.stringify(segs, null, 2));
  console.log(name, 'duration', t.toFixed(1), 's');
}
