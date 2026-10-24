// Q5: rolling-window live recognition. Simulates real time: window k ends at k*hop; processing starts when the audio is
// there and the previous window is done; latency = measured wall time of the call.
import path from 'node:path';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { ROOT, wer } from './lib.mjs';
import { loadPcm, writeWav, wavBuffer } from './wavutil.mjs';
import { truth } from './truth.mjs';
import { normalize } from './follower.mjs';

const arg = (k, d) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split('=')[1] ?? d;
const EXEC = arg('exec', 'cli'); // cli | server
const MODELS = arg('models', 'tiny,base,small').split(',');
const ACS = arg('ac', '0').split(',').map(Number);
const FIXTURES = arg('fixtures', 'a').split(',');
const WINDOWS = arg('windows', '3').split(',').map(Number);
const HOP = +arg('hop', '1');
const THREADS = arg('threads', '4');
const LIMIT = +arg('limit', 0); // max chunks (smoke)
const CLI = path.join(ROOT, 'bin/cli/whisper-cli');
const SERVER = path.join(ROOT, 'bin/build/bin/whisper-server');
const out = path.join(ROOT, 'out/q5'); mkdirSync(out, { recursive: true });
const run = (cmd, args) => new Promise((res) => { const t0 = performance.now(); const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] }); let so = '', se = ''; p.stdout.on('data', (d) => (so += d)); p.stderr.on('data', (d) => (se += d)); p.on('close', (code) => res({ code, so, se, ms: performance.now() - t0 })); });

