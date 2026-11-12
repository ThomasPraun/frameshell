import { describe, expect, it } from "vitest";
import { CELLS, cellStats, elementEvents, flashes, hitEvents, holds, soundHits } from "../src/analyze/events.js";
import { LOOK_COLUMNS, LOOK_ROWS, LookBuilder, cellOf, frameLook } from "../src/analyze/look.js";
import { slidingMedians } from "../src/analyze/median.js";
import { pictureSize } from "../src/analyze/picture.js";
import { bigChanges, bursts, lengthCv, rhythmOf, stillRuns } from "../src/analyze/rhythm.js";
import { shotLocator } from "../src/analyze/shots.js";

// The pure parts of `analyze` slice 2 (#471): look, rhythm and events from per-frame series.

/** Interleaved RGB of a `width` x `height` frame of one colour, with `paint(x, y)` optionally replacing a pixel. */
function frame(width: number, height: number, color: [number, number, number], paint?: (x: number, y: number) => [number, number, number] | null): Uint8Array {
  const rgb = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) rgb.set(paint?.(x, y) ?? color, (y * width + x) * 3);
  }
  return rgb;
}

describe("look", () => {
  it("reads black, white and a saturated warm frame", () => {
    expect(frameLook(frame(8, 6, [0, 0, 0]), 8, 6)).toEqual({ brightness: 0, contrast: 0, saturation: 0, warmth: 0 });
    const white = frameLook(frame(8, 6, [255, 255, 255]), 8, 6);
    expect(white.brightness).toBeCloseTo(1, 6);
    expect(white.contrast).toBeCloseTo(0, 6);
    expect([white.saturation, white.warmth]).toEqual([0, 0]);
    const red = frameLook(frame(8, 6, [255, 0, 0]), 8, 6);
    expect(red.saturation).toBe(1);
    expect(red.warmth).toBe(1);
    expect(red.brightness).toBeCloseTo(0.2126, 4);
    expect(frameLook(frame(8, 6, [0, 0, 255]), 8, 6).warmth).toBe(-1);
  });

  it("gives half black and half white the contrast 0.5", () => {
    const look = frameLook(frame(8, 6, [0, 0, 0], (x) => (x >= 4 ? [255, 255, 255] : null)), 8, 6);
    expect(look.brightness).toBeCloseTo(0.5, 5);
    expect(look.contrast).toBeCloseTo(0.5, 5);
  });

  it("puts every pixel in one of 8 x 6 cells whatever the frame's shape", () => {
    for (const [w, h] of [[64, 36], [36, 64], [8, 6]] as const) {
      const counts = new Array<number>(LOOK_COLUMNS * LOOK_ROWS).fill(0);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) counts[cellOf(x, y, w, h)]!++;
      expect(counts.every((count) => count > 0)).toBe(true);
      expect(counts.reduce((a, b) => a + b, 0)).toBe(w * h);
    }
    expect(cellOf(0, 0, 64, 36)).toBe(0);
    expect(cellOf(63, 35, 64, 36)).toBe(47);
    expect(cellOf(63, 0, 64, 36)).toBe(7);
  });

  it("averages frames and lays the mean colour of each cell on the grid", () => {
    const builder = new LookBuilder();
    expect(builder.look()).toBeNull();
    // Left half red, right half blue, two frames; one more frame all black halves the means.
    const split = frame(16, 12, [0, 0, 255], (x) => (x < 8 ? [255, 0, 0] : null));
    builder.add(split, 16, 12);
    builder.add(split, 16, 12);
    const look = builder.look()!;
    expect(look.grid).toHaveLength(48);
    expect(look.grid[0]).toBe("#ff0000");
    expect(look.grid[3]).toBe("#ff0000");
    expect(look.grid[4]).toBe("#0000ff");
    expect(look.grid[47]).toBe("#0000ff");
    expect(look.warmth).toBe(0);
    builder.add(frame(16, 12, [0, 0, 0]), 16, 12);
    expect(builder.frames).toBe(3);
    expect(builder.look()!.grid[0]).toBe("#aa0000");
  });

  it("measures the frames at 64 px on the long side", () => {
    expect(pictureSize(1920, 1080)).toEqual({ width: 64, height: 36 });
    expect(pictureSize(1080, 1920)).toEqual({ width: 36, height: 64 });
    expect(pictureSize(100, 100)).toEqual({ width: 64, height: 64 });
    expect(pictureSize(4000, 10)).toEqual({ width: 64, height: 6 });
  });
});

