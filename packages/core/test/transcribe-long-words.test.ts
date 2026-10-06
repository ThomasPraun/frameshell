import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { TranscriptWord, TranscriptionProvider } from "@frameshell/plugin-api";
import { methods } from "@frameshell/protocol";
import { parseTranscript } from "@frameshell/schema";
import { type AudioExtractor, type TranscriberTools, transcribeAsset } from "../src/index.js";
import { tempDir } from "./helpers.js";
import { toneWav } from "./whisper-fixture.js";

/**
 * #117: a retake whisper swallowed. Speech (tone) at 0.5-1.4 ("Hola"),
 * 2.0-2.5 ("incluido."), 3.0-4.0 and 4.5-6.0 (the swallowed "Aquella semana,
 * otra vez."), 7.0-7.5 ("Fin"). The full pass hears "incluido." spanning
 * 2.0-6.5.
 */
const SPEECH: [number, number][] = [
  [0.5, 1.4],
  [2.0, 2.5],
  [3.0, 4.0],
  [4.5, 6.0],
  [7.0, 7.5],
];

const words = (...list: [string, number, number][]): TranscriptWord[] =>
  list.map(([text, start, end]) => ({ text, start, end, confidence: 0.9 }));

const FULL = words(["Hola", 0.5, 1.4], ["incluido.", 2.0, 6.5], ["Fin", 7.0, 7.5]);

/** What a window re-transcription hears, on the asset clock. */
const WINDOW = words(["incluido.", 2.0, 2.5], ["Aquella", 3.0, 3.4], ["semana,", 3.5, 4.0], ["otra", 4.5, 5.0], ["vez.", 5.1, 6.0]);

function project(bursts: [number, number][] = SPEECH): { dir: string; extract: AudioExtractor } {
  const dir = tempDir();
  writeFileSync(join(dir, "frameshell.json"), "{}");
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "assets", "take.mp4"), "take");
  const extract: AudioExtractor = async (_input, output) => writeFileSync(output, toneWav(8, bursts));
  return { dir, extract };
}

/**
 * First call: the full pass. Later calls: a window, whose start the provider
 * reads from its length (windows end with the audio or at a known span) and
 * answers `window` words inside it, relative to the window start.
 */
function fakeProvider(full: TranscriptWord[], window: TranscriptWord[], windowFrom: () => number) {
  const calls: { audio: string; seconds: number }[] = [];
  const provider: TranscriptionProvider = {
    id: "fake",
    async transcribe(audio) {
      const seconds = (readFileSync(audio).length - 44) / 2 / 16_000;
      calls.push({ audio, seconds });
      if (calls.length === 1) return { model: "fake", language: "es", words: full };
      const from = windowFrom();
      return {
        model: "fake",
        language: "es",
        words: window.filter((word) => word.start >= from && word.start < from + seconds).map((word) => ({ ...word, start: word.start - from, end: word.end - from })),
      };
    },
  };
  return { provider, calls };
}

const noTools: TranscriberTools = {
  ensureBinary: async (name) => `/bin/${name}`,
  ensureModel: async (id) => `/models/${id}`,
};

function run(dir: string, extract: AudioExtractor, provider: TranscriptionProvider) {
  return transcribeAsset({ projectDir: dir, asset: join(dir, "assets", "take.mp4"), providerId: "fake", provider, tools: noTools, extractAudio: extract });
}

const readTranscript = (dir: string) => JSON.parse(readFileSync(join(dir, "transcripts", "take.words.json"), "utf8"));

