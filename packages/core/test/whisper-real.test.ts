import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createWhisperProvider } from "../../../plugins/whisper-cpp/src/index.js";
import { BinaryManager, currentPlatform, transcribeAsset } from "../src/index.js";
import { tempDir } from "./helpers.js";

// Opt-in: installs the real pinned whisper.cpp for this platform (macOS: builds it, needs CMake and the
// Xcode Command Line Tools), downloads the 574 MB default model, and transcribes 11 s of public-domain
// speech (JFK inaugural address, whisper.cpp's own sample). Run with FRAMESHELL_TEST_REAL_WHISPER=1 pnpm test.
// FRAMESHELL_TEST_DATA_DIR reuses installs between runs.
const JFK_URL = "https://raw.githubusercontent.com/ggml-org/whisper.cpp/927cfce34f31707e17f2bff35c349632fb9e2c3a/samples/jfk.wav";
const JFK_SHA256 = "59dfb9a4acb36fe2a2affc14bacbee2920ff435cb13cc314a08c13f66ba7860e";

describe.runIf(process.env["FRAMESHELL_TEST_REAL_WHISPER"] === "1")("real whisper.cpp transcription", () => {
  it(
    `transcribes public-domain speech on ${currentPlatform()} with DTW onsets and energy ends`,
    async () => {
      const dataDir = process.env["FRAMESHELL_TEST_DATA_DIR"] ?? tempDir();
      const binaries = new BinaryManager({ dataDir, configDir: tempDir() });
      const project = tempDir();
      writeFileSync(join(project, "frameshell.json"), "{}");
      mkdirSync(join(project, "assets"));
      const wav = Buffer.from(await (await fetch(JFK_URL)).arrayBuffer());
      expect(createHash("sha256").update(wav).digest("hex")).toBe(JFK_SHA256);
      writeFileSync(join(project, "assets", "jfk.wav"), wav);

      const log: string[] = [];
      const started = Date.now();
      const result = await transcribeAsset({
        projectDir: project,
        asset: join(project, "assets", "jfk.wav"),
        providerId: "whisper-cpp",
        provider: createWhisperProvider(),
        language: "en",
        tools: {
          ensureBinary: (name, onProgress) => binaries.ensure(name, undefined, { onProgress }),
          ensureModel: (id, onProgress) => binaries.ensureModel(id, { onProgress }),
        },
        // Already 16 kHz mono PCM: no ffmpeg needed.
        extractAudio: async (input, output) => writeFileSync(output, readFileSync(input)),
        progress: ({ message, fraction }) => {
          const line = `${((Date.now() - started) / 1000).toFixed(1)}s ${message}${fraction === undefined ? "" : ` ${Math.round(fraction * 100)}%`}`;
          if (log.at(-1)?.replace(/^\S+ /, "") !== line.replace(/^\S+ /, "")) log.push(line);
        },
      });
      console.log(`${log.filter((line) => !/%$/.test(line) || /100%$/.test(line)).join("\n")}\n${JSON.stringify(result, null, 2)}`);

      const transcript = JSON.parse(readFileSync(join(project, result.transcript), "utf8"));
      const text = transcript.words.map((w: { text: string }) => w.text).join(" ").toLowerCase();
      expect(text).toContain("ask not what your country can do for you");
      const starts = transcript.words.map((w: { start: number }) => w.start);
      expect(starts).toEqual([...starts].sort((a, b) => a - b));
      for (const word of transcript.words) expect(word.end).toBeGreaterThanOrEqual(word.start);
      // "ask" follows the long pause after "Americans,": DTW puts it at 3.78 s with v1.9.4 q5_0.
      const ask = transcript.words.find((w: { text: string }) => w.text.toLowerCase().startsWith("ask"));
      expect(ask.start).toBeGreaterThan(3.3);
      expect(ask.start).toBeLessThan(4.3);
      if (process.platform === "darwin") expect(result.device).toBe("metal");
    },
    1_800_000,
  );
});