describe("shotLocator", () => {
  it("finds the shot a frame is in", () => {
    const at = shotLocator([{ startFrame: 0 }, { startFrame: 30 }, { startFrame: 75 }]);
    expect([0, 29, 30, 74, 75, 500].map(at)).toEqual([0, 0, 1, 1, 2, 2]);
  });
});

describe("rhythm", () => {
  it("lengthCv is the spread of the lengths over their mean", () => {
    expect(lengthCv([])).toBe(0);
    expect(lengthCv([90])).toBe(0);
    expect(lengthCv([30, 30, 30])).toBe(0);
    // Mean 20, deviations 10 and 10.
    expect(lengthCv([10, 30])).toBe(0.5);
  });

  it("stillRuns reports the held picture from its first frame", () => {
    const activity = [0, 0, 0, 9, 0, 0, 9, 0, 0, 0, 0];
    expect(stillRuns(activity, 1)).toEqual([{ startFrame: 0, endFrame: 3 }, { startFrame: 3, endFrame: 6 }, { startFrame: 6, endFrame: 11 }]);
    expect(stillRuns(activity, 5)).toEqual([{ startFrame: 6, endFrame: 11 }]);
  });

  it("bigChanges takes frames 4x their surroundings (at least 1 level) or 15 % of the grey range, once per run, and every cut", () => {
    const activity = new Array<number>(100).fill(0.1);
    activity[10] = 20;
    activity[11] = 30;
    activity[40] = 0.9;
    activity[60] = 1;
    // A busy stretch: 3x its surroundings is not big, 4x is.
    for (let i = 85; i < 100; i++) activity[i] = 5;
    activity[90] = 15;
    activity[95] = 21;
    const changes = bigChanges(activity, [11, 80], 10);
    expect(changes.map((change) => change.frame)).toEqual([11, 60, 80, 95]);
    expect(changes.map((change) => change.score)).toEqual([30, 1, 0.1, 21]);
  });

  it("bigChanges needs 15 % of the grey range where the picture always moves", () => {
    const activity = new Array<number>(100).fill(12);
    activity[30] = 38;
    activity[50] = 38.25;
    expect(bigChanges(activity, [], 10).map((change) => change.frame)).toEqual([50]);
  });

  it("bursts need 3 big changes within 1.5 s and join overlapping ones", () => {
    const changes = (frames: number[]) => frames.map((frame) => ({ frame, score: 10 }));
    // 30 fps: 1.5 s is 45 frames.
    expect(bursts(changes([0, 40, 100, 200]), 30)).toEqual([]);
    expect(bursts(changes([0, 20, 40, 300]), 30)).toEqual([{ startFrame: 0, endFrame: 41, start: 0, end: 1.366, count: 3 }]);
    // 0, 20, 40 and 60, 80: the windows from 0 and from 20 overlap, so one burst of 5.
    expect(bursts(changes([0, 20, 40, 60, 80, 500]), 30)).toMatchObject([{ startFrame: 0, endFrame: 81, count: 5 }]);
    expect(bursts(changes([0, 10, 20, 400, 410, 420]), 30)).toHaveLength(2);
  });

  it("rhythmOf puts a film's figures together", () => {
    // 10 s at 10 fps: still except big changes at frames 20, 50 and 55, 60.
    const activity = new Array<number>(100).fill(0);
    for (const frame of [20, 50, 55, 60]) activity[frame] = 40;
    const { rhythm, changes } = rhythmOf(activity, 10, [20, 30, 50], [20, 50]);
    expect(changes.map((change) => change.frame)).toEqual([20, 50, 55, 60]);
    expect(rhythm.shotLengthCv).toBeCloseTo(0.374, 3);
    expect(rhythm.changeCount).toBe(4);
    expect(rhythm.changesPerMinute).toBe(24);
    // Frames 1..99 are 99 frames, 4 of them move.
    expect(rhythm.stillShare).toBe(0.96);
    expect(rhythm.longestStill).toBe(4);
    expect(rhythm.largestGap).toBe(4);
    expect(rhythm.meanActivity).toBe(1.62);
    expect(rhythm.bursts).toMatchObject([{ startFrame: 50, endFrame: 61, count: 3 }]);
  });
});

