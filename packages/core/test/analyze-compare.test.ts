import { describe, expect, it } from "vitest";
import { ANALYZE_DIFF_LABELS, ANALYZE_RESULT_LABELS, labelOf } from "@frameshell/protocol";
import { ALIGN_HZ, activityGrid, alignFilms, energyOf, energyWindows, matchedStretch, parseSsim, pickSnapshots, windowStep } from "../src/analyze/align.js";
import { bestLag, correlationAtLag } from "../src/analyze/correlate.js";
import { CURVE_MAX_VALUES, closestEase, curveOf, curveStep, movesOf } from "../src/analyze/curve.js";
import { CELLS, type PictureSeries } from "../src/analyze/events.js";
import { INK_MIN_FRAMES, inkOf } from "../src/analyze/ink.js";
import { boxAt, longestTrack, mouthPixels, mouthViewSize, syncOffset, syncResult, voiceLevel } from "../src/analyze/lip.js";

// The pure parts of `analyze` slice 3 (#471): curve, ink, mouth sync, and the alignment and SSIM of `analyze.diff`.

/** `frames` frames of the speed profile `speed(t)` (t in 0 to 1) scaled to `peak`, after `lead` still frames and before `tail` more. */
function profile(speed: (t: number) => number, frames: number, peak: number, lead = 5, tail = 5): number[] {
  return [...new Array<number>(lead).fill(0), ...Array.from({ length: frames }, (_, i) => peak * speed((i + 0.5) / frames)), ...new Array<number>(tail).fill(0)];
}

describe("curve", () => {
  const ease = { linear: () => 1, in: (t: number) => 3 * t * t, out: (t: number) => 3 * (1 - t) ** 2, inOut: (t: number) => (t < 0.5 ? 12 * t * t : 12 * (1 - t) ** 2) };

  it("tells the four eases apart from the speed of a move", () => {
    for (const name of ["linear", "in", "out", "inOut"] as const) {
      const speeds = Array.from({ length: 24 }, (_, i) => 3 * ease[name]((i + 0.5) / 24));
      const found = closestEase(speeds)!;
      expect(found.ease).toBe(name);
      expect(found.fit).toBeLessThan(0.15);
    }
  });

  it("finds a move, its time and its ease, between the big changes", () => {
    const activity = new Float32Array([...profile(ease.out, 30, 4, 10, 10)]);
    const moves = movesOf(activity, 30, []);
    expect(moves).toHaveLength(1);
    expect(moves[0]).toMatchObject({ startFrame: 10, endFrame: 34, start: 0.333, duration: 0.8, ease: "out" });
    expect(moves[0]!.peak).toBeGreaterThan(5);
    expect(moves[0]!.peakAt).toBeCloseTo(0.333, 2);
  });

  it("does not count a jump as a move, and ends the move around it", () => {
    const activity = new Float32Array([0, 0, 2, 2, 2, 60, 2, 2, 2, 0, 0]);
    const moves = movesOf(activity, 30, [5]);
    expect(moves.map((move) => [move.startFrame, move.endFrame])).toEqual([[2, 5], [6, 9]]);
  });

  it("leaves out a stretch shorter than 3 frames and joins one that dips for 2", () => {
    expect(movesOf(new Float32Array([0, 3, 3, 0, 0, 0]), 30, [])).toEqual([]);
    expect(movesOf(new Float32Array([0, 3, 3, 0, 0, 3, 3, 0]), 30, [])).toHaveLength(1);
  });

  it("does not fit the ease of a move over 3 s", () => {
    const [move] = movesOf(new Float32Array(new Array<number>(120).fill(2)), 30, []);
    expect(move).toMatchObject({ startFrame: 1, ease: null, fit: null });
  });

  it("keeps the curve to at most 1200 values and averages each step", () => {
    expect(curveStep(30)).toBe(0.1);
    expect(curveStep(1200)).toBe(1);
    expect(curveStep(3600)).toBe(3);
    const long = curveOf(new Float32Array(60 * 30 * 60), 30, []).curve;
    expect(long.values.length).toBeLessThanOrEqual(CURVE_MAX_VALUES);
    const { curve } = curveOf(new Float32Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]), 30, []);
    expect(curve.step).toBe(0.1);
    expect(curve.values).toEqual([1, 4, 7, 10]);
    expect(curve).toMatchObject({ mean: 5.5, peak: 11 });
    expect(curve.peakAt).toBeCloseTo(0.366, 2);
  });
});

