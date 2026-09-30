import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { TranscriptWord, TranscriptionProvider } from "@frameshell/plugin-api";
import { ErrorCode, RpcError } from "@frameshell/protocol";
import { parseTranscript } from "@frameshell/schema";
import { type AudioExtractor, type TranscriberTools, transcribeAsset } from "../src/index.js";
import { tempDir } from "./helpers.js";

/** sha256("hello"): independent known value. */
const HELLO_SHA256 = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";

function project(): string {
  const dir = tempDir();
  writeFileSync(join(dir, "frameshell.json"), "{}");
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "assets", "raw-01.mp4"), "hello");
  return dir;
}

/** Provider replaying `words`; records the audio file and options it got. */
function fakeProvider(words: TranscriptWord[], extra: { device?: string } = {}) {
  const calls: { audio: string; audioBytes: string; options: unknown }[] = [];
  const provider: TranscriptionProvider = {
    id: "fake",
    async transcribe(audio, options, context) {
      calls.push({ audio, audioBytes: readFileSync(audio, "utf8"), options });
      context.progress({ message: "Transcribing", fraction: 0.5 });
      return { model: options.model ?? "fake-default", language: options.language ?? "es", words, ...extra };
    },
  };
  return { provider, calls };
}

/** Extractor stand-in: "decodes" by prefixing the source bytes, so tests see which file was used. */
const fakeExtract: AudioExtractor = async (input, output) => {
  writeFileSync(output, `wav-of:${readFileSync(input, "utf8")}`);
};

const noTools: TranscriberTools = {
  ensureBinary: async (name) => `/bin/${name}`,
  ensureModel: async (id) => `/models/${id}`,
};

const words = (...list: [string, number, number][]): TranscriptWord[] =>
  list.map(([text, start, end]) => ({ text, start, end, confidence: 0.9 }));

function run(dir: string, provider: TranscriptionProvider, extra: Partial<Parameters<typeof transcribeAsset>[0]> = {}) {
  return transcribeAsset({
    projectDir: dir,
    asset: join(dir, "assets", "raw-01.mp4"),
    providerId: provider.id,
    provider,
    tools: noTools,
    extractAudio: fakeExtract,
    ...extra,
  });
}

const readTranscript = (dir: string) => JSON.parse(readFileSync(join(dir, "transcripts", "raw-01.words.json"), "utf8"));

