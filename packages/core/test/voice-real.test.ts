import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BinaryManager, ONNX_RUNTIME_WEB, SPEAKER_EMBEDDING_MODEL, campplusWorkerEmbedder, meanPrint, speakerSuggestions } from "../src/index.js";
import { tempDir } from "./helpers.js";
import { mediaTools } from "./media-tools.js";

// Opt-in, macOS only: downloads the pinned ONNX Runtime Web (33 MB) and CAM++ speaker model (30 MB), speaks two
// passages in each of three macOS voices with `say`, and checks that voice prints match the same voice across
// passages and not different voices. Run with FRAMESHELL_TEST_REAL_VOICES=1 pnpm test.
// FRAMESHELL_TEST_DATA_DIR reuses installs between runs.
const PASSAGES = [
  "The quick brown fox jumps over the lazy dog while the farmer watches from the porch, sipping his coffee and thinking about the harvest.",
  "Yesterday we drove to the coast and walked along the beach for hours, collecting shells and talking about the books we had read.",
];
const VOICES = ["Daniel", "Samantha", "Fred"];

describe.runIf(process.env["FRAMESHELL_TEST_REAL_VOICES"] === "1" && process.platform === "darwin")("real CAM++ voice prints", () => {
  it(
    "suggests the same voice in another recording and not a different voice",
    async () => {
      const binaries = new BinaryManager({ dataDir: process.env["FRAMESHELL_TEST_DATA_DIR"] ?? tempDir(), configDir: tempDir() });
      const embed = campplusWorkerEmbedder({
        runtime: await binaries.ensure(ONNX_RUNTIME_WEB, undefined),
        model: await binaries.ensureModel(SPEAKER_EMBEDDING_MODEL),
      });
      const { ffmpeg } = await mediaTools();
      const dir = tempDir();
      const prints = new Map<string, number[]>();
      for (const name of VOICES) {
        for (const [index, text] of PASSAGES.entries()) {
          const aiff = join(dir, `${name}-${index}.aiff`);
          const wav = join(dir, `${name}-${index}.wav`);
          execFileSync("say", ["-v", name, "-o", aiff, text]);
          execFileSync(ffmpeg, ["-loglevel", "error", "-y", "-i", aiff, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wav]);
          // Two stretches per recording, as a speaker's longest runs would be.
          const stretches = [
            { start: 0.3, end: 3.8 },
            { start: 4, end: 7.5 },
          ];
          const embeddings = await embed({ audio: wav, stretches });
          prints.set(`${name}-${index}`, meanPrint(embeddings, [3.5, 3.5])!);
        }
      }
      const people = VOICES.map((name) => ({ id: `p_${name.toLowerCase()}`, name, print: prints.get(`${name}-0`)! }));
      const speakers = VOICES.map((name) => ({ transcript: `transcripts/${name}.words.json`, speaker: "s1", name, print: prints.get(`${name}-1`)! }));
      const all = speakerSuggestions(people, speakers);
      console.log(all.map((suggestion) => suggestion.reason).join("\n"));
      expect(all.map((suggestion) => [suggestion.speaker?.name, suggestion.person?.name])).toEqual(
        expect.arrayContaining(VOICES.map((name) => [name, name])),
      );
      expect(all).toHaveLength(VOICES.length);
      // Only Daniel is known: Samantha's and Fred's second passages must not be suggested as him.
      const daniel = speakerSuggestions([people[0]!], speakers);
      expect(daniel.map((suggestion) => suggestion.speaker?.name)).toEqual(["Daniel"]);
    },
    600_000,
  );
});