async function cliChunk(model, ac, samples, tag) {
  const wav = path.join(out, `chunk-${tag}.wav`); writeWav(wav, samples);
  const of = path.join(out, `chunk-${tag}`);
  const args = ['-m', path.join(ROOT, `models/ggml-${model}.bin`), '-f', wav, '-l', 'es', '-t', THREADS, '-bs', '1', '-bo', '1', '-nf', '-ml', '1', '-sow', '-oj', '-of', of, '-np'];
  if (ac) args.push('-ac', String(ac));
  const r = await run(CLI, args);
  const j = JSON.parse(readFileSync(of + '.json', 'utf8'));
  const words = j.transcription.map((s) => ({ text: s.text.trim(), start: s.offsets.from / 1000, end: s.offsets.to / 1000 })).filter((w) => w.text && !/^\[.*\]$/.test(w.text));
  return { ms: r.ms, words, code: r.code };
}
let serverProc = null, serverKey = '', port = 8178;
async function startServer(model, ac) {
  const key = `${model}:${ac}`; if (serverKey === key) return;
  if (serverProc) { const old = serverProc; await new Promise((r) => { old.on('exit', r); old.kill('SIGKILL'); }); }
  const args = ['-m', path.join(ROOT, `models/ggml-${model}.bin`), '-l', 'es', '-t', THREADS, '-bs', '1', '-bo', '1', '-nf', '--port', String(++port), '--host', '127.0.0.1'];
  if (ac) args.push('-ac', String(ac));
  serverProc = spawn(SERVER, args, { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, DYLD_LIBRARY_PATH: path.join(ROOT, 'bin/build/bin') } }); serverProc.stderr.on('data', (d) => { if (/model type|n_text_layer|failed|error/i.test(String(d))) console.error('[server]', String(d).trim().slice(0, 160)); }); serverKey = key;
  for (let i = 0; i < 600; i++) { try { await fetch(`http://127.0.0.1:${port}/`); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
}
async function serverChunk(samples) {
  const fd = new FormData();
  fd.append('file', new Blob([wavBuffer(samples)], { type: 'audio/wav' }), 'chunk.wav');
  for (const [k, v] of Object.entries({ response_format: 'verbose_json', max_len: '1', split_on_word: 'true', temperature: '0.0', temperature_inc: '0.0', language: 'es' })) fd.append(k, v);
  const t0 = performance.now();
  const r = await fetch(`http://127.0.0.1:${port}/inference`, { method: 'POST', body: fd });
  const j = await r.json(); const ms = performance.now() - t0;
  const words = (j.segments ?? []).map((s) => ({ text: (s.text ?? '').trim(), start: s.start, end: s.end })).filter((w) => w.text && !/^\[.*\]$/.test(w.text));
  return { ms, words, code: r.status };
}

const summary = [];
for (const model of MODELS) for (const ac of ACS) {
  if (EXEC === 'server') await startServer(model, ac);
  // warm-up (Metal shader compile on a fresh binary/path is separate and reported once)
  const pcm0 = loadPcm(path.join(ROOT, 'media/speech/a.wav'));
  const w0 = performance.now();
  if (EXEC === 'cli') await cliChunk(model, ac, pcm0.subarray(0, 48000), 'warm'); else await serverChunk(pcm0.subarray(0, 48000));
  const warmMs = performance.now() - w0;
  for (const fx of FIXTURES) for (const W of WINDOWS) {
    const pcm = loadPcm(path.join(ROOT, `media/speech/${fx}.wav`)); const T = truth(fx);
    const id = `${EXEC}.${model}.ac${ac}.w${W}h${HOP}.${fx}`;
    const events = []; let prevDone = 0; const lat = [];
    const total = pcm.length / 16000;
    for (let k = 1, we = HOP; we <= total + HOP; k++, we = k * HOP) {
      if (LIMIT && k > LIMIT) break;
      const end = Math.min(we, total), ws = Math.max(0, we - W);
      const samples = pcm.subarray(Math.round(ws * 16000), Math.round(end * 16000));
      if (samples.length < 8000) continue;
      const r = EXEC === 'cli' ? await cliChunk(model, ac, samples, id.replace(/\W/g, '_')) : await serverChunk(samples);
      const start = Math.max(we, prevDone); const done = start + r.ms / 1000; prevDone = done; lat.push(r.ms);
      events.push({ k, ws, we: end, tStart: start, tReport: done, latencyMs: r.ms, queueWaitS: start - we, words: r.words.map((w) => ({ text: w.text, start: ws + w.start, end: ws + w.end })) });
    }
    // windowed WER: reference = truth words overlapping the window by >= 50% of their length; hypothesis = every word returned
    let errs = 0, refs = 0, loops = 0;
    for (const e of events) {
      const ref = T.words.filter((w) => Math.min(w.end, e.we) - Math.max(w.start, e.ws) >= 0.5 * (w.end - w.start)).map((w) => w.w);
      const hyp = e.words.flatMap((w) => normalize(w.text));
      errs += Math.min(1, wer(ref, hyp)) * ref.length; refs += ref.length; // per-window WER capped at 1: one hallucination loop must not swamp the mean
      const grams = new Map(); for (let i = 0; i + 3 <= hyp.length; i++) { const g = hyp.slice(i, i + 3).join(' '); grams.set(g, (grams.get(g) ?? 0) + 1); }
      if ([...grams.values()].some((c) => c >= 3)) loops++;
    }
    // whole-fixture text as the union of the non-overlapping part: last HOP seconds of each window (rough "stream" transcript)
    const sorted = [...lat].sort((a, b) => a - b);
    const row = { id, exec: EXEC, model, ac, window: W, hop: HOP, chunks: events.length, warmupMs: Math.round(warmMs), latencyMs: { mean: Math.round(lat.reduce((a, b) => a + b, 0) / lat.length), p50: Math.round(sorted[Math.floor(sorted.length * 0.5)]), p95: Math.round(sorted[Math.floor(sorted.length * 0.95)]), max: Math.round(sorted.at(-1)) }, maxQueueWaitS: +Math.max(...events.map((e) => e.queueWaitS)).toFixed(2), windowedWER: +(errs / refs).toFixed(3), loopWindows: loops, realtimeFactor: +(lat.reduce((a, b) => a + b, 0) / 1000 / (events.length * HOP)).toFixed(2) };
    console.log(JSON.stringify(row)); summary.push(row);
    writeFileSync(path.join(out, `${id}.json`), JSON.stringify({ row, events }, null, 2));
  }
}
if (serverProc) serverProc.kill();
const sumFile = path.join(out, `summary-${EXEC}.json`);
const prev = existsSync(sumFile) ? JSON.parse(readFileSync(sumFile, 'utf8')) : [];
writeFileSync(sumFile, JSON.stringify([...prev.filter((p) => !summary.some((s) => s.id === p.id)), ...summary], null, 2));
