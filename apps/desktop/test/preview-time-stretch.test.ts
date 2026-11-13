import { describe, expect, it } from "vitest";
import { StretchChain, type StretchSpan, stretch, stretchWindow } from "../src/renderer/src/preview/time-stretch.js";
import { dominantHz, onset } from "./audio-measure.js";

// Seam under test: the preview's pitch-keeping stretch of a span at clip speed ≠ 1 (#499), on synthetic tones.

const RATE = 48_000;

/** 4 s of source: silence, then a 440 Hz tone from 1 s on. */
const source = Float32Array.from({ length: 4 * RATE }, (_, i) => (i >= RATE ? 0.5 * Math.sin((2 * Math.PI * 440 * i) / RATE) : 0));

/** Program samples `[from, to)` of `span`, read the way the engine worker reads them: its window of the source only. */
function read(span: StretchSpan, from: number, to: number, chain?: StretchChain): Float32Array {
  const { first, count } = stretchWindow(span, from, to);
  return stretch(span, from, to, source.slice(first, first + count), first, chain);
}

describe("time stretch", () => {
  for (const speed of [0.5, 0.75, 1.25, 2]) {
    it(`keeps a 440 Hz tone at 440 Hz and its onset where the speed puts it, at ${speed}x`, () => {
      const span = { start: 0, in: 0, speed };
      const length = Math.floor((3.5 * RATE) / speed);
      const out = read(span, 0, length);
      const steady = Math.round(RATE / speed) + 8192;
      expect(Math.abs(dominantHz(out.subarray(steady, steady + 8192), RATE) - 440)).toBeLessThan(2);
      // The tone starts at source second 1, so at 1 / speed on the program. A frame aligned to the one before it moves
      // by up to the 512-sample search and fades in over half its window: an onset after silence lands within 21 ms.
      expect(Math.abs(onset(out, 0.5) - RATE / speed)).toBeLessThan(1024);
    });
  }

  it("hears one chain however a play's reads are cut, each read carrying it over to the next", () => {
    const span = { start: 10_000, in: 30_000, speed: 1.25 };
    const whole = read(span, 10_000, 130_000);
    for (const size of [24_000, 777, 1024]) {
      const chain = new StretchChain();
      const pieces = new Float32Array(whole.length);
      for (let at = 10_000; at < 130_000; at += size) pieces.set(read(span, at, Math.min(130_000, at + size), chain), at - 10_000);
      expect(pieces).toEqual(whole);
    }
  });

  it("starts a new chain where a read does not follow on, with its first frame where the speed puts it", () => {
    const span = { start: 0, in: 0, speed: 2 };
    const chain = new StretchChain();
    read(span, 0, 24_000, chain);
    // A seek: frame 60 (program sample 61 440) is centred on source sample 122 880 and plays it at full weight.
    const sought = read(span, 61_440, 62_000, chain);
    expect(sought[0]).toBe(source[122_880]);
    expect(sought).toEqual(read(span, 61_440, 62_000));
  });

  it("reads only inside its window: the whole source gives the same samples", () => {
    const span = { start: 0, in: 40_000, speed: 0.8 };
    expect(read(span, 5000, 40_000)).toEqual(stretch(span, 5000, 40_000, source, 0));
  });
});
