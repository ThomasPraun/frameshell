// Takes of the QUALITY lines made by a TTS program the way the `command` provider runs one (ADR 0034 decision 5):
// spoken text on stdin as UTF-8, `{out}` in an argument replaced by the WAV path, no shell. Then check.ts.
// Usage: node src/baseline.ts <tag> <es|en> <program> [args with {out}]
//   macOS:   node src/baseline.ts es-say-paulina es say -v Paulina --data-format=LEI16@22050 -o {out} -f -
//   Windows: node src/baseline.ts en-sapi-zira en powershell -NoProfile -Command "$(cat scripts/sapi-command.txt)"
//            (inline command: the default execution policy refuses .ps1 files; edit the voice name inside)
import { spawn } from "node:child_process";
import { join } from "node:path";
import { QUALITY, spoken } from "./lines.ts";
import { built } from "./paths.ts";
import { type TakeEntry, saveSet, setDir } from "./takes.ts";

const [tag, lang, program, ...args] = process.argv.slice(2);
if (!tag || (lang !== "es" && lang !== "en") || !program) throw new Error("Usage: node src/baseline.ts <tag> <es|en> <program> [args]");
const { readPcmWav } = await built<any>("packages/core/dist/transcripts/window.js");

function run(text: string, out: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(program!, args.map((a) => a.replaceAll("{out}", out)), { stdio: ["pipe", "ignore", "inherit"] });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${program} exited ${code}`))));
    child.stdin.end(text, "utf8");
  });
}

const lines: TakeEntry[] = [];
for (const line of QUALITY.filter((l) => l.lang === lang)) {
  const text = spoken(line);
  const file = join(setDir(tag), `${line.id}.wav`);
  const started = performance.now();
  await run(text, file);
  const pcm = await readPcmWav(file);
  if (!pcm) throw new Error(`${file}: not a mono 16-bit PCM WAV`);
  lines.push({
    id: line.id, lang: line.lang, display: line.display, spoken: text, phonemes: null, file,
    audioS: +(pcm.samples.length / pcm.sampleRate).toFixed(2), ms: Math.round(performance.now() - started), cpuMs: null,
  });
}
await saveSet({ tag, maker: `command ${program} ${args.join(" ")}`, lines });
console.log(`ok: ${setDir(tag)}`);
