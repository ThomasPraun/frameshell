// Kokoro takes of the QUALITY lines of one language, for the whisper round trip (check.ts) and for listening.
// Usage: node src/synth.ts <tag> <variant> <voice> <es|en> [--castilian] [--no-allophones] [--lleismo]
import { join } from "node:path";
import { g2pEn } from "./g2p-en.ts";
import { g2pEs } from "./g2p-es.ts";
import { Kokoro, SAMPLE_RATE, loadVoice } from "./kokoro.ts";
import { type Lang, QUALITY, spoken } from "./lines.ts";
import { type TakeEntry, saveSet, setDir } from "./takes.ts";
import { writeTake } from "./wav.ts";

const [tag, variant, voiceName, lang, ...flags] = process.argv.slice(2);
if (!tag || !variant || !voiceName || (lang !== "es" && lang !== "en")) {
  throw new Error("Usage: node src/synth.ts <tag> <variant> <voice> <es|en> [--castilian] [--no-allophones] [--lleismo]");
}
const es = { seseo: !flags.includes("--castilian"), allophones: !flags.includes("--no-allophones"), yeismo: !flags.includes("--lleismo") };
const kokoro = await Kokoro.load(variant);
const voice = loadVoice(voiceName);
const lines: TakeEntry[] = [];
for (const line of QUALITY.filter((l) => l.lang === (lang as Lang))) {
  const text = spoken(line);
  const phonemes = line.lang === "es" ? g2pEs(text, es) : g2pEn(text);
  const started = performance.now();
  const cpu = process.threadCpuUsage();
  const { samples } = await kokoro.speak(phonemes, voice);
  const used = process.threadCpuUsage(cpu);
  const file = join(setDir(tag), `${line.id}.wav`);
  await writeTake(file, samples);
  const entry = {
    id: line.id, lang: line.lang, display: line.display, spoken: text, phonemes, file,
    audioS: +(samples.length / SAMPLE_RATE).toFixed(2), ms: Math.round(performance.now() - started),
    cpuMs: Math.round((used.user + used.system) / 1000),
  };
  lines.push(entry);
  console.log(`${line.id}  ${entry.audioS} s audio  ${entry.ms} ms  cpu ${entry.cpuMs} ms`);
}
await saveSet({ tag, maker: `kokoro ${variant} ${voiceName} ${flags.join(" ")}`.trim(), lines });
