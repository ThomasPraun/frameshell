import { describe, expect, it } from "vitest";
import type { ResolvedSubtitleTrack } from "@frameshell/schema";
import { type MetricsInput, readingFloor, reviewMetrics, shortCues, visualEvents } from "../src/review/metrics.js";
import type { MotionSeries } from "../src/review/source.js";

// Metrics of `review` from hand-made motion series: one sample every half second unless said.

/** A series sampled every `step` s from 0; `energy[0]` is 0 as the measure reports it. */
function series(energy: number[], spread: number[] = energy.map(() => 50), step = 0.5): MotionSeries {
  return { times: energy.map((_, i) => i * step), energy, spread };
}

function input(motion: MotionSeries, extra: Partial<MetricsInput> = {}): MetricsInput {
  const end = motion.times.length === 0 ? 0 : motion.times.at(-1)! + 0.5;
  return { fps: 30, range: { from: 0, to: end }, series: motion, tracks: null, loudness: null, hasSound: null, ...extra };
}

/** A subtitle track of cues given as [start, end, words] in seconds. */
function track(...cues: [number, number, number][]): ResolvedSubtitleTrack {
  return {
    track: "subs",
    follows: "v1",
    fps: 30,
    unknownPreset: null,
    missing: [],
    style: {} as ResolvedSubtitleTrack["style"],
    cues: cues.map(([start, end, words]) => ({
      start: Math.round(start * 30),
      end: Math.round(end * 30),
      words: Array.from({ length: words }, (_, i) => ({ text: `w${i}`, start: Math.round(start * 30), end: Math.round(end * 30) })),
      highlight: false,
      entry: "none",
    })) as unknown as ResolvedSubtitleTrack["cues"],
  };
}

describe("review metrics: picture", () => {
  it("the longest still stretch runs from the sample before the first quiet change to the last quiet one", () => {
    // Quiet from 1 s to 5 s (samples 3 to 10 change by 0.1).
    const energy = [0, 8, 8, ...Array(8).fill(0.1), 8, 8];
    const metrics = reviewMetrics(input(series(energy)));
    expect(metrics.picture.longestStatic).toEqual({ from: 1, to: 5, seconds: 4 });
    expect(metrics.picture.staticRuns).toEqual([{ from: 1, to: 5, seconds: 4 }]);
    expect(metrics.craft).toEqual([expect.objectContaining({ check: "static", from: 1, to: 5 })]);
  });

  it("a still stretch of 3 s or less is measured but not a warning", () => {
    const metrics = reviewMetrics(input(series([0, 8, ...Array(6).fill(0), 8, 8])));
    expect(metrics.picture.longestStatic).toEqual({ from: 0.5, to: 3.5, seconds: 3 });
    expect(metrics.picture.staticRuns).toEqual([]);
    expect(metrics.craft).toEqual([]);
  });

  it("visual events are peaks above the larger of 1 level and 2.5 times the median change; a plateau is one", () => {
    const motion = series([0, 0.2, 4, 4, 0.2, 0.2, 9, 0.2, 0.9, 0.2]);
    expect(visualEvents(motion)).toEqual([0.75, 2.75]);
    // Busy footage raises the bar: a 4 among changes of 3 is not an event.
    expect(visualEvents(series([0, 3, 3, 4, 3, 3, 3, 3]))).toEqual([]);
  });

  it("the largest gap counts the start and the end of the range as ends", () => {
    const motion = series([0, 0.1, 0.1, 9, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1]);
    const metrics = reviewMetrics(input(motion));
    expect(metrics.picture.events).toBe(1);
    expect(metrics.picture.largestGap).toEqual({ from: 1.25, to: 5, seconds: 3.75 });
  });

  it("near-blank samples are listed as stretches and frame 0 is the thumbnail", () => {
    const metrics = reviewMetrics(input(series([0, 8, 8, 8, 8, 8], [1, 50, 2, 3, 50, 1])));
    expect(metrics.picture.firstFrameEmpty).toBe(true);
    expect(metrics.picture.blank).toEqual([
      { from: 0, to: 0.5, seconds: 0.5 },
      { from: 1, to: 2, seconds: 1 },
      { from: 2.5, to: 3, seconds: 0.5 },
    ]);
    expect(metrics.craft.map((warning) => warning.check)).toEqual(["frame-0", "blank", "blank"]);
  });

  it("frame 0 is not measured for a range that does not start at 0", () => {
    const metrics = reviewMetrics(input(series([0, 8, 8], [1, 50, 50]), { range: { from: 2, to: 3.5 } }));
    expect(metrics.picture.firstFrameEmpty).toBeNull();
    expect(metrics.craft.map((warning) => warning.check)).toEqual(["blank"]);
  });

  it("one sample has no still stretch and no gap", () => {
    const metrics = reviewMetrics(input(series([0]), { range: { from: 0, to: 0.033 } }));
    expect(metrics.picture).toMatchObject({ samples: 1, spacing: 0, longestStatic: null, largestGap: null, events: 0 });
  });
});