/** A series of `frames` frames whose cell `(frame, cell)` detail is `detail(frame, cell)`. */
function series(frames: number, detail: (frame: number, cell: number) => number): Pick<PictureSeries, "frames" | "cellDetail"> {
  const cellDetail = new Float32Array(frames * CELLS);
  for (let frame = 0; frame < frames; frame++) for (let cell = 0; cell < CELLS; cell++) cellDetail[frame * CELLS + cell] = detail(frame, cell);
  return { frames, cellDetail };
}

describe("ink", () => {
  it("finds the cells that gain detail while text shows, and their box", () => {
    // 100 frames at 10 fps; cells 9, 10 and 17 (columns 1 and 2 of row 1, column 1 of row 2) hold text from frame 20 to 59.
    const found = inkOf(series(100, (frame, cell) => (frame >= 20 && frame < 60 && [9, 10, 17].includes(cell) ? 30 : 1)), [{ startFrame: 0, endFrame: 100 }], 10);
    expect(found.shots[0]).toEqual({ mean: 0.025, peak: 0.063, peakAt: 2, region: { x: 0.125, y: 0.167, width: 0.25, height: 0.333 } });
    expect(found.film).toEqual(found.shots[0]);
  });

  it("does not see text that stays on the whole shot, nor a shot too short", () => {
    const always = inkOf(series(50, (_, cell) => (cell === 5 ? 40 : 1)), [{ startFrame: 0, endFrame: 50 }], 10);
    expect(always.shots[0]).toEqual({ mean: 0, peak: 0, peakAt: null, region: null });
    const short = inkOf(series(INK_MIN_FRAMES, (frame, cell) => (frame === 3 && cell === 5 ? 40 : 1)), [{ startFrame: 0, endFrame: INK_MIN_FRAMES - 1 }], 10);
    expect(short.shots[0]!.peak).toBe(0);
  });

  it("reads each shot against its own quiet level and averages the film by frames", () => {
    const rows = series(40, (frame, cell) => (frame >= 25 && frame < 35 && cell === 3 ? 30 : frame < 20 ? 0 : 8));
    const found = inkOf(rows, [{ startFrame: 0, endFrame: 20 }, { startFrame: 20, endFrame: 40 }], 10);
    expect(found.shots[0]!.peak).toBe(0);
    expect(found.shots[1]).toMatchObject({ peak: 0.021, peakAt: 2.5 });
    expect(found.film.mean).toBeCloseTo(0.005, 3);
    expect(found.film.peakAt).toBe(2.5);
  });
});

