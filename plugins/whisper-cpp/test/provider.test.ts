import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { TranscribeContext, TranscriptionProgress } from "@frameshell/plugin-api";
import { type RunEngine, createWhisperProvider } from "../src/index.js";
import { toneBursts, writeWav } from "./wav.js";

const REAL_OUTPUT = readFileSync(new URL("./fixtures/jfk-whisper-1.9.4.json", import.meta.url), "utf8");

function tempDir(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "frameshell-whisper-test-")));
}

/** Segment of `-ml 1 -sow -ojf` output: one word, DTW onset in centiseconds (-1 = none). */
function segment(text: string, fromMs: number, toMs: number, dtwCs: number, p = 0.9) {
  return {
    text,
    offsets: { from: fromMs, to: toMs },
    tokens: [
      { text: "[_BEG_]", p: 0.2, t_dtw: -1 },
      { text, p, t_dtw: dtwCs },
    ],
  };
}

/**
 * Fake engine: records its call, replays `lines` on stderr (a number = pause
 * that many ms), writes `output` where `-of` points.
 */
function fakeEngine(output: unknown, lines: (string | number)[] = []) {
  const calls: { binary: string; args: readonly string[] }[] = [];
  const run: RunEngine = async (binary, args, onLine) => {
    calls.push({ binary, args });
    for (const line of lines) {
      if (typeof line === "number") await new Promise((resolve) => setTimeout(resolve, line));
      else onLine(line);
    }
    const prefix = args[args.indexOf("-of") + 1]!;
    writeFileSync(`${prefix}.json`, typeof output === "string" ? output : JSON.stringify(output));
  };
  return { run, calls };
}

function context() {
  const progress: TranscriptionProgress[] = [];
  const requested: string[] = [];
  const ctx: TranscribeContext = {
    ensureBinary: async (name) => {
      requested.push(`binary:${name}`);
      return `/managed/${name}`;
    },
    ensureModel: async (id) => {
      requested.push(`model:${id}`);
      return `/models/${id}.bin`;
    },
    progress: (update) => progress.push(update),
  };
  return { ctx, progress, requested };
}

/** 2.5 s: "Hola" sounds 0.30–0.80, "mundo" 1.40–1.90, silence around. */
function holaMundoWav(): string {
  const path = join(tempDir(), "audio.wav");
  writeWav(path, toneBursts(2.5, [[0.3, 0.8], [1.4, 1.9]]));
  return path;
}

