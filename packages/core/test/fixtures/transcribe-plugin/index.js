// Test fixture: a transcription provider that "hears" the words listed in `words.json` next to this file (one list
// per call, in order, starting over after the last) and logs the sample rate and options of each call in `calls.txt`.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));

export function activate(api) {
  api.registerTranscriptionProvider({
    id: "fake-heard",
    defaultModel: "fake-model",
    async transcribe(audio, options) {
      const rate = readFileSync(audio).readUInt32LE(24);
      const log = join(here, "calls.txt");
      const calls = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").length : 0;
      appendFileSync(log, `${rate} ${JSON.stringify(options)}\n`);
      const file = join(here, "words.json");
      const lists = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : [[]];
      const words = lists[calls % lists.length];
      return { model: options.model ?? "fake-model", language: options.language, words };
    },
  });
}
