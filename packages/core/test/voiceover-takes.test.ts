import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TRIM_LEAD_S, TRIM_TAIL_S, standInSpeechProvider, takeKey, takeMarkOf, takeWavBytes, trimSilence } from "../src/index.js";
import { pcmOfWav } from "../src/transcripts/window.js";
import { tempDir } from "./helpers.js";

const RATE = 16_000;

/** `seconds` of PCM: silence except a 440 Hz tone at `amplitude` over [from, to). */
function tone(seconds: number, from: number, to: number, amplitude = 0.5): Int16Array {
  const samples = new Int16Array(Math.round(seconds * RATE));
  for (let i = Math.round(from * RATE); i < Math.round(to * RATE); i++) samples[i] = Math.round(amplitude * 32767 * Math.sin((2 * Math.PI * 440 * i) / RATE));
  return samples;
}

describe("takeKey", () => {
  const base = { provider: "kokoro", providerVersion: "1", voice: "ef_dora", options: { language: "es" }, text: "Son veintitrés." };

  it("is the same for the same take, whatever the option order", () => {
    expect(takeKey(base)).toMatch(/^[0-9a-f]{64}$/);
    expect(takeKey({ ...base, options: { language: "es", ...{} } })).toBe(takeKey(base));
    expect(takeKey({ ...base, options: { language: "es", extra: undefined } as never })).toBe(takeKey(base));
  });

  it.each([
    ["provider", { provider: "piper" }],
    ["provider version", { providerVersion: "2" }],
    ["voice", { voice: "em_alex" }],
    ["language", { options: { language: "en" } }],
    ["no language", { options: {} }],
    ["text", { text: "Son veinticuatro." }],
  ])("changes with the %s", (_what, patch) => {
    expect(takeKey({ ...base, ...patch })).not.toBe(takeKey(base));
  });
});

describe("take marks", () => {
  it("round-trip inside a WAV that still reads as plain PCM", () => {
    const pcm = { sampleRate: RATE, samples: tone(0.5, 0.1, 0.4) };
    const mark = { key: "a".repeat(64), provider: "stand-in", voice: "tone", text: "Hola mundo." };
    const bytes = takeWavBytes(pcm, mark);
    expect(takeMarkOf(bytes)).toEqual(mark);
    expect(pcmOfWav(bytes)).toEqual(pcm);
  });

  it("are absent from WAVs written elsewhere", () => {
    const plain = Buffer.alloc(44);
    plain.write("RIFF", 0, "ascii");
    plain.write("WAVEfmt ", 8, "ascii");
    expect(takeMarkOf(plain)).toBeNull();
    expect(takeMarkOf(Buffer.from("not a wav"))).toBeNull();
  });
});

describe("trimSilence", () => {
  it("cuts head and tail silence, keeping the lead and tail air", () => {
    const trimmed = trimSilence({ sampleRate: RATE, samples: tone(2, 0.5, 1.2) });
    expect(trimmed.silent).toBe(false);
    expect(trimmed.head).toBeCloseTo(0.5 - TRIM_LEAD_S, 2);
    expect(trimmed.tail).toBeCloseTo(2 - 1.2 - TRIM_TAIL_S, 2);
    expect(trimmed.pcm.samples.length / RATE).toBeCloseTo(0.7 + TRIM_LEAD_S + TRIM_TAIL_S, 2);
  });

  it("keeps quiet speech inside the take and drops a hiss far below the peak", () => {
    const samples = tone(2, 0.5, 0.8);
    const quiet = tone(2, 1.0, 1.3, 0.05);
    const hiss = tone(2, 1.6, 1.9, 0.001);
    for (let i = 0; i < samples.length; i++) samples[i] = samples[i]! + quiet[i]! + hiss[i]!;
    const trimmed = trimSilence({ sampleRate: RATE, samples });
    expect(trimmed.head).toBeCloseTo(0.48, 2);
    expect(trimmed.tail).toBeCloseTo(2 - 1.3 - TRIM_TAIL_S, 2);
  });

  it("leaves a silent take whole and says so", () => {
    const samples = new Int16Array(RATE);
    expect(trimSilence({ sampleRate: RATE, samples })).toEqual({ pcm: { sampleRate: RATE, samples }, head: 0, tail: 0, silent: true });
  });

  it("never cuts past the file ends", () => {
    const trimmed = trimSilence({ sampleRate: RATE, samples: tone(1, 0, 1) });
    expect([trimmed.head, trimmed.tail]).toEqual([0, 0]);
  });
});

describe("stand-in speech provider", () => {
  it("is free, deterministic and as long as the word count says", async () => {
    const provider = standInSpeechProvider();
    expect(provider.estimate).toBeUndefined();
    const say = async (text: string) => {
      const outDir = join(tempDir(), "out");
      mkdirSync(outDir);
      try {
        const { file } = await provider.synthesize(text, "tone", {}, { outDir, signal: new AbortController().signal, ensureBinary: async () => "", progress: () => {} });
        return readFileSync(file);
      } finally {
        rmSync(outDir, { recursive: true, force: true });
      }
    };
    const one = await say("Hola mundo, ¿qué tal?");
    expect(await say("Hola mundo, ¿qué tal?")).toEqual(one);
    const pcm = pcmOfWav(one)!;
    expect(pcm.samples.length / pcm.sampleRate).toBeCloseTo(0.3 + 4 * 0.4 + 0.5, 3);
    const trimmed = trimSilence(pcm);
    expect(trimmed.head).toBeCloseTo(0.3 - TRIM_LEAD_S, 2);
    expect(trimmed.tail).toBeGreaterThan(0.5);
  });
});