describe("whisper-cpp provider", () => {
  it("runs whisper-cli with the ADR 0003 flags, the managed binary and the default q5_0 model", async () => {
    const engine = fakeEngine({ transcription: [] });
    const { ctx, requested } = context();
    const audio = holaMundoWav();
    const result = await createWhisperProvider({ runEngine: engine.run }).transcribe(audio, { language: "es" }, ctx);

    expect(requested).toEqual(["binary:whisper-cli", "model:ggml-large-v3-turbo-q5_0"]);
    expect(result).toMatchObject({ model: "large-v3-turbo-q5_0", language: "es", words: [] });
    const [{ binary, args }] = engine.calls as [{ binary: string; args: readonly string[] }];
    expect(binary).toBe("/managed/whisper-cli");
    const flag = (name: string) => args[args.indexOf(name) + 1];
    expect(flag("-m")).toBe("/models/ggml-large-v3-turbo-q5_0.bin");
    expect(flag("-f")).toBe(audio);
    expect(flag("-l")).toBe("es");
    expect(flag("-dtw")).toBe("large.v3.turbo");
    expect(flag("-ml")).toBe("1");
    expect(args).toEqual(expect.arrayContaining(["-nfa", "-sow", "-ojf"]));
    // VAD remaps nothing for DTW at the pinned version: seconds off (ADR 0003).
    expect(args.some((arg) => arg.includes("vad"))).toBe(false);
    expect(args).not.toContain("--prompt");
  });

  it("passes a prompt to --prompt so a window keeps the case and punctuation of the text before it (#123)", async () => {
    const engine = fakeEngine({ transcription: [] });
    await createWhisperProvider({ runEngine: engine.run }).transcribe(holaMundoWav(), { prompt: " Gratis durante la beta, con todo " }, context().ctx);
    await createWhisperProvider({ runEngine: engine.run }).transcribe(holaMundoWav(), { prompt: "  " }, context().ctx);

    const [first, second] = engine.calls as [(typeof engine.calls)[number], (typeof engine.calls)[number]];
    expect(first.args.slice(first.args.indexOf("--prompt"))).toEqual(["--prompt", "Gratis durante la beta, con todo"]);
    expect(second.args).not.toContain("--prompt");
  });

  it("starts words at their DTW onset and ends them where the audio falls silent before the next word", async () => {
    // Onsets lag the sound by 150 ms, as DTW does; token times are deliberately wrong.
    const engine = fakeEngine({
      result: { language: "es" },
      transcription: [segment(" Hola", 0, 1200, 45, 0.97), segment(" mundo.", 1200, 2400, 155, 0.8)],
    });
    const { words } = await createWhisperProvider({ runEngine: engine.run }).transcribe(holaMundoWav(), {}, context().ctx);

    expect(words.map((w) => [w.text, w.start, w.confidence])).toEqual([
      ["Hola", 0.45, 0.97],
      ["mundo.", 1.55, 0.8],
    ]);
    // Sound stops at 0.80 and 1.90; one 10 ms energy frame of slack.
    expect(words[0]!.end).toBeGreaterThanOrEqual(0.8);
    expect(words[0]!.end).toBeLessThanOrEqual(0.82);
    expect(words[1]!.end).toBeGreaterThanOrEqual(1.9);
    expect(words[1]!.end).toBeLessThanOrEqual(1.92);
  });

  it("ends a word at the next onset in connected speech, where no silence separates them", async () => {
    const path = join(tempDir(), "connected.wav");
    writeWav(path, toneBursts(2, [[0.2, 1.5]]));
    const engine = fakeEngine({ transcription: [segment(" uno", 0, 500, 30), segment(" dos", 500, 1000, 90), segment(" tres", 1000, 1500, 120)] });
    const { words } = await createWhisperProvider({ runEngine: engine.run }).transcribe(path, {}, context().ctx);
    expect(words.map((w) => [w.start, w.end])).toEqual([
      [0.3, 0.9],
      [0.9, 1.2],
      [1.2, expect.closeTo(1.5, 1)],
    ]);
  });

  it("keeps a silence inside a long word: only a gap right before the next onset ends a word", async () => {
    // "largo" sounds 0.2–0.6, pauses 0.6–0.8 (a closure), then runs straight into "fin" (onset 2.1) until 2.4.
    const path = join(tempDir(), "closure.wav");
    writeWav(path, toneBursts(3, [[0.2, 0.6], [0.8, 2.4]]));
    const engine = fakeEngine({ transcription: [segment(" largo", 0, 1000, 30), segment(" fin", 1000, 2500, 210)] });
    const { words } = await createWhisperProvider({ runEngine: engine.run }).transcribe(path, {}, context().ctx);
    expect(words[0]!.end).toBe(2.1);
  });

  it("falls back to token times without DTW, keeps starts in order, and skips annotations and special tokens", async () => {
    const engine = fakeEngine({
      transcription: [
        { text: "", offsets: { from: 0, to: 0 }, tokens: [{ text: "[_BEG_]", p: 0.3, t_dtw: -1 }] },
        segment(" [BLANK_AUDIO]", 0, 300, 10),
        segment(" Hola", 300, 800, -1),
        segment(" mundo", 1400, 1900, 20), // DTW onset earlier than the previous start: clamped.
      ],
    });
    const { words } = await createWhisperProvider({ runEngine: engine.run }).transcribe(holaMundoWav(), {}, context().ctx);
    expect(words.map((w) => [w.text, w.start])).toEqual([
      ["Hola", 0.3],
      ["mundo", 0.3],
    ]);
  });

  it("reads real whisper-cli 1.9.4 output: 22 words with DTW onsets", async () => {
    const path = join(tempDir(), "silent.wav");
    writeWav(path, new Int16Array(16_000 * 11));
    const engine = fakeEngine(REAL_OUTPUT);
    const result = await createWhisperProvider({ runEngine: engine.run }).transcribe(path, {}, context().ctx);
    expect(result.language).toBe("en");
    expect(result.words.map((w) => w.text).join(" ")).toBe(
      "And so, my fellow Americans, ask not what your country can do for you, ask what you can do for your country.",
    );
    // t_dtw of "ask" is 378 cs; its token timestamp says 3.29 s.
    expect(result.words[5]).toMatchObject({ text: "ask", start: 3.78 });
  });

  it("reports transcription progress and the device from whisper-cli logs", async () => {
    const engine = fakeEngine({ transcription: [] }, [
      "ggml_metal_library_init: using embedded metal library",
      "ggml_metal_library_compile_all: loaded 20 libraries from embedded data in 0.023 sec (max single = 0.023 sec)",
      "whisper_backend_init_gpu: using MTL0 backend",
      "whisper_print_progress_callback: progress =  50%",
      "whisper_print_progress_callback: progress = 100%",
    ]);
    const { ctx, progress } = context();
    const result = await createWhisperProvider({ runEngine: engine.run }).transcribe(holaMundoWav(), {}, ctx);
    expect(result.device).toBe("metal");
    // Warm shader cache (~20 ms): nothing worth telling the user.
    expect(progress.some((p) => p.message.includes("Metal"))).toBe(false);
    expect(progress.filter((p) => p.fraction !== undefined)).toEqual([
      { message: "Transcribing (metal)", fraction: 0.5 },
      { message: "Transcribing (metal)", fraction: 1 },
    ]);
  });

  it("announces a cold Metal shader compile while it runs, then how long it took", async () => {
    const engine = fakeEngine({ transcription: [] }, [
      "ggml_metal_library_init: using embedded metal library",
      60,
      "ggml_metal_library_compile_all: loaded 20 libraries from embedded data in 14.639 sec (max single = 14.639 sec)",
    ]);
    const { ctx, progress } = context();
    await createWhisperProvider({ runEngine: engine.run, coldShaderNoticeMs: 10 }).transcribe(holaMundoWav(), {}, ctx);
    expect(progress.map((p) => p.message).filter((m) => m.includes("Metal"))).toEqual([
      "Compiling Metal GPU shaders (first run after install only, 15-25 s)",
      "Compiled Metal GPU shaders in 14.6 s (cached from now on)",
    ]);
  });

  it("rejects an unknown model before touching binaries, listing the available ones", async () => {
    const engine = fakeEngine({ transcription: [] });
    const { ctx, requested } = context();
    await expect(createWhisperProvider({ runEngine: engine.run }).transcribe(holaMundoWav(), { model: "tiny" }, ctx)).rejects.toThrow(
      /Unknown whisper\.cpp model "tiny".*large-v3-turbo-q5_0/,
    );
    expect(requested).toEqual([]);
    expect(engine.calls).toEqual([]);
  });

  it("uses the selected model's managed file", async () => {
    const engine = fakeEngine({ transcription: [] });
    const { ctx, requested } = context();
    const result = await createWhisperProvider({ runEngine: engine.run }).transcribe(holaMundoWav(), { model: "large-v3-turbo" }, ctx);
    expect(requested).toContain("model:ggml-large-v3-turbo");
    expect(result.model).toBe("large-v3-turbo");
  });

  it("surfaces engine failures", async () => {
    const run: RunEngine = async () => {
      throw new Error("whisper-cli exited with code 3:\nfailed to open audio");
    };
    await expect(createWhisperProvider({ runEngine: run }).transcribe(holaMundoWav(), {}, context().ctx)).rejects.toThrow(/code 3/);
  });

  it.each([
    ["CUDA0", "cuda"],
    ["Vulkan0", "vulkan"],
  ])("retries once on CPU (-ng) when a run fails after the %s backend started", async (backend, device) => {
    const calls: (readonly string[])[] = [];
    const cpu = fakeEngine({ transcription: [segment(" Hola", 0, 1200, 45)] }, ["whisper_backend_init_gpu: no GPU found"]);
    const run: RunEngine = async (binary, args, onLine) => {
      calls.push(args);
      if (calls.length === 1) {
        onLine(`whisper_backend_init_gpu: using ${backend} backend`);
        throw new Error("whisper-cli exited with code 1:\nCUDA error: out of memory");
      }
      await cpu.run(binary, args, onLine);
    };
    const { ctx, progress } = context();
    const result = await createWhisperProvider({ runEngine: run }).transcribe(holaMundoWav(), {}, ctx);

    expect(calls).toHaveLength(2);
    expect(calls[0]).not.toContain("-ng");
    expect(calls[1]).toEqual([...calls[0]!, "-ng"]);
    expect(progress.map((p) => p.message)).toContain(`whisper.cpp failed on ${device} (CUDA error: out of memory); retrying on CPU`);
    expect(result).toMatchObject({ device: "cpu", words: [{ text: "Hola" }] });
  });

  it("does not retry a failure on CPU", async () => {
    let runs = 0;
    const run: RunEngine = async () => {
      runs += 1;
      throw new Error("whisper-cli exited with code 3:\nfailed to open audio");
    };
    await expect(createWhisperProvider({ runEngine: run }).transcribe(holaMundoWav(), {}, context().ctx)).rejects.toThrow(/code 3/);
    expect(runs).toBe(1);
  });

  it("auto-detects the language when none is given", async () => {
    const engine = fakeEngine({ result: { language: "es" }, transcription: [] });
    const result = await createWhisperProvider({ runEngine: engine.run }).transcribe(holaMundoWav(), {}, context().ctx);
    const args = engine.calls[0]!.args;
    expect(args[args.indexOf("-l") + 1]).toBe("auto");
    expect(result.language).toBe("es");
  });
});