describe("flashes", () => {
  const series = (length: number, fill: number, set: Record<number, number> = {}) => Float32Array.from({ length }, (_, i) => set[i] ?? fill);

  it("finds a bright flash of a few frames, with its size", () => {
    const events = flashes(series(100, 0.3, { 40: 0.9, 41: 0.9, 42: 0.9 }), 30);
    expect(events).toEqual([{ kind: "flash", startFrame: 40, endFrame: 43, start: 1.333, end: 1.433, direction: "up", amount: 0.6 }]);
  });

  it("finds a dark dip too", () => {
    expect(flashes(series(100, 0.6, { 20: 0.1 }), 30)).toMatchObject([{ startFrame: 20, endFrame: 21, direction: "down", amount: 0.5 }]);
  });

  it("ignores a small change, a long one and a cut to a brighter shot", () => {
    expect(flashes(series(100, 0.3, { 40: 0.4 }), 30)).toEqual([]);
    const long = Array.from({ length: 100 }, (_, i) => (i >= 30 && i < 50 ? 0.9 : 0.3));
    expect(flashes(long, 30)).toEqual([]);
    const cut = Array.from({ length: 100 }, (_, i) => (i >= 50 ? 0.9 : 0.3));
    expect(flashes(cut, 30)).toEqual([]);
  });
});

describe("holds", () => {
  it("lists still stretches of half a second or more", () => {
    const activity = new Array<number>(120).fill(0);
    activity[30] = 20;
    activity[40] = 20;
    // Frames 0-30 hold 30 frames (1 s), 30-40 only 10 frames, 40-120 hold 80 frames.
    expect(holds(activity, 30)).toEqual([
      { kind: "hold", startFrame: 0, endFrame: 30, start: 0, end: 1 },
      { kind: "hold", startFrame: 40, endFrame: 120, start: 1.333, end: 4 },
    ]);
  });
});

/** A `frames`-long series of cells where `paint(frame, cell)` gives the luma and detail of a cell. */
function cellSeries(frames: number, paint: (frame: number, cell: number) => { luma: number; detail: number }) {
  const cellLuma = new Float32Array(frames * CELLS);
  const cellDetail = new Float32Array(frames * CELLS);
  for (let f = 0; f < frames; f++) {
    for (let c = 0; c < CELLS; c++) {
      const { luma, detail } = paint(f, c);
      cellLuma[f * CELLS + c] = luma;
      cellDetail[f * CELLS + c] = detail;
    }
  }
  return { frames, cellLuma, cellDetail };
}

describe("elementEvents", () => {
  // A box over columns 5-7 and rows 0-2 that shows between frames 20 and 60.
  const inBox = (cell: number) => cell % LOOK_COLUMNS >= 5 && Math.floor(cell / LOOK_COLUMNS) <= 2;
  const withBox = (frame: number, cell: number) => (inBox(cell) && frame >= 20 && frame < 60 ? { luma: 220, detail: 10 } : { luma: 60, detail: 1 });

  it("finds an element coming and going, with the box around it", () => {
    const events = elementEvents(cellSeries(100, withBox), [], 30);
    expect(events).toEqual([
      { kind: "appear", startFrame: 20, endFrame: 21, start: 0.666, end: 0.7, area: 0.188, region: { x: 0.625, y: 0, width: 0.375, height: 0.5 } },
      { kind: "disappear", startFrame: 60, endFrame: 61, start: 2, end: 2.033, area: 0.188, region: { x: 0.625, y: 0, width: 0.375, height: 0.5 } },
    ]);
  });

  it("follows an element that fades in over several frames", () => {
    const fade = (frame: number, cell: number) => (inBox(cell) ? { luma: 60 + Math.min(160, Math.max(0, frame - 20) * 20), detail: 1 + Math.min(9, Math.max(0, frame - 20)) } : { luma: 60, detail: 1 });
    const events = elementEvents(cellSeries(60, fade), [], 30);
    expect(events).toMatchObject([{ kind: "appear", startFrame: 21, endFrame: 29 }]);
  });

  it("ignores a change of the whole picture, a cut, and motion that goes on", () => {
    const wholesale = (frame: number) => ({ luma: frame < 30 ? 60 : 220, detail: 1 });
    expect(elementEvents(cellSeries(60, (frame) => wholesale(frame)), [], 30)).toEqual([]);
    expect(elementEvents(cellSeries(100, withBox), [20, 60], 30)).toEqual([]);
    const drift = (frame: number, cell: number) => (inBox(cell) ? { luma: 60 + frame * 4, detail: 1 } : { luma: 60, detail: 1 });
    expect(elementEvents(cellSeries(100, drift), [], 30)).toEqual([]);
  });

  it("cellStats reads a grey frame's cells: mean level and detail", () => {
    const width = 16;
    const height = 12;
    const grey = new Uint8Array(width * height).fill(100);
    for (let y = 0; y < height; y++) for (let x = 8; x < width; x++) grey[y * width + x] = 200;
    const luma = new Float32Array(CELLS);
    const detail = new Float32Array(CELLS);
    cellStats(grey, width, height, luma, detail);
    expect(luma[0]).toBe(100);
    expect(luma[7]).toBe(200);
    // The step between column 3 (x 6-7) and column 4 (x 8-9) is in the pixels at x = 7: 100 grey levels over 2 x 2 pixels of a cell.
    expect(detail[3]).toBe(50);
    expect(detail[0]).toBe(0);
    expect(detail[7]).toBe(0);
  });
});

