import { describe, expect, it } from "vitest";
import { classifyDrops, dropsIn } from "../e2e/draw-log.js";
import type { PlayDrops } from "../src/renderer/src/preview/drop-log.js";
import { type RunLog, analyze, checkThresholds } from "../e2e/preview-analysis.js";

/** Engine `dropped` stats with these frames, counts equal to the samples unless given. */
const engine = (starved: number[], cadence: number[], counts: { starved?: number; cadence?: number } = {}): PlayDrops => ({
  starved: { count: counts.starved ?? starved.length, frames: starved },
  cadence: { count: counts.cadence ?? cadence.length, frames: cadence },
  busyMaxMs: 2,
  busyP95Ms: 1,
});

describe("dropsIn", () => {
  it("lists the frames of the range the engine did not draw, whatever order or repeats", () => {
    expect(dropsIn([5, 6, 6, 8, 9, 20], engine([], [7]), 5, 10)).toEqual({ starved: [], cadence: [7] });
    expect(dropsIn([0, 1, 2], engine([], []), 1, 3)).toEqual({ starved: [], cadence: [] });
  });

  it("takes the engine's kind, and calls a frame the engine did not classify starved", () => {
    expect(dropsIn([], engine([1], [2]), 0, 4)).toEqual({ starved: [0, 1, 3], cadence: [2] });
    expect(classifyDrops([4, 5], null)).toEqual({ starved: [4, 5], cadence: [] });
  });

  it("reads a frame past a cut cadence sample as cadence only while the starved sample is complete", () => {
    expect(classifyDrops([1, 90, 91], engine([91], [1], { cadence: 60 }))).toEqual({ starved: [91], cadence: [1, 90] });
    expect(classifyDrops([1, 90], engine([91], [1], { starved: 70, cadence: 60 }))).toEqual({ starved: [90], cadence: [1] });
  });
});

describe("ADR 0001 analysis, interior drops", () => {
  // Two segments of 6 and 5 frames: source 10..16 plays from program frame 0, source 40..45 from program frame 6.
  const segments = [
    { inF: 10, outF: 16, pF: 0 },
    { inF: 40, outF: 45, pF: 6 },
  ];
  const run = (drawn: number[], probes: [number, number][], dropped: RunLog["dropped"] = null): RunLog => ({
    fps: 30,
    sampleRate: 48_000,
    segments,
    probes,
    drawn,
    dropped,
    anchor: { frame: 0, sample: 0 },
    audioStart: 0,
    audio: new Float32Array(0),
    audioGaps: 0,
    timestamps: [{ contextTime: 1, performanceTime: 1000 }],
    expected: null,
  });
  // The page's rAF read every second frame only: a stalled main thread, not a drop.
  const lateProbes = segments.flatMap((s, k) =>
    Array.from({ length: s.outF - s.inF }, (_, i): [number, number] => [(k * 10 + i) * 34, i % 2 === 0 ? s.inF + i : s.inF + i - 1]),
  );

  it("counts from the frames the engine drew, not from the ones a page frame read", () => {
    const all = Array.from({ length: 11 }, (_, p) => p);
    const summary = analyze(run(all, lateProbes));
    expect(summary.video.interiorFrames).toBe(4 + 3);
    expect(summary.video.interiorDrops).toBe(0);
  });

  it("counts an interior frame the engine never drew", () => {
    // Program frames 2 (source 12) and 8 (source 42) missing.
    const drawn = [0, 1, 3, 4, 5, 6, 7, 9, 10];
    expect(analyze(run(drawn, lateProbes)).video.interiorDrops).toBe(2);
  });

  it("fails threshold 3 on starved interior drops only; cadence drops are reported", () => {
    const drawn = [0, 1, 3, 4, 5, 6, 7, 9, 10];
    const cadence = analyze(run(drawn, lateProbes, engine([], [2, 8])));
    expect(cadence.video).toMatchObject({ interiorDrops: 2, interiorStarved: 0, interiorCadence: 2 });
    expect(checkThresholds(cadence).find((check) => check.id === 3)?.pass).toBe(true);
    const starved = analyze(run(drawn, lateProbes, engine([8], [2])));
    expect(starved.video).toMatchObject({ interiorStarved: 1, interiorCadence: 1 });
    expect(checkThresholds(starved).find((check) => check.id === 3)?.pass).toBe(false);
  });
});