describe("review metrics: subtitles", () => {
  it("the reading floor is 0.4 s for one or two words and grows with the words after that", () => {
    expect(readingFloor(1)).toBe(0.4);
    expect(readingFloor(2)).toBe(0.4);
    expect(readingFloor(4)).toBeCloseTo(0.75 * (0.5 + 1.2), 6);
  });

  it("lists the cues in range that are on screen for less than their floor", () => {
    const found = shortCues([track([0, 0.3, 1], [1, 1.4, 2], [2, 2.8, 4], [2.8, 5, 4], [9, 9.1, 1])], { from: 0, to: 5 });
    expect(found.cues).toBe(4);
    expect(found.short).toEqual([
      { track: "subs", from: 0, to: 0.3, words: 1, floor: 0.4 },
      { track: "subs", from: 2, to: 2.8, words: 4, floor: 1.275 },
    ]);
  });

  it("reaches the craft warnings; no tracks: null", () => {
    const motion = series([0, 8, 8, 8]);
    const metrics = reviewMetrics(input(motion, { tracks: [track([0, 0.3, 1])] }));
    expect(metrics.subtitles).toEqual({ cues: 1, shortCues: [{ track: "subs", from: 0, to: 0.3, words: 1, floor: 0.4 }] });
    expect(metrics.craft).toEqual([expect.objectContaining({ check: "reading", from: 0, to: 0.3 })]);
    expect(reviewMetrics(input(motion, { tracks: [] })).subtitles).toBeNull();
    expect(reviewMetrics(input(motion)).subtitles).toBeNull();
  });
});

describe("review metrics: sound", () => {
  const motion = series([0, 8, 8, 8]);

  it("warns about a true peak above -1 dBTP and a phone band 6 LU under the mix", () => {
    const ok = reviewMetrics(input(motion, { hasSound: true, loudness: { integrated: -14, range: 5, truePeak: -1.5, phoneBand: -18 } }));
    expect(ok.craft).toEqual([]);
    const bad = reviewMetrics(input(motion, { hasSound: true, loudness: { integrated: -14, range: 5, truePeak: -0.2, phoneBand: -23 } }));
    expect(bad.craft.map((warning) => warning.check)).toEqual(["peak", "phone-band"]);
    expect(bad.craft[1]!.message).toContain("9 LU");
    expect(bad.loudness).toEqual({ integrated: -14, range: 5, truePeak: -0.2, phoneBand: -23 });
  });

  it("warns about a film over 15 s with no sound, not a short one, not one whose sound is unknown", () => {
    const long = (hasSound: boolean | null, loudness: MetricsInput["loudness"] = null) => reviewMetrics(input(motion, { range: { from: 0, to: 20 }, hasSound, loudness }));
    expect(long(false).craft.map((warning) => warning.check)).toEqual(["silent"]);
    expect(long(true, { integrated: null, range: null, truePeak: null, phoneBand: null }).craft.map((warning) => warning.check)).toEqual(["silent"]);
    expect(long(null).craft).toEqual([]);
    expect(reviewMetrics(input(motion, { hasSound: false })).craft).toEqual([]);
  });
});
