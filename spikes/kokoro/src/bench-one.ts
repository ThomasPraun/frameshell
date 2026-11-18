// Wall-clock and this thread's CPU time (process.threadCpuUsage: a loaded shared machine inflates wall time).
// One speed run of one model variant: cold load, then every SPEED line once (after one warm-up run), in this
// thread or in a worker thread (the way a provider would run off the daemon's event loop). Prints one JSON line.
// Usage: node src/bench-one.ts <variant> [main|worker] [voice]   (KOKORO_LINES=s-03s,s-08s picks lines)
import { join } from "node:path";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { g2pEn } from "./g2p-en.ts";
import { g2pEs } from "./g2p-es.ts";
import { Kokoro, SAMPLE_RATE, loadVoice } from "./kokoro.ts";
import { SPEED, spoken } from "./lines.ts";
import { OUT } from "./paths.ts";
import { writeTake } from "./wav.ts";

interface Job { variant: string; voice: string; enVoice: string }

async function measure({ variant, voice, enVoice }: Job) {
  const loadCpu = process.threadCpuUsage();
  const kokoro = await Kokoro.load(variant);
  const loaded = process.threadCpuUsage(loadCpu);
  const voices = { es: loadVoice(voice), en: loadVoice(enVoice) };
  const warm = performance.now();
  await kokoro.speak("ˈola.", voices.es);
  const firstRunMs = performance.now() - warm;
  const lines = [];
  const only = process.env.KOKORO_LINES?.split(",");
  for (const line of SPEED.filter((l) => !only || only.includes(l.id))) {
    const text = spoken(line);
    const g2pStart = performance.now();
    const phonemes = line.lang === "es" ? g2pEs(text) : g2pEn(text);
    const g2pMs = performance.now() - g2pStart;
    const started = performance.now();
    const cpu = process.threadCpuUsage();
    const { samples, chunks, tokens } = await kokoro.speak(phonemes, voices[line.lang]);
    const ms = performance.now() - started;
    const used = process.threadCpuUsage(cpu);
    const cpuMs = (used.user + used.system) / 1000;
    const audioS = samples.length / SAMPLE_RATE;
    await writeTake(join(OUT, "speed", variant, `${line.id}.wav`), samples);
    lines.push({ id: line.id, tokens, chunks, audioS: +audioS.toFixed(2), ms: Math.round(ms), rtf: +(ms / 1000 / audioS).toFixed(3), cpuMs: Math.round(cpuMs), cpuRtf: +(cpuMs / 1000 / audioS).toFixed(3), g2pMs: +g2pMs.toFixed(2) });
  }
  return { loadMs: Math.round(kokoro.loadMs), loadCpuMs: Math.round((loaded.user + loaded.system) / 1000), firstRunMs: Math.round(firstRunMs), io: kokoro.io, lines };
}

if (!isMainThread) {
  parentPort!.postMessage(await measure(workerData as Job));
} else {
  const [variant = "int8", mode = "main", voice = "ef_dora"] = process.argv.slice(2);
  const job: Job = { variant, voice, enVoice: "af_heart" };
  const started = performance.now();
  const result =
    mode === "worker"
      ? await new Promise((resolve, reject) => {
          const worker = new Worker(new URL(import.meta.url), { workerData: job });
          worker.once("message", resolve);
          worker.once("error", reject);
        })
      : await measure(job);
  const totalMs = Math.round(performance.now() - started);
  // maxRSS is in kilobytes and covers worker threads (one process).
  const peakRssMb = Math.round(process.resourceUsage().maxRSS / 1024);
  console.log(JSON.stringify({ variant, mode, voice, totalMs, peakRssMb, ...(result as object) }));
  process.exit(0);
}
