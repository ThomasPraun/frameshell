// Test fixture: a TTS program for the `command` speech provider. Reads the text from stdin and says it as one tone
// per word (200 ms of silence, then 150 ms per word, then 200 ms of silence) into `--out <file>` or, with
// `--stdout`, to stdout. `--log <file>` appends `{ text, argv }` as one JSON line. Text with "explode" fails;
// text with "hang" never ends.
import { appendFileSync, writeFileSync } from "node:fs";

const RATE = 16000;
const argv = process.argv.slice(2);
const flag = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);

let text = "";
for await (const chunk of process.stdin) text += chunk;
if (flag("--log")) appendFileSync(flag("--log"), `${JSON.stringify({ text, argv })}\n`);
if (text.includes("explode")) {
  console.error("the voice broke");
  process.exit(3);
}
if (text.includes("hang")) setInterval(() => {}, 1000);
else {
  const words = text.split(/\s+/).filter(Boolean).length;
  const hz = flag("--voice") === "low" ? 200 : 400;
  const pad = Math.round(0.2 * RATE);
  const word = Math.round(0.15 * RATE);
  const samples = new Int16Array(pad * 2 + words * word);
  for (let i = 0; i < words * word; i++) samples[pad + i] = Math.round(9000 * Math.sin((2 * Math.PI * hz * i) / RATE));
  const out = Buffer.alloc(44 + samples.length * 2);
  out.write("RIFF", 0, "ascii");
  out.writeUInt32LE(36 + samples.length * 2, 4);
  out.write("WAVEfmt ", 8, "ascii");
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(1, 22);
  out.writeUInt32LE(RATE, 24);
  out.writeUInt32LE(RATE * 2, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write("data", 36, "ascii");
  out.writeUInt32LE(samples.length * 2, 40);
  Buffer.from(samples.buffer).copy(out, 44);
  if (argv.includes("--stdout")) process.stdout.write(out);
  else writeFileSync(flag("--out"), out);
}