describe("mouth sync", () => {
  it("finds the frames the mouth is after the voice", () => {
    const voice = Array.from({ length: 200 }, (_, i) => ([20, 21, 22, 23, 24, 60, 61, 62, 63, 64, 65, 120, 121, 122, 160, 161, 162, 163].includes(i) ? 1 : 0));
    const mouth = Array.from({ length: 200 }, (_, i) => voice[i - 6] ?? 0);
    const found = syncOffset(mouth, voice, 15, 1, 200)!;
    expect(found.lagFrames).toBe(6);
    expect(found.confidence).toBeGreaterThan(0.99);
    const early = syncOffset(voice, mouth, 15, 1, 200)!;
    expect(early.lagFrames).toBe(-6);
  });

  it("says why when there is nothing to compare or nothing alike", () => {
    expect(syncResult(null, 30, "t1", 90).reason).toMatch(/does not change/);
    const weak = syncResult({ lagFrames: 2, confidence: 0.1 }, 30, "t1", 90);
    expect(weak).toMatchObject({ offset: null, confidence: null, track: null, frames: 90 });
    expect(weak.reason).toMatch(/do not follow each other \(best match 0\.1\)/);
    expect(syncResult({ lagFrames: 3, confidence: 0.834 }, 30, "t2", 90)).toEqual({ offset: 0.1, confidence: 0.83, track: "t2", frames: 90, reason: null });
  });

  it("reads the voice level per frame, floored", () => {
    const db = new Float32Array(100).fill(-80);
    db.fill(-20, 50, 100);
    const level = voiceLevel(db, 0.01, 10, 10);
    expect(Array.from(level.slice(0, 5))).toEqual([-60, -60, -60, -60, -60]);
    expect(Array.from(level.slice(5))).toEqual([-20, -20, -20, -20, -20]);
  });

  it("looks for the mouth in the bottom of the face box, and picks the longest face and the nearest box", () => {
    const box = { time: 1, x: 0.5, y: 0.4, width: 0.4, height: 0.5, score: 1 };
    expect(mouthPixels(box, 100, 100)).toEqual({ x0: 36, x1: 64, y0: 45, y1: 65 });
    expect(mouthViewSize(1920, 1080)).toEqual({ width: 192, height: 108 });
    const track = (id: string, start: number, end: number) => ({ id, start, end, boxes: [{ ...box, time: start }, { ...box, time: end, x: 0.7 }], embeddings: [] });
    expect(longestTrack([track("t1", 0, 3), track("t2", 1, 9)])!.id).toBe("t2");
    expect(longestTrack([])).toBeNull();
    expect(boxAt(track("t1", 0, 10), 8).x).toBe(0.7);
    expect(boxAt(track("t1", 0, 10), 2).x).toBe(0.5);
  });
});

describe("correlation", () => {
  it("correlates a series with the other one shifted, and prefers the smaller shift on a tie", () => {
    const a = [0, 0, 1, 0, 0, 3, 0, 0, 0, 2, 0, 0];
    const b = [0, 0, 0, 0, 1, 0, 0, 3, 0, 0, 0, 2];
    const range = { from: 0, to: 12 };
    expect(bestLag(a, b, 4, range, range)).toMatchObject({ lag: -2 });
    expect(correlationAtLag(a, b, -2, range, range, 2)!).toBeGreaterThan(0.9);
    expect(correlationAtLag(a, b, 0, range, range, 100)).toBeNull();
    expect(correlationAtLag([1, 1, 1, 1], [1, 2, 3, 4], 0, { from: 0, to: 4 }, { from: 0, to: 4 })).toBeNull();
  });
});

describe("alignment", () => {
  /** 30 fps activity of `seconds` seconds with a spike every time in `spikes` (seconds). */
  function activity(seconds: number, spikes: number[]): Float32Array {
    const out = new Float32Array(seconds * 30);
    for (const spike of spikes) for (let i = 0; i < 6; i++) out[Math.round(spike * 30) + i] = 10 - i;
    return out;
  }

  it("resamples to 20 Hz", () => {
    const grid = activityGrid(new Float32Array(30).fill(2), 30);
    expect(grid).toHaveLength(ALIGN_HZ);
    expect(Array.from(grid).every((value) => value === 2)).toBe(true);
  });

  it("finds that the reference is a second later, to 50 ms", () => {
    const spikes = [3, 5.5, 7, 11, 12, 16];
    const film = activityGrid(activity(20, spikes), 30);
    const reference = activityGrid(activity(22, spikes.map((spike) => spike + 1)), 30);
    const found = alignFilms(film, reference, 3);
    expect(found).toMatchObject({ lag: 1, source: "activity" });
    expect(found.correlation!).toBeGreaterThan(0.9);
    expect(alignFilms(reference, film, 3).lag).toBe(-1);
  });

  it("takes a forced lag, and gives up on curves that do not match", () => {
    const film = activityGrid(activity(20, [3, 7, 12]), 30);
    expect(alignFilms(film, film, 3, 0.5)).toMatchObject({ lag: 0.5, source: "forced" });
    const flat = new Float64Array(400);
    expect(alignFilms(film, flat, 3)).toEqual({ lag: 0, source: "none", correlation: null });
    const other = activityGrid(activity(20, [1.2, 4.1, 9.4, 14.3]), 30);
    expect(alignFilms(film, other, 1).source).toBe("none");
  });

  it("matches the stretch both films have, and reads the energy of each in it", () => {
    expect(matchedStretch(10, 12, 1)).toEqual({ from: 0, to: 10 });
    expect(matchedStretch(10, 12, -1.5)).toEqual({ from: 1.5, to: 10 });
    expect(matchedStretch(10, 8, 1)).toEqual({ from: 0, to: 7 });
    const steady = new Float32Array(300).fill(2);
    steady.fill(8, 150, 180);
    expect(energyOf(steady, 30, 0, 10)).toEqual({ mean: 2.6, p95: 8 });
    expect(energyOf(steady, 30, 20, 30)).toEqual({ mean: 0, p95: 0 });
    const windows = energyWindows({ activity: steady, fps: 30 }, { activity: new Float32Array(300).fill(1), fps: 30 }, 1, 0, 3, 1);
    expect(windows).toEqual([{ at: 0, film: 2, reference: 1 }, { at: 1, film: 2, reference: 1 }, { at: 2, film: 2, reference: 1 }]);
    expect(windowStep(30)).toBe(1);
    expect(windowStep(3600)).toBe(6);
  });
});

