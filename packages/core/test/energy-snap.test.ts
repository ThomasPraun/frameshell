import { describe, expect, it } from "vitest";
import { DEFAULT_SNAP_WINDOW_S, FrameGrid, energyEnvelope, energyProfile, profileLevel, snapToPause } from "../src/index.js";
import { WORDS, speechLike, voicedAt } from "./speech-fixture.js";

// Seam under test: energyEnvelope + energyProfile + snapToPause, fed synthetic
// speech-like PCM (modulated tones = words, near-silent gaps = pauses).

const RATE = 16_000;
const samples = speechLike(RATE);
const profile = energyProfile(energyEnvelope(samples, RATE));
const grid = new FrameGrid(30);
const duration = samples.length / RATE;
const snap = (time: number, window = DEFAULT_SNAP_WINDOW_S) =>
  snapToPause({ time, window, grid, level: (t) => profileLevel(profile, t), min: 0, max: duration });

/** Real pauses of the fixture (>= 200 ms) as [start, end]. */
const PAUSES = WORDS.slice(1)
  .map((word, i) => [WORDS[i]!.end, word.start] as const)
  .filter(([a, b]) => b - a >= 0.2);

describe("energy snapping", () => {
  it("never lands a cut inside a voiced region", () => {
    for (let requested = 0; requested <= duration; requested += 0.013) {
      const result = snap(requested);
      if (result.clean) expect(voicedAt(result.time), `requested ${requested} -> ${result.time}`).toBe(false);
      // A pause interior (edges blur by ~50 ms; plus one frame of grid) within the window means a clean cut.
      const inset = 0.05 + 1 / 30;
      const reachable = PAUSES.some(([a, b]) => a + inset <= requested + 0.5 && b - inset >= requested - 0.5);
      if (reachable) expect(result.clean, `requested ${requested}`).toBe(true);
      if (result.clean) expect(Math.abs(result.time - requested)).toBeLessThanOrEqual(0.5 + 1e-9);
    }
  });

  it("keeps a point already inside a pause and moves one in a word to the nearest pause interior", () => {
    // Pause 2.5-3.5: a point well inside stays (on the grid).
    expect(snap(3.0)).toEqual({ time: 3, clean: true });
    // Word ends at 0.8, pause 0.8-1.1: 0.7 moves just inside the pause, not to a valley in the word.
    const moved = snap(0.7);
    expect(moved.clean).toBe(true);
    expect(moved.time).toBeGreaterThan(0.8);
    expect(moved.time).toBeLessThan(1.1);
  });

  it("ignores gaps shorter than 200 ms", () => {
    // The 1.6-1.7 gap is 100 ms; 1.65 is inside it but the nearest real pause is 0.8-1.1.
    const result = snap(1.65, 1);
    expect(result.clean).toBe(true);
    expect(result.time).toBeGreaterThan(0.8);
    expect(result.time).toBeLessThan(1.1);
  });

  it("applies a cut with no pause in reach at the lowest-energy frame and reports it unclean", () => {
    // 5.0-7.0 is one long word: no pause within ±0.5 s of 6.
    const result = snap(6);
    expect(result.clean).toBe(false);
    expect(result.time).toBeGreaterThanOrEqual(5.5);
    expect(result.time).toBeLessThanOrEqual(6.5);
    const levelAt = (t: number) => profileLevel(profile, t);
    for (let n = grid.frame(5.5); n <= grid.frame(6.5); n++) {
      expect(levelAt(result.time)).toBeLessThanOrEqual(levelAt(grid.seconds(n)) + 0.5);
    }
  });

  it("widens the reach with a larger window", () => {
    expect(snap(6, 0.5).clean).toBe(false);
    const wide = snap(4.2, 1);
    expect(wide.clean).toBe(true);
    expect(wide.time).toBeGreaterThan(3.2);
    expect(wide.time).toBeLessThan(3.5);
  });

  it("returns frame-grid times that stay in the pause after grid snapping", () => {
    for (const fps of [24, 25, 30, 60]) {
      const g = new FrameGrid(fps);
      for (let requested = 0; requested <= duration; requested += 0.037) {
        const { time, clean } = snapToPause({ time: requested, window: 0.5, grid: g, level: (t) => profileLevel(profile, t), min: 0, max: duration });
        expect(g.snap(time)).toBe(time);
        if (clean) expect(voicedAt(g.snap(time))).toBe(false);
      }
    }
  });

  it("stays inside [min, max]", () => {
    const result = snapToPause({ time: 0.9, window: 0.5, grid, level: (t) => profileLevel(profile, t), min: 0, max: 0.8 });
    expect(result.time).toBeLessThanOrEqual(0.8);
    expect(result.clean).toBe(false);
  });
});
