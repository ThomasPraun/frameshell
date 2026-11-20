import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { TranscriptWord, TranscriptionProvider } from "@frameshell/plugin-api";
import { ErrorCode, RpcError } from "@frameshell/protocol";
import { type AudioExtractor, type LocalTiming, alignTokens, textWords, timeText, transcribeAsset } from "../src/index.js";
import { tempDir } from "./helpers.js";
import { toneWav } from "./whisper-fixture.js";

// ADR 0046 decision 11: a text-only cloud model gives the spelling, whisper.cpp on this machine gives the times.

const words = (...list: [string, number, number][]): TranscriptWord[] => list.map(([text, start, end]) => ({ text, start, end }));
const times = (laid: { words: { text: string; start: number; end: number }[] }) => laid.words.map((w) => [w.text, w.start, w.end]);

describe("timeText", () => {
  it("gives each word of the text the times of the timed word it matches, keeping the text's spelling", () => {
    const local = words(["hola", 0.5, 0.9], ["jimena", 1.0, 1.6], ["que", 1.8, 2.0], ["tal", 2.0, 2.3]);
    const laid = timeText("¡Hola, Ximena! ¿Qué tal?", local, 3);
    expect(times(laid)).toEqual([
      ["¡Hola,", 0.5, 0.9],
      ["Ximena!", 1.0, 1.6],
      ["¿Qué", 1.8, 2.0],
      ["tal?", 2.0, 2.3],
    ]);
    expect(laid.matched).toBe(4);
    expect(laid.words.map((w) => w.from)).toEqual([[0], [1], [2], [3]]);
  });

  it("spreads words that match nothing over the timed words between their neighbours, by length", () => {
    const local = words(["tengo", 0, 0.5], ["veinte", 0.6, 1.0], ["años", 1.1, 1.5]);
    const laid = timeText("Tengo 20 años.", local, 2);
    expect(times(laid)).toEqual([
      ["Tengo", 0, 0.5],
      ["20", 0.6, 1.0],
      ["años.", 1.1, 1.5],
    ]);
    expect(laid.matched).toBe(2);
  });

  it("shares a matched word's time when the text splits what whisper.cpp heard as one word", () => {
    const laid = timeText("I can not go", words(["I", 0, 0.2], ["can", 0.3, 0.7], ["go", 0.8, 1.0]), 1);
    expect(times(laid)).toEqual([
      ["I", 0, 0.2],
      ["can", 0.3, 0.5],
      ["not", 0.5, 0.7],
      ["go", 0.8, 1.0],
    ]);
  });

  it("spreads the whole text over the audio when whisper.cpp heard nothing, and never goes back in time", () => {
    expect(times(timeText("uno dos", [], 4))).toEqual([
      ["uno", 0, 2],
      ["dos", 2, 4],
    ]);
    expect(timeText("", words(["hola", 0, 1]), 1).words).toEqual([]);
  });

  it("joins tokens without letters to a neighbour", () => {
    expect(textWords("Bueno — ya ¿ves ? « sí »")).toEqual(["Bueno—", "ya", "¿ves?", "«sí»"]);
  });

  it("aligns long lists inside its band, in order", () => {
    const a = Array.from({ length: 5000 }, (_, k) => `w${k % 97}x${Math.floor(k / 97)}`);
    const b = a.filter((_, k) => k % 10 !== 3);
    const pairs = alignTokens(a, b);
    expect(pairs).toHaveLength(b.length);
    expect(pairs.every(([i, j]) => a[i] === b[j])).toBe(true);
  });
});