describe("ssim readings and snapshots", () => {
  it("reads the stats file of ffmpeg's ssim filter at the matched times", () => {
    const text = ["n:1 Y:1.000000 U:1.000000 V:1.000000 All:1.000000 (inf)", "n:2 Y:0.5 U:0.5 V:0.5 All:0.512345 (3.1)", "n:3 Y:0 U:0 V:0 All:nan (0)", "garbage"].join("\n");
    expect(parseSsim(text, 2, 0.5, 1)).toEqual([
      { at: 2, referenceAt: 3, ssim: 1 },
      { at: 2.5, referenceAt: 3.5, ssim: 0.512 },
    ]);
  });

  it("picks the lowest readings, far from each other, and fills with evenly spread ones", () => {
    const samples = Array.from({ length: 40 }, (_, i) => ({ at: i * 0.5, referenceAt: i * 0.5, ssim: i === 10 || i === 11 ? 0.1 : i === 30 ? 0.2 : 0.9 }));
    const picked = pickSnapshots(samples, 6, 1);
    expect(picked).toHaveLength(6);
    expect(picked.map((sample) => sample.at)).toEqual([...picked.map((sample) => sample.at)].sort((a, b) => a - b));
    // The two lowest are 0.5 s apart: only one of them is picked, and the one at 15 s joins it.
    expect(picked.filter((sample) => sample.ssim <= 0.2).map((sample) => sample.at)).toEqual([5, 15]);
    expect(new Set(picked.map((sample) => sample.at)).size).toBe(6);
    expect(pickSnapshots(samples.slice(0, 3), 6, 1)).toHaveLength(3);
  });
});

describe("labels", () => {
  it("names the most specific key that covers a path", () => {
    expect(labelOf(ANALYZE_RESULT_LABELS, "shots[3].look.grid")).toBe("MEASURED");
    expect(labelOf(ANALYZE_RESULT_LABELS, "shots[3].ink.region.x")).toBe("ESTIMATED");
    expect(labelOf(ANALYZE_RESULT_LABELS, "curve.moves[0].ease")).toBe("ESTIMATED");
    expect(labelOf(ANALYZE_RESULT_LABELS, "curve.moves[0].start")).toBe("MEASURED");
    expect(labelOf(ANALYZE_RESULT_LABELS, "sync.offset")).toBe("ESTIMATED");
    expect(labelOf(ANALYZE_RESULT_LABELS, "sync.reason")).toBe("MEASURED");
    expect(labelOf(ANALYZE_RESULT_LABELS, "nothing.like.it")).toBeNull();
    expect(labelOf(ANALYZE_DIFF_LABELS, "alignment.lag")).toBe("ESTIMATED");
    expect(labelOf(ANALYZE_DIFF_LABELS, "alignment.source")).toBe("MEASURED");
  });
});
