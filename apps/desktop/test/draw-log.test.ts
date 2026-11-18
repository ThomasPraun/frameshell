import { describe, expect, it } from "vitest";
import { classifyDrops, cutEdgeDrops, dropsIn } from "../e2e/draw-log.js";
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

describe("cutEdgeDrops", () => {
  // Source 10..16 plays from program frame 0 (frames 0-5), source 40..45 from 6 (frames 6-10), source 70..73 from 11.
  const segments = [
    { inF: 10, outF: 16, pF: 0 },
    { inF: 40, outF: 45, pF: 6 },
    { inF: 70, outF: 73, pF: 11 },
  ];
  const all = Array.from({ length: 14 }, (_, p) => p);
  const without = (...gone: number[]) => all.filter((p) => !gone.includes(p));

  it("is empty when the last and first frames at the cut were drawn", () => {
    expect(cutEdgeDrops(all, engine([], []), segments, 0)).toEqual({ starved: [], cadence: [] });
  });

  it("takes the undrawn run at the end of one segment and the start of the next, nothing from other cuts", () => {
    const drawn = without(4, 5, 6, 11);
    expect(cutEdgeDrops(drawn, null, segments, 0)).toEqual({ starved: [4, 5, 6], cadence: [] });
    expect(cutEdgeDrops(drawn, null, segments, 1)).toEqual({ starved: [11], cadence: [] });
  });

  it("stops a run at its segment, and ignores a hole that does not touch the cut", () => {
    expect(cutEdgeDrops(without(2, 6), null, segments, 0)).toEqual({ starved: [6], cadence: [] });
    expect(cutEdgeDrops([], engine([], []), segments, 0).starved).toHaveLength(6 + 5);
  });

  it("gives each frame the engine's kind", () => {
    expect(cutEdgeDrops(without(5, 6), engine([6], [5]), segments, 0)).toEqual({ starved: [6], cadence: [5] });
  });
});

describe("ADR 0001 analysis, drops at cuts", () => {
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
  // The page's rAF read every second frame only, so its probes miss the last frame of segment 0 (source 15).
  const lateProbes = segments.flatMap((s, k) =>
    Array.from({ length: s.outF - s.inF }, (_, i): [number, number] => [(k * 10 + i) * 34, i % 2 === 0 ? s.inF + i : s.inF + i - 1]),
  );
  const all = Array.from({ length: 11 }, (_, p) => p);
  const threshold1 = (summary: ReturnType<typeof analyze>) => checkThresholds(summary).find((check) => check.id === 1)!;

  it("counts none when the probes miss a frame at the cut that the engine drew", () => {
    const summary = analyze(run(all, lateProbes));
    expect(summary.cutsMeasured).toBe(1);
    expect(summary.video).toMatchObject({ droppedFramesTotal: 0, droppedStarved: 0, droppedCadence: 0 });
    expect(threshold1(summary).pass).toBe(true);
  });

  it("fails threshold 1 on a frame at the cut the engine never drew and did not call cadence", () => {
    const drawn = all.filter((p) => p !== 5);
    const summary = analyze(run(drawn, lateProbes, engine([5], [])));
    expect(summary.video).toMatchObject({ droppedFramesTotal: 1, droppedStarved: 1, droppedCadence: 0 });
    expect(threshold1(summary).pass).toBe(false);
    expect(analyze(run(drawn, lateProbes)).video.droppedStarved).toBe(1);
  });

  it("reports cadence drops at a cut without failing threshold 1", () => {
    const drawn = all.filter((p) => p !== 6);
    const summary = analyze(run(drawn, lateProbes, engine([], [6])));
    expect(summary.video).toMatchObject({ droppedFramesTotal: 1, droppedStarved: 0, droppedCadence: 1 });
    const check = threshold1(summary);
    expect(check.pass).toBe(true);
    expect(check.detail).toContain("cadence 1 [6]");
  });

  it("counts a run reaching into the segment once, at the cut", () => {
    const drawn = all.filter((p) => p !== 4 && p !== 5);
    const video = analyze(run(drawn, lateProbes, engine([4, 5], []))).video;
    expect(video).toMatchObject({ droppedStarved: 2, interiorDrops: 0 });
  });
});