describe("transcribeAsset with a text-only model", () => {
  function project(): { dir: string; extract: AudioExtractor } {
    const dir = tempDir();
    writeFileSync(join(dir, "frameshell.json"), "{}");
    mkdirSync(join(dir, "assets"));
    writeFileSync(join(dir, "assets", "talk.mp4"), "talk");
    return { dir, extract: async (_input, output) => writeFileSync(output, toneWav(3, [[0.2, 2.5]])) };
  }

  function cloud() {
    const calls: { timesText: boolean | undefined; model: string | undefined }[] = [];
    const provider: TranscriptionProvider = {
      id: "cloud",
      remote: true,
      defaultModel: "texter",
      models: [{ id: "texter", textOnly: true }, { id: "timed" }],
      estimate: ({ seconds }) => ({ cost: seconds * 0.01, currency: "USD" }),
      async transcribe(_audio, options, context) {
        calls.push({ timesText: context.timesText, model: options.model });
        return { model: options.model ?? "texter", language: "es", words: [], text: "Hola, Ximena. Tengo 20 años." };
      },
    };
    return { provider, calls };
  }

  function local() {
    const calls: { model: string | undefined; language: string | undefined }[] = [];
    const provider: TranscriptionProvider = {
      id: "whisper-cpp",
      free: true,
      async transcribe(_audio, options) {
        calls.push({ model: options.model, language: options.language });
        return {
          model: options.model ?? "base",
          device: "cpu",
          words: words(["hola", 0.2, 0.5], ["jimena", 0.6, 1.0], ["tengo", 1.2, 1.5], ["veinte", 1.6, 2.0], ["años", 2.1, 2.4]),
        };
      },
    };
    return { provider, calls };
  }

  const run = (dir: string, extract: AudioExtractor, provider: TranscriptionProvider, extra: Record<string, unknown> = {}) =>
    transcribeAsset({
      projectDir: dir,
      asset: join(dir, "assets", "talk.mp4"),
      providerId: "cloud",
      provider,
      tools: { ensureBinary: async (name) => `/bin/${name}`, ensureModel: async (id) => `/models/${id}` },
      extractAudio: extract,
      language: "es",
      ...extra,
    });

  it("asks once naming the local timing, runs whisper.cpp first, then lays the cloud text over its times", async () => {
    const { dir, extract } = project();
    const { provider, calls } = cloud();
    const engine = local();
    const localTiming = async (): Promise<LocalTiming> => ({ provider: engine.provider, providerId: "whisper-cpp", model: "base" });
    const refused = await run(dir, extract, provider, { localTiming }).then(() => null, (e: unknown) => e as RpcError);
    expect(refused!.code).toBe(ErrorCode.ConfirmationRequired);
    expect(refused!.message).toMatch(/costs about 0\.0300 USD\. whisper-cpp times its words on this machine first\./);
    expect(refused!.message).not.toMatch(/re-checks/);
    expect(calls).toEqual([]);
    expect(engine.calls).toEqual([]);

    const result = await run(dir, extract, provider, { localTiming, yes: true });
    expect(engine.calls).toEqual([{ model: "base", language: "es" }]);
    expect(calls).toEqual([{ timesText: true, model: undefined }]);
    expect(result).toMatchObject({ provider: "cloud", model: "texter", language: "es", device: "cpu", words: 5, recoveredWords: 0 });
    expect(result.warnings.join(" ")).toMatch(/Word times come from whisper-cpp \(base\) on this machine, spelling from cloud: 4 of 5 words matched/);
    const transcript = JSON.parse(readFileSync(join(dir, "transcripts", "talk.words.json"), "utf8"));
    expect(transcript.words.map((w: TranscriptWord) => [w.text, w.start, w.end])).toEqual([
      ["Hola,", 0.2, 0.5],
      ["Ximena.", 0.6, 1.0],
      ["Tengo", 1.2, 1.5],
      ["20", 1.6, 2.0],
      ["años.", 2.1, 2.4],
    ]);
    expect(transcript.model).toBe("texter");
  });

  it("fails before the ask and before any upload when the local timing cannot load", async () => {
    const { dir, extract } = project();
    const { provider, calls } = cloud();
    const error = await run(dir, extract, provider, { yes: true, localTiming: async () => Promise.reject(new Error("no whisper here")) }).then(
      () => null,
      (e: unknown) => e as RpcError,
    );
    expect(error!.code).toBe(ErrorCode.TranscriptionFailed);
    expect(error!.message).toMatch(/texter gives no word times, which whisper\.cpp adds on this machine, and it could not load: no whisper here/);
    const without = await run(dir, extract, provider, { yes: true }).then(() => null, (e: unknown) => e as RpcError);
    expect(without!.message).toMatch(/this host cannot run it here/);
    expect(calls).toEqual([]);
  });

  it("transcribes a timed model of the same provider as before, without the local engine", async () => {
    const { dir, extract } = project();
    const engine = local();
    const provider: TranscriptionProvider = {
      ...cloud().provider,
      async transcribe(_audio, options) {
        return { model: options.model ?? "?", words: words(["Hola", 0.2, 0.5]) };
      },
    };
    const result = await run(dir, extract, provider, { yes: true, model: "timed", localTiming: async () => ({ provider: engine.provider, providerId: "whisper-cpp" }) });
    expect(result).toMatchObject({ model: "timed", words: 1 });
    expect(engine.calls).toEqual([]);
  });
});