describe("sound hits", () => {
  const quiet = -90;
  /** `seconds` of envelope at 10 ms hops, quiet, with a 100 ms burst at each of `at` seconds peaking at `level`. */
  function envelope(seconds: number, bursts: [number, number][]): Float32Array {
    const db = new Float32Array(seconds * 100).fill(quiet);
    for (const [at, level] of bursts) for (let i = 0; i < 10; i++) db[Math.round(at * 100) + i] = level - i * 2;
    return db;
  }

  it("finds the onset of each burst with its rise and peak", () => {
    const hits = soundHits(envelope(5, [[1, -10], [2, -20]]));
    expect(hits).toEqual([
      { time: 1, rise: 80, level: -10 },
      { time: 2, rise: 70, level: -20 },
    ]);
  });

  it("ignores a rise that stays quiet, a small rise on a loud bed, and a second hit inside 150 ms", () => {
    expect(soundHits(envelope(3, [[1, -55]]))).toEqual([]);
    const bed = new Float32Array(300).fill(-20);
    for (let i = 100; i < 110; i++) bed[i] = -14;
    expect(soundHits(bed)).toEqual([]);
    expect(soundHits(envelope(3, [[1, -10], [1.08, -10]])).map((hit) => hit.time)).toEqual([1]);
  });

  it("places a hit on a frame and measures its offset to the nearest big change within 0.2 s", () => {
    const hits = [{ time: 2.01, rise: 40, level: -12 }, { time: 5, rise: 30, level: -20 }, { time: 7.0, rise: 30, level: -20 }];
    // 30 fps: frame 60 is 2.0 s; 150 is 5.0 s; 205 is 6.833 s, 0.167 s before the third hit.
    const events = hitEvents(hits, [60, 205], 30, 300);
    expect(events).toEqual([
      { kind: "hit", startFrame: 60, endFrame: 61, start: 2, end: 2.033, amount: 40, level: -12, offset: 0 },
      { kind: "hit", startFrame: 150, endFrame: 151, start: 5, end: 5.033, amount: 30, level: -20, offset: null },
      { kind: "hit", startFrame: 210, endFrame: 211, start: 7, end: 7.033, amount: 30, level: -20, offset: 0.167 },
    ]);
    // The hit before the change has a negative offset.
    expect(hitEvents([{ time: 1.9, rise: 30, level: -20 }], [60], 30, 300)[0]!.offset).toBe(-0.1);
  });

  it("leaves out a hit past the last frame of the picture", () => {
    expect(hitEvents([{ time: 9.99, rise: 30, level: -20 }, { time: 10, rise: 30, level: -20 }], [], 30, 300).map((event) => event.startFrame)).toEqual([299]);
  });
});

describe("slidingMedians", () => {
  it("matches the median of each clipped window", () => {
    const values = Array.from({ length: 60 }, (_, i) => (i * 37) % 11 + (i % 3) * 0.5);
    for (const half of [1, 4, 100]) {
      const expected = values.map((_, i) => {
        const window = values.slice(Math.max(0, i - half), i + half + 1).sort((a, b) => a - b);
        return window[Math.floor(window.length / 2)]!;
      });
      expect(Array.from(slidingMedians(values, half))).toEqual(expected);
    }
  });
});
