// PROTOTYPE. Runs every engine config on the fixtures and normalizes output to
// out/<run>.words.json: { words: [{text, start, end, dtwStart?, p}], wallSec, engineSec, audioSec }.
// Usage: node scripts/transcribe.mjs [substring-filter] [--force]
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadavg } from 'node:os';
import { ROOT, MEDIA, OUT, SR, readWav } from './lib.mjs';

const CLI = join(ROOT, 'vendor/whisper.cpp/build/bin/whisper-cli');
const PY = join(ROOT, '.venv/bin/python');
const THREADS = 4; // M3 has 4 performance cores; E-cores slow whisper down.

const model = (q) => join(ROOT, 'models', `ggml-large-v3-turbo${q === 'f16' ? '' : '-' + q}.bin`);

/** Run matrix. `audio` lists which fixtures a config runs on. */
const RUNS = [];
for (const q of ['f16', 'q8_0', 'q5_0']) {
  for (const dtw of [false, true]) {
    RUNS.push({ name: `wcpp-${q}-metal${dtw ? '-dtw' : ''}`, engine: 'wcpp', q, gpu: true, dtw, audio: ['original', 'variant'] });
  }
}
RUNS.push({ name: 'wcpp-f16-metal-dtw-vad', engine: 'wcpp', q: 'f16', gpu: true, dtw: true, vad: true, audio: ['original', 'variant'] });
RUNS.push({ name: 'wcpp-f16-cpu', engine: 'wcpp', q: 'f16', gpu: false, dtw: false, audio: ['original'] });
RUNS.push({ name: 'wcpp-q5_0-cpu', engine: 'wcpp', q: 'q5_0', gpu: false, dtw: false, audio: ['original'] });
RUNS.push({ name: 'fw-f32-cpu', engine: 'fw', computeType: 'float32', audio: ['original', 'variant'] });
RUNS.push({ name: 'fw-int8-cpu', engine: 'fw', computeType: 'int8', audio: ['original'] });

const filter = process.argv.slice(2).find((a) => !a.startsWith('--'));
const force = process.argv.includes('--force');
mkdirSync(OUT, { recursive: true });

/** Groups whisper.cpp `-ml 1 -sow` segments (one per word) into normalized words. */
function wcppWords(json) {
  const words = [];
  for (const seg of json.transcription) {
    const text = seg.text;
    if (!text.trim()) continue;
    const toks = (seg.tokens || []).filter((t) => !/^\[_|^<\|/.test(t.text));
    const dtw = toks.find((t) => t.t_dtw >= 0);
    words.push({
      text,
      start: seg.offsets.from / 1000,
      end: seg.offsets.to / 1000,
      dtwStart: dtw ? dtw.t_dtw / 100 : undefined,
      p: toks.length ? Math.min(...toks.map((t) => t.p)) : 0,
    });
  }
  return words;
}

for (const run of RUNS) {
  if (filter && !run.name.includes(filter)) continue;
  for (const a of run.audio) {
    const id = `${run.name}__${a}`;
    const dest = join(OUT, `${id}.words.json`);
    if (existsSync(dest) && !force) { console.log(`skip ${id}`); continue; }
    const wav = join(MEDIA, `${a}.wav`);
    const audioSec = readWav(wav).pcm.length / SR;
    const load1Before = loadavg()[0]; // machine may be shared: record contention
    const t0 = performance.now();
    let result;
    if (run.engine === 'wcpp') {
      const args = ['-m', model(run.q), '-f', wav, '-l', 'es', '-t', String(THREADS), '-ml', '1', '-sow', '-ojf', '-of', join(OUT, id)];
      if (!run.gpu) args.push('-ng');
      if (run.dtw) args.push('-dtw', 'large.v3.turbo', '-nfa'); // whisper.cpp disables DTW under flash attention
      if (run.vad) args.push('--vad', '-vm', join(ROOT, 'models/ggml-silero-v5.1.2.bin'));
      const r = spawnSync(CLI, args, { encoding: 'utf8', maxBuffer: 1 << 28 });
      if (r.status !== 0) { console.error(r.stderr); throw new Error(`${id} failed`); }
      writeFileSync(join(OUT, `${id}.stderr.log`), r.stderr);
      const total = /total time =\s*([\d.]+) ms/.exec(r.stderr);
      const json = JSON.parse(readFileSync(join(OUT, `${id}.json`), 'utf8'));
      // Metal shaders compile per process; startup cost outside whisper's own "total time".
      const metalCompileSec = [...r.stderr.matchAll(/compiled '\w+' library in ([\d.]+) sec/g)].reduce((s, m) => s + +m[1], 0);
      result = { words: wcppWords(json), engineSec: total ? +total[1] / 1000 : undefined, metalCompileSec };
    } else {
      const raw = join(OUT, `${id}.fw.json`);
      const r = spawnSync(PY, [join(ROOT, 'scripts/fw_transcribe.py'), wav, raw, run.computeType, String(THREADS)], {
        encoding: 'utf8', env: { ...process.env, HF_HOME: join(ROOT, 'models/hf') }, maxBuffer: 1 << 28,
      });
      if (r.status !== 0) { console.error(r.stderr); throw new Error(`${id} failed`); }
      const json = JSON.parse(readFileSync(raw, 'utf8'));
      result = { words: json.words, engineSec: json.loadSec + json.transcribeSec, loadSec: json.loadSec };
    }
    const wallSec = (performance.now() - t0) / 1000;
    const rec = { run: run.name, audio: a, config: run, audioSec, wallSec, ...result, rtf: wallSec / audioSec, load1Before, load1After: loadavg()[0] };
    writeFileSync(dest, JSON.stringify(rec));
    console.log(`${id}: ${result.words.length} words, wall ${wallSec.toFixed(1)}s, RTF ${rec.rtf.toFixed(3)}`);
  }
}
