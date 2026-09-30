import { describe, expect, it } from "vitest";
import { audioReads, renderRead, sourceWindow } from "../src/renderer/src/preview/audio-plan.js";
import type { AudioSpan } from "../src/renderer/src/preview/program.js";

// Seam under test: program audio spans to sidecar byte reads and output samples (the engine worker feeds these to the mixer).

const span = (overrides: Partial<AudioSpan> = {}): AudioSpan => ({
  clip: "c1",
  start: 1000,
  end: 2000,
  sidecar: ".frameshell/proxies/a.pcm",
  channels: 1,
  in: 50_000,
  speed: 1,
  gain: 1,
  ...overrides,
});

describe("audioReads", () => {
  it("covers a window of the program in chunks, clipped to each span, overlapping spans each read", () => {
    const a = span();
    const b = span({ clip: "c2", start: 1500, end: 3000 });
    const reads = audioReads([a, b], 1200, 2600, 500);
    expect(reads.map((r) => [r.span.clip, r.from, r.to])).toEqual([
      ["c1", 1200, 1700],
      ["c1", 1700, 2000],
      ["c2", 1500, 2000],
      ["c2", 2000, 2500],
      ["c2", 2500, 2600],
    ]);
  });

  it("reads nothing outside every span", () => {
    expect(audioReads([span()], 0, 1000, 500)).toEqual([]);
    expect(audioReads([span()], 2000, 4000, 500)).toEqual([]);
  });
});

describe("sourceWindow", () => {
  it("maps program samples to the sidecar frames they play", () => {
    expect(sourceWindow({ span: span(), from: 1200, to: 1700 })).toEqual({ first: 50_200, count: 500 });
  });

  it("reads one frame more when speed interpolates between frames", () => {
    expect(sourceWindow({ span: span({ speed: 1.5 }), from: 1000, to: 1100 })).toEqual({ first: 50_000, count: 150 });
  });
});

describe("renderRead", () => {
  it("copies mono s16 exactly as float at speed 1 and unity gain (sample-exact program)", () => {
    const pcm = Int16Array.from([0, 16384, -32768, 32767]);
    const out = renderRead({ span: span(), from: 1000, to: 1004 }, pcm, 50_000);
    expect(Array.from(out)).toEqual([0, 0.5, -1, 32767 / 32768]);
  });

  it("downmixes interleaved channels by averaging and applies the clip's gain", () => {
    const pcm = Int16Array.from([16384, 0, 8192, 8192]);
    const out = renderRead({ span: span({ channels: 2, gain: 0.5 }), from: 1000, to: 1002 }, pcm, 50_000);
    expect(Array.from(out)).toEqual([0.125, 0.125]);
  });

  it("resamples linearly for sped-up clips", () => {
    const pcm = Int16Array.from([0, 8192, 16384, 24576]);
    const out = renderRead({ span: span({ speed: 1.5 }), from: 1000, to: 1002 }, pcm, 50_000);
    expect(Array.from(out)).toEqual([0, 0.375]);
  });

  it("plays silence for frames past the end of the sidecar", () => {
    const pcm = Int16Array.from([16384]);
    const out = renderRead({ span: span(), from: 1000, to: 1003 }, pcm, 50_000);
    expect(Array.from(out)).toEqual([0.5, 0, 0]);
  });
});