describe("transcribeAsset: long words (#117)", () => {
  it("re-transcribes a long word with speech inside alone and splices in the words it hid", async () => {
    const { dir, extract } = project();
    // Window = the word's span with 0.3 s each side: 1.7-6.8.
    const { provider, calls } = fakeProvider(FULL, WINDOW, () => 1.7);
    const result = await run(dir, extract, provider);

    expect(calls.map((call) => call.seconds)).toEqual([8, expect.closeTo(5.1, 3)]);
    const file = readTranscript(dir);
    expect(parseTranscript(file).ok).toBe(true);
    expect(file.words.map((word: { text: string; start: number; end: number }) => [word.text, word.start, word.end])).toEqual([
      ["Hola", 0.5, 1.4],
      ["incluido.", 2, 2.5],
      ["Aquella", 3, 3.4],
      ["semana,", 3.5, 4],
      ["otra", 4.5, 5],
      ["vez.", 5.1, 6],
      ["Fin", 7, 7.5],
    ]);
    expect(file.words.every((word: object) => !("speechInside" in word))).toBe(true);
    expect(result).toMatchObject({ words: 7, recoveredWords: 4, speechInside: [] });
    expect(methods.transcribe.result.parse(result)).toEqual(result);
    expect(readdirSync(join(dir, ".frameshell", "cache", "transcribe"))).toEqual([]);
  });

  it("keeps the ids of recovered words when transcribing again", async () => {
    const { dir, extract } = project();
    await run(dir, extract, fakeProvider(FULL, WINDOW, () => 1.7).provider);
    const first = readTranscript(dir).words.map((word: { id: string }) => word.id);
    const again = await run(dir, extract, fakeProvider(FULL, WINDOW, () => 1.7).provider);
    expect(readTranscript(dir).words.map((word: { id: string }) => word.id)).toEqual(first);
    expect(again.reusedIds).toBe(7);
  });

  it("flags a long word with speech inside that its window cannot split", async () => {
    const { dir, extract } = project();
    const { provider, calls } = fakeProvider(FULL, words(["incluido.", 2.0, 6.5]), () => 1.7);
    const result = await run(dir, extract, provider);
    expect(calls).toHaveLength(2);
    const file = readTranscript(dir);
    expect(file.words[1]).toMatchObject({ text: "incluido.", start: 2, end: 6.5, speechInside: true });
    expect(file.words.filter((word: { speechInside?: boolean }) => word.speechInside)).toHaveLength(1);
    expect(result).toMatchObject({ recoveredWords: 0, speechInside: [file.words[1].id] });
  });

  it("leaves a long word alone when silence fills it: that is a pause, not hidden words", async () => {
    const { dir, extract } = project([
      [0.5, 1.4],
      [2.0, 2.5],
      [7.0, 7.5],
    ]);
    const { provider, calls } = fakeProvider(FULL, WINDOW, () => 1.7);
    const result = await run(dir, extract, provider);
    expect(calls).toHaveLength(1);
    expect(readTranscript(dir).words[1]).toEqual({ id: "w_000002", text: "incluido.", start: 2, end: 6.5, confidence: 0.9 });
    expect(result).toMatchObject({ recoveredWords: 0, speechInside: [] });
  });

  it("drops the previous word's tail heard at the start of the window", async () => {
    const { dir, extract } = project();
    // Window time 0 (1.7) catches the end of "Hola": whisper names it again.
    const { provider } = fakeProvider(FULL, [...words(["hola", 1.7, 2.05]), ...WINDOW], () => 1.7);
    const result = await run(dir, extract, provider);
    expect(readTranscript(dir).words.map((word: { text: string }) => word.text)).toEqual(["Hola", "incluido.", "Aquella", "semana,", "otra", "vez.", "Fin"]);
    expect(result).toMatchObject({ recoveredWords: 4 });
  });

  it("drops the next word heard inside the span before its lagging onset", async () => {
    const { dir, extract } = project();
    // "Fin" really starts at 6.3; the full pass put its onset at 7.0.
    const { provider } = fakeProvider(FULL, [...WINDOW, ...words(["Fin", 6.3, 6.6])], () => 1.7);
    const result = await run(dir, extract, provider);
    expect(readTranscript(dir).words.map((word: { text: string }) => word.text)).toEqual(["Hola", "incluido.", "Aquella", "semana,", "otra", "vez.", "Fin"]);
    expect(result).toMatchObject({ words: 7, recoveredWords: 4 });
  });

  it("does not count a window that only repeats neighbours as a recovery", async () => {
    const { dir, extract } = project();
    const { provider } = fakeProvider(FULL, words(["Hola", 1.7, 2.05], ["incluido.", 2.0, 6.5], ["Fin", 6.3, 6.6]), () => 1.7);
    const result = await run(dir, extract, provider);
    expect(readTranscript(dir).words.map((word: { text: string }) => word.text)).toEqual(["Hola", "incluido.", "Fin"]);
    expect(result).toMatchObject({ recoveredWords: 0, speechInside: [readTranscript(dir).words[1].id] });
  });

  it("re-transcribes adjacent long words in one window and recovers words in the gap between them", async () => {
    // #117's real shape: `incluido.` then `La`, the swallowed phrase running across the gap.
    const { dir, extract } = project([
      [0.5, 1.4],
      [2.0, 2.5],
      [3.0, 4.0],
      [4.3, 6.4],
      [7.0, 7.5],
    ]);
    const full = words(["Hola", 0.5, 1.4], ["incluido.", 2.0, 4.2], ["La", 4.9, 6.6], ["Fin", 7.0, 7.5]);
    const window = words(
      ["incluido.", 2.0, 2.5],
      ["Aquella", 3.0, 3.4],
      ["semana,", 3.5, 4.0],
      ["otra", 4.3, 4.6],
      ["vez.", 4.65, 4.85],
      ["La", 4.9, 5.2],
      ["misma.", 5.3, 6.4],
    );
    // One window over both words and the gap: 1.7-6.9.
    const { provider, calls } = fakeProvider(full, window, () => 1.7);
    const result = await run(dir, extract, provider);
    expect(calls.map((call) => call.seconds)).toEqual([8, expect.closeTo(5.2, 3)]);
    expect(readTranscript(dir).words.map((word: { text: string }) => word.text)).toEqual([
      "Hola",
      "incluido.",
      "Aquella",
      "semana,",
      "otra",
      "vez.",
      "La",
      "misma.",
      "Fin",
    ]);
    expect(result).toMatchObject({ words: 9, recoveredWords: 5, speechInside: [] });
  });

  it("does not read the audio when no word is long", async () => {
    const { dir } = project();
    // Not a WAV: reading it would find nothing; the run must not need it.
    const extract: AudioExtractor = async (_input, output) => writeFileSync(output, "not a wav");
    const { provider, calls } = fakeProvider(words(["Hola", 0.5, 1.4]), [], () => 0);
    const result = await run(dir, extract, provider);
    expect(calls).toHaveLength(1);
    expect(result).toMatchObject({ words: 1, recoveredWords: 0, speechInside: [] });
    expect(existsSync(join(dir, ".frameshell", "cache", "transcribe"))).toBe(false);
  });
});
