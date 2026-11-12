import { describe, expect, it } from "vitest";
import { NoBeatsError, detectBeats, onsetEnvelope, prepareSignal } from "../src/media/beats.js";
import { type ClickTrack, clickTime, clickTrack } from "./beat-fixture.js";

// Seam under test: prepareSignal + onsetEnvelope + detectBeats on synthetic click tracks, the way
// BeatsStore calls them. The bar is ADR 0029's: beats within 15 ms of the truth.

function measure(track: ClickTrack, hint?: number) {
  const rate = track.rate ?? 48_000;
  const signal = prepareSignal(clickTrack(track), rate);
  return detectBeats(signal, onsetEnvelope(signal), { hint, sourceRate: rate });
}

/** Largest gap between detected beat `i` and the truth, matching by nearest true beat. */
function worstError(track: ClickTrack, beats: number[]): number {
  let worst = 0;
  for (const time of beats) {
    const index = Math.round(((time - (track.offset ?? 0)) * track.bpm) / 60);
    worst = Math.max(worst, Math.abs(time - clickTime(track, index)));
  }
  return worst;
}

describe("detectBeats", () => {
  it("puts a 120 BPM click track on the clicks within 15 ms, with the accented beat as the bar start", () => {
    const track = { bpm: 120, seconds: 24, offset: 0.13, accent: 2 };
    const found = measure(track);
    expect(found.bpm).toBeCloseTo(120, 0);
    expect(worstError(track, found.beats)).toBeLessThan(0.015);
    expect(found.residualMs).toBeLessThan(15);
    expect(found.confidence).toBeGreaterThan(0.9);
    expect(found.alternatives).toEqual([]);
    // The first beat of the grid is the click at 0.13 s (index 0); the accented one is index 2.
    expect(found.beats[0]).toBeCloseTo(0.13, 2);
    expect(found.downbeat).toBe(2);
    expect(found.onsets).toHaveLength(48);
  });

  it("finds a hit at t = 0", () => {
    const track = { bpm: 100, seconds: 20, offset: 0 };
    const found = measure(track);
    expect(found.beats[0]).toBeLessThan(0.015);
    expect(worstError(track, found.beats)).toBeLessThan(0.015);
    expect(found.onsets[0]).toBeLessThan(0.015);
  });

  it("starts the grid at the first hit and ends it at the last, not in the silence around the music", () => {
    const track = { bpm: 90, seconds: 30, offset: 1.1 };
    const found = measure(track);
    expect(found.beats[0]).toBeGreaterThan(1.08);
    expect(found.beats[0]).toBeLessThan(1.12);
    expect(worstError(track, found.beats)).toBeLessThan(0.015);
    expect(found.beats.at(-1)!).toBeGreaterThan(29);
  });

  it("does not drift over a long track whose tempo is not a round number", () => {
    const track = { bpm: 127.6, seconds: 150, offset: 0.4 };
    const found = measure(track);
    expect(found.bpm).toBeCloseTo(127.6, 1);
    expect(worstError(track, found.beats)).toBeLessThan(0.015);
    expect(found.beats.length).toBeGreaterThan(300);
  });

  it("keeps the grid through a faint bed of noise and a part with missing clicks", () => {
    const track = { bpm: 96, seconds: 40, offset: 0.2, bed: true, skip: (index: number) => index >= 20 && index < 26 };
    const found = measure(track);
    expect(found.bpm).toBeCloseTo(96, 0);
    expect(worstError(track, found.beats)).toBeLessThan(0.015);
    expect(found.confidence).toBeGreaterThan(0.5);
  });

  it("says low confidence for a bogus double-time grid and offers both other tempi, the true one first", () => {
    // One click a second (60 BPM): folded into 70-170 it becomes 120 BPM with every other beat empty.
    const found = measure({ bpm: 60, seconds: 40, offset: 0.25 });
    expect(found.bpm).toBeCloseTo(120, 0);
    expect(found.confidence).toBeLessThan(0.5);
    expect(found.alternatives.map((a) => a.tempo)).toEqual(["half", "double"]);
    expect(found.alternatives[0]!.bpm).toBeCloseTo(60, 0);
  });

  it("corrects half and double time toward the hint", () => {
    const slow = measure({ bpm: 60, seconds: 40, offset: 0.25 }, 60);
    expect(slow.bpm).toBeCloseTo(60, 0);
    expect(slow.beats[1]! - slow.beats[0]!).toBeCloseTo(1, 1);
    expect(slow.confidence).toBeGreaterThan(0.9);
    const fast = measure({ bpm: 180, seconds: 30, offset: 0.05 }, 180);
    expect(fast.bpm).toBeCloseTo(180, 0);
    expect(worstError({ bpm: 180, seconds: 30, offset: 0.05 }, fast.beats)).toBeLessThan(0.015);
    const folded = measure({ bpm: 180, seconds: 30, offset: 0.05 }, 90);
    expect(folded.bpm).toBeCloseTo(90, 0);
  });

  it("caps the confidence of audio decoded at 16 kHz", () => {
    const track = { bpm: 110, seconds: 20, offset: 0.1, rate: 16_000 };
    const found = measure(track);
    expect(worstError(track, found.beats)).toBeLessThan(0.015);
    expect(found.confidence).toBeLessThan(0.5);
  });

  it("refuses silence and sound with no rhythm", () => {
    const silence = prepareSignal(new Float32Array(48_000 * 10), 48_000);
    expect(() => detectBeats(silence, onsetEnvelope(silence))).toThrow(NoBeatsError);
    let seed = 3;
    const noise = new Float32Array(48_000 * 12).map(() => {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      return 0.2 * ((seed / 2 ** 32) * 2 - 1);
    });
    const hiss = prepareSignal(noise, 48_000);
    // Steady noise has no onsets; if the detector finds some it must not claim to be sure.
    try {
      expect(detectBeats(hiss, onsetEnvelope(hiss)).confidence).toBeLessThan(0.5);
    } catch (error) {
      expect(error).toBeInstanceOf(NoBeatsError);
    }
  });
});