describe("transcribeAsset", () => {
  it("writes transcripts/<asset>.words.json in the core schema with hash, provider, model and word ids", async () => {
    const dir = project();
    const { provider } = fakeProvider(words(["Hola", 0.5204, 0.81], ["a", 0.81, 0.88]));
    const result = await run(dir, provider, { model: "m1", language: "es" });

    const file = readTranscript(dir);
    expect(parseTranscript(file).ok).toBe(true);
    expect(file).toMatchObject({
      schemaVersion: 1,
      asset: "assets/raw-01.mp4",
      assetHash: `sha256:${HELLO_SHA256}`,
      provider: "fake",
      model: "m1",
      language: "es",
      words: [
        { id: "w_000001", text: "Hola", start: 0.52, end: 0.81, confidence: 0.9 },
        { id: "w_000002", text: "a", start: 0.81, end: 0.88 },
      ],
      edits: {},
      nextWordId: 3,
    });
    expect(result).toMatchObject({
      transcript: "transcripts/raw-01.words.json",
      asset: "assets/raw-01.mp4",
      audioSource: "assets/raw-01.mp4",
      words: 2,
      reusedIds: 0,
      keptEdits: 0,
      droppedEdits: [],
    });
  });

  it("feeds the provider audio extracted from the CFR proxy when one exists", async () => {
    const dir = project();
    mkdirSync(join(dir, ".frameshell", "proxies", "assets"), { recursive: true });
    writeFileSync(join(dir, ".frameshell", "proxies", "assets", "raw-01.mp4"), "proxy-bytes");
    const fake = fakeProvider([]);
    const result = await run(dir, fake.provider);
    expect(fake.calls[0]!.audioBytes).toBe("wav-of:proxy-bytes");
    expect(result.audioSource).toBe(".frameshell/proxies/assets/raw-01.mp4");
  });

  it("extracts audio once per asset version and reuses it", async () => {
    const dir = project();
    let extractions = 0;
    const counting: AudioExtractor = async (input, output, ffmpeg) => {
      extractions++;
      await fakeExtract(input, output, ffmpeg);
    };
    await run(dir, fakeProvider([]).provider, { extractAudio: counting });
    await run(dir, fakeProvider([]).provider, { extractAudio: counting });
    expect(extractions).toBe(1);
  });

  it("re-transcribing keeps ids and human edits of words found again, and never reuses a dropped id", async () => {
    const dir = project();
    await run(dir, fakeProvider(words(["Hola", 0.5, 0.8], ["mundo", 0.9, 1.3], ["cruel", 1.4, 1.8])).provider);
    const first = readTranscript(dir);
    // The human corrects two words.
    writeFileSync(
      join(dir, "transcripts", "raw-01.words.json"),
      JSON.stringify({ ...first, edits: { w_000001: { text: "Hola," }, w_000003: { text: "cruel!" } } }),
    );

    // New run: "Hola" moved 0.2 s and changed case, "mundo" identical, "cruel" gone, "bonito" new.
    const result = await run(dir, fakeProvider(words(["hola", 0.7, 0.8], ["mundo", 0.9, 1.3], ["bonito", 1.4, 1.9])).provider);
    const second = readTranscript(dir);
    expect(second.words.map((w: { id: string; text: string }) => [w.id, w.text])).toEqual([
      ["w_000001", "hola"],
      ["w_000002", "mundo"],
      ["w_000004", "bonito"],
    ]);
    expect(second.edits).toEqual({ w_000001: { text: "Hola," } });
    expect(result).toMatchObject({ reusedIds: 2, keptEdits: 1, droppedEdits: ["w_000003"] });
  });

  it("never hands out an id dropped by an earlier run, across any number of runs", async () => {
    const dir = project();
    await run(dir, fakeProvider(words(["hola", 0.5, 0.8], ["mundo", 0.9, 1.3])).provider);
    const first = readTranscript(dir);
    writeFileSync(join(dir, "transcripts", "raw-01.words.json"), JSON.stringify({ ...first, edits: { w_000002: { text: "Mundo" } } }));

    // Run 2 loses "mundo": w_000002 and its edit are gone from the file.
    const second = await run(dir, fakeProvider(words(["hola", 0.5, 0.8])).provider);
    expect(second.droppedEdits).toEqual(["w_000002"]);
    expect(readTranscript(dir)).toMatchObject({ words: [{ id: "w_000001" }], edits: {}, nextWordId: 3 });

    // Run 3 finds a new word: it must not become w_000002, which agents may still hold for "mundo".
    await run(dir, fakeProvider(words(["hola", 0.5, 0.8], ["gente", 0.9, 1.3])).provider);
    const third = readTranscript(dir);
    expect(third.words.map((w: { id: string; text: string }) => [w.id, w.text])).toEqual([
      ["w_000001", "hola"],
      ["w_000003", "gente"],
    ]);
    expect(third.nextWordId).toBe(4);
    expect(parseTranscript(third).ok).toBe(true);
  });

  it("starts new ids above every word and edit id of a transcript without nextWordId", async () => {
    const dir = project();
    await run(dir, fakeProvider(words(["hola", 0.5, 0.8])).provider);
    const { nextWordId: _omit, ...handWritten } = readTranscript(dir);
    writeFileSync(
      join(dir, "transcripts", "raw-01.words.json"),
      JSON.stringify({ ...handWritten, edits: { w_000007: { text: "stale" } } }),
    );
    await run(dir, fakeProvider(words(["hola", 0.5, 0.8], ["gente", 0.9, 1.3])).provider);
    expect(readTranscript(dir)).toMatchObject({
      words: [{ id: "w_000001" }, { id: "w_000008", text: "gente" }],
      nextWordId: 9,
    });
  });

  it("does not match a word that moved more than half a second", async () => {
    const dir = project();
    await run(dir, fakeProvider(words(["Hola", 0.5, 0.8])).provider);
    await run(dir, fakeProvider(words(["Hola", 1.2, 1.5])).provider);
    expect(readTranscript(dir).words[0].id).toBe("w_000002");
  });

  it("refuses to overwrite a broken transcript before doing any work", async () => {
    const dir = project();
    mkdirSync(join(dir, "transcripts"));
    writeFileSync(join(dir, "transcripts", "raw-01.words.json"), "{ not json");
    const fake = fakeProvider([]);
    await expect(run(dir, fake.provider)).rejects.toMatchObject({ code: ErrorCode.InvalidProjectFile });
    expect(fake.calls).toEqual([]);
  });

  it("passes model, language, progress and the host's tools through to the provider", async () => {
    const dir = project();
    const asked: string[] = [];
    const tools: TranscriberTools = {
      ensureBinary: async (name, onProgress) => {
        onProgress({ message: `installing ${name}` });
        asked.push(name);
        return `/bin/${name}`;
      },
      ensureModel: async (id) => {
        asked.push(id);
        return `/models/${id}`;
      },
    };
    const provider: TranscriptionProvider = {
      id: "fake",
      async transcribe(_audio, options, context) {
        expect(options).toEqual({ model: "big", language: "en" });
        expect(await context.ensureBinary("whisper-cli")).toBe("/bin/whisper-cli");
        expect(await context.ensureModel("ggml-big")).toBe("/models/ggml-big");
        context.progress({ message: "halfway", fraction: 0.5 });
        return { model: "big", words: [], device: "metal" };
      },
    };
    const progress: unknown[] = [];
    const result = await run(dir, provider, { tools, model: "big", language: "en", progress: (p) => progress.push(p) });
    expect(asked).toEqual(["whisper-cli", "ggml-big"]);
    expect(progress).toEqual(expect.arrayContaining([{ message: "installing whisper-cli" }, { message: "halfway", fraction: 0.5 }]));
    expect(result).toMatchObject({ device: "metal", language: null });
  });

  it("wraps provider errors as TranscriptionFailed and lets binary errors through unchanged", async () => {
    const dir = project();
    const failing = (error: Error): TranscriptionProvider => ({
      id: "fake",
      transcribe: async () => {
        throw error;
      },
    });
    await expect(run(dir, failing(new Error("engine exploded")))).rejects.toMatchObject({
      code: ErrorCode.TranscriptionFailed,
      message: expect.stringMatching(/raw-01\.mp4.*fake.*engine exploded/),
    });
    const binary = new RpcError(ErrorCode.BinaryInstallFailed, "download failed");
    await expect(run(dir, failing(binary))).rejects.toBe(binary);
    expect(existsSync(join(dir, "transcripts", "raw-01.words.json"))).toBe(false);
  });

  it("rejects words the transcript format cannot hold", async () => {
    const dir = project();
    await expect(run(dir, fakeProvider(words(["x", Number.NaN, 1])).provider)).rejects.toMatchObject({
      code: ErrorCode.TranscriptionFailed,
    });
  });

  it("rejects missing assets and files outside the project", async () => {
    const dir = project();
    const { provider } = fakeProvider([]);
    await expect(run(dir, provider, { asset: join(dir, "assets", "nope.mp4") })).rejects.toMatchObject({ code: ErrorCode.AssetNotFound });
    const outside = join(tempDir(), "x.mp4");
    writeFileSync(outside, "x");
    await expect(run(dir, provider, { asset: outside })).rejects.toMatchObject({ code: ErrorCode.OutsideProject });
  });

  it("never overwrites the transcript of a same-name asset: keeps the extension instead", async () => {
    const dir = project();
    writeFileSync(join(dir, "assets", "raw-01.wav"), "recorder track");
    await run(dir, fakeProvider(words(["hola", 0.5, 0.8])).provider);
    const video = readTranscript(dir);
    const edited = { ...video, edits: { w_000001: { text: "Hola," } } };
    writeFileSync(join(dir, "transcripts", "raw-01.words.json"), JSON.stringify(edited));

    // Same speech, same times: without the ownership check, the video's edit would land on the recorder's words.
    const wav = await run(dir, fakeProvider(words(["hola", 0.5, 0.8])).provider, { asset: join(dir, "assets", "raw-01.wav") });
    expect(wav).toMatchObject({ transcript: "transcripts/raw-01.wav.words.json", reusedIds: 0, keptEdits: 0 });
    const recorder = JSON.parse(readFileSync(join(dir, "transcripts", "raw-01.wav.words.json"), "utf8"));
    expect(recorder).toMatchObject({ asset: "assets/raw-01.wav", edits: {} });
    expect(readTranscript(dir)).toEqual(edited);

    // Each asset keeps finding its own file on re-transcription.
    const again = await run(dir, fakeProvider(words(["hola", 0.5, 0.8])).provider);
    expect(again).toMatchObject({ transcript: "transcripts/raw-01.words.json", keptEdits: 1 });
    const wavAgain = await run(dir, fakeProvider([]).provider, { asset: join(dir, "assets", "raw-01.wav") });
    expect(wavAgain.transcript).toBe("transcripts/raw-01.wav.words.json");
  });

  it("refuses before any work when every transcript name belongs to another asset", async () => {
    const dir = project();
    writeFileSync(join(dir, "assets", "raw-01.wav"), "recorder track");
    await run(dir, fakeProvider([]).provider);
    // A hand-made transcript for a third asset sits on the fallback name.
    const other = { ...readTranscript(dir), asset: "assets/elsewhere.wav" };
    writeFileSync(join(dir, "transcripts", "raw-01.wav.words.json"), JSON.stringify(other));

    const fake = fakeProvider([]);
    await expect(run(dir, fake.provider, { asset: join(dir, "assets", "raw-01.wav") })).rejects.toMatchObject({
      code: ErrorCode.TranscriptNameTaken,
      data: {
        asset: "assets/raw-01.wav",
        transcripts: [
          { path: "transcripts/raw-01.words.json", asset: "assets/raw-01.mp4" },
          { path: "transcripts/raw-01.wav.words.json", asset: "assets/elsewhere.wav" },
        ],
      },
    });
    expect(fake.calls).toEqual([]);
    expect(JSON.parse(readFileSync(join(dir, "transcripts", "raw-01.wav.words.json"), "utf8"))).toEqual(other);
  });

  it("does not overwrite a transcript another asset wrote under the same name while the engine ran", async () => {
    const dir = project();
    const intruder: TranscriptionProvider = {
      id: "fake",
      async transcribe() {
        await run(dir, fakeProvider(words(["other", 0, 1])).provider, { asset: join(dir, "assets", "raw-01.wav") });
        return { model: "m", words: words(["hola", 0.5, 0.8]) };
      },
    };
    writeFileSync(join(dir, "assets", "raw-01.wav"), "recorder track");
    await expect(run(dir, intruder)).rejects.toMatchObject({ code: ErrorCode.TranscriptNameTaken });
    expect(readTranscript(dir)).toMatchObject({ asset: "assets/raw-01.wav", words: [{ text: "other" }] });
  });

  it("does not take audio from the proxy when a same-name sibling could own it", async () => {
    const dir = project();
    writeFileSync(join(dir, "assets", "raw-01.wav"), "recorder track");
    mkdirSync(join(dir, ".frameshell", "proxies", "assets"), { recursive: true });
    writeFileSync(join(dir, ".frameshell", "proxies", "assets", "raw-01.mp4"), "proxy-bytes");
    const fake = fakeProvider([]);
    const result = await run(dir, fake.provider, { asset: join(dir, "assets", "raw-01.wav") });
    expect(fake.calls[0]!.audioBytes).toBe("wav-of:recorder track");
    expect(result.audioSource).toBe("assets/raw-01.wav");
  });

  it("names transcripts after the asset path under assets/", async () => {
    const dir = project();
    mkdirSync(join(dir, "assets", "day1"));
    copyFileSync(join(dir, "assets", "raw-01.mp4"), join(dir, "assets", "day1", "take.mov"));
    const result = await run(dir, fakeProvider([]).provider, { asset: join(dir, "assets", "day1", "take.mov") });
    expect(result.transcript).toBe("transcripts/day1/take.words.json");
  });
});
