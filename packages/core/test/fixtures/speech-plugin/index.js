// Test fixture: a paid speech provider (1 cent per character) that says any text as half a second of tone
// between a second of silence on each side, and counts its calls in `calls.txt` next to this file.
import { appendFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const RATE = 8000;
const here = fileURLToPath(new URL(".", import.meta.url));

function wav(samples) {
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
  samples.forEach((sample, i) => out.writeInt16LE(sample, 44 + i * 2));
  return out;
}

export function activate(api) {
  api.registerSpeechProvider({
    id: "paid-tone",
    defaultVoice: "narrator",
    voices: () => [{ id: "narrator", label: "Narrator", languages: ["es", "en"] }],
    estimate: (text) => ({ cost: text.length * 0.01, currency: "USD", characters: text.length }),
    async synthesize(text, _voice, _options, context) {
      appendFileSync(join(here, "calls.txt"), `${text}\n`);
      if (text.includes("explode")) throw new Error("the voice broke");
      const samples = new Array(RATE * 2.5).fill(0);
      for (let i = RATE; i < RATE * 1.5; i++) samples[i] = Math.round(8000 * Math.sin((2 * Math.PI * 300 * i) / RATE));
      const file = join(context.outDir, "out.wav");
      await writeFile(file, wav(samples));
      return { file };
    },
  });
}
