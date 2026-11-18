import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { CHART_COLOURS, speedChart } from "../src/review/chart.js";
import { ONION_OPACITY, onionBlend } from "../src/review/images.js";
import { alphaMass } from "../src/review/placement.js";
import { MAX_ONION_FRAMES, cutPicks, onionPicks, popPicks, sheetLayout } from "../src/review/plan.js";
import { type HeroSample, spansOf, speedOf } from "../src/review/speed.js";
import { encodeGrayPng, encodeRgbPng } from "../src/segment/png.js";

const range = (first: number, end: number) => ({ first, end });

describe("review cuts sheet picks", () => {
  it("shows five frames around every cut inside the range, one row each, named by cut and offset", () => {
    const { picks, cuts, dropped } = cutPicks(10, range(0, 100), [50, 30, 30, 0, 100]);
    expect(cuts).toBe(2);
    expect(dropped).toBe(0);
    expect(picks.map((pick) => pick.frame)).toEqual([28, 29, 30, 31, 32, 48, 49, 50, 51, 52]);
    expect(picks.every((pick) => pick.tag === "cut")).toBe(true);
    expect(picks.slice(0, 5).map((pick) => pick.name)).toEqual(["cut 1 -0.2", "cut 1 -0.1", "cut 1 0", "cut 1 +0.1", "cut 1 +0.2"]);
    expect(sheetLayout("cuts", 16 / 9).columns).toBe(5);
  });

  it("clamps the frames to the range and repeats the edge frame, so every cut keeps its five tiles", () => {
    const { picks } = cutPicks(10, range(0, 100), [99]);
    expect(picks.map((pick) => [pick.frame, pick.name])).toEqual([
      [97, "cut 1 -0.2"],
      [98, "cut 1 -0.1"],
      [99, "cut 1 0"],
      [99, "cut 1 +0.1"],
      [99, "cut 1 +0.2"],
    ]);
  });

  it("starts the cut after a clamped one on the next row", () => {
    const { picks } = cutPicks(30, range(0, 300), [3, 150]);
    expect(picks).toHaveLength(10);
    expect(picks.slice(0, 5).map((pick) => pick.frame)).toEqual([0, 0, 3, 6, 9]);
    expect(picks[5]!.name).toBe("cut 2 -0.2");
    expect(picks.slice(5).every((pick) => pick.name.startsWith("cut 2 "))).toBe(true);
  });

  it("at a low frame rate an offset rounded onto the cut repeats its frame", () => {
    const { picks } = cutPicks(5, range(0, 100), [50]);
    expect(picks.map((pick) => [pick.frame, pick.name])).toEqual([
      [49, "cut 1 -0.2"],
      [50, "cut 1 -0.1"],
      [50, "cut 1 0"],
      [51, "cut 1 +0.1"],
      [51, "cut 1 +0.2"],
    ]);
  });

  it("over 120 tiles keeps 24 cuts spread evenly, with their numbers, and counts the rest", () => {
    const many = Array.from({ length: 30 }, (_, i) => 10 + i * 10);
    const { picks, cuts, dropped } = cutPicks(10, range(0, 400), many);
    expect(cuts).toBe(30);
    expect(dropped).toBe(6);
    expect(picks).toHaveLength(120);
    const numbers = new Set(picks.map((pick) => Number(pick.name.split(" ")[1])));
    expect(numbers.size).toBe(24);
    expect(numbers.has(30)).toBe(true);
  });
});

describe("review pop and onion picks", () => {
  it("pop: the frame before and the frame itself; none at frame 0 or past the end", () => {
    expect(popPicks(90, 15)).toEqual([
      { frame: 14, tag: "pop" },
      { frame: 15, tag: "pop" },
    ]);
    expect(popPicks(90, 0)).toBeNull();
    expect(popPicks(90, 90)).toBeNull();
  });

  it("onion: at most 24 frames spread evenly, first and last included", () => {
    const picks = onionPicks(range(10, 110));
    expect(picks).toHaveLength(MAX_ONION_FRAMES);
    expect(picks[0]!.frame).toBe(10);
    expect(picks.at(-1)!.frame).toBe(109);
    expect(picks.every((pick) => pick.tag === "onion")).toBe(true);
    expect(onionPicks(range(0, 5)).map((pick) => pick.frame)).toEqual([0, 1, 2, 3, 4]);
    expect(onionPicks(range(3, 4))).toEqual([{ frame: 3, tag: "onion" }]);
  });

  it("onion blend: the still background, each moving part laid over at 25 %", () => {
    // A white dot crosses a 4-pixel grey line: pixel k is white in frame k.
    const frames = [0, 1, 2].map((k) => Uint8Array.from({ length: 12 }, (_, c) => (Math.floor(c / 3) === k ? 255 : 100)));
    const out = onionBlend(frames);
    const ghost = Math.round(100 + ONION_OPACITY * 155);
    expect(Array.from(out)).toEqual([ghost, ghost, ghost, ghost, ghost, ghost, ghost, ghost, ghost, 100, 100, 100]);
  });
});

/** Samples of a point moving along x as `position(frame)`, every frame from 0 to `frames`. */
const along = (frames: number, position: (frame: number) => number): HeroSample[] => Array.from({ length: frames + 1 }, (_, frame) => ({ frame, x: position(frame), y: 100, size: 50 }));

describe("review speed graph", () => {
  it("a linear ramp is one linear stretch over the whole move", () => {
    const intervals = speedOf(along(30, (frame) => 5 * frame));
    expect(intervals.every((interval) => Math.abs(interval.speed - 5) < 1e-9)).toBe(true);
    expect(spansOf(intervals)).toEqual([{ from: 0, to: 30, kind: "linear", speed: 5 }]);
  });

  it("an ease-out has no linear stretch and no stop", () => {
    expect(spansOf(speedOf(along(30, (frame) => 300 * (1 - (1 - frame / 30) ** 3))))).toEqual([]);
  });

  it("the in-out key ease (smoothstep) is eased, its flat middle included", () => {
    for (const frames of [27, 90]) {
      const smooth = (frame: number) => 480 * (frame / frames) ** 2 * (3 - 2 * (frame / frames));
      expect(spansOf(speedOf(along(frames, smooth))), `${frames} frames`).toEqual([]);
    }
  });

  it("a hold between two moves is a dead stop", () => {
    const position = (frame: number) => (frame <= 10 ? 5 * frame : frame <= 20 ? 50 : 50 + 5 * (frame - 20));
    const spans = spansOf(speedOf(along(30, position)));
    expect(spans.filter((span) => span.kind === "stop")).toEqual([{ from: 10, to: 20, kind: "stop", speed: 0 }]);
    expect(spans.filter((span) => span.kind === "linear").map((span) => [span.from, span.to])).toEqual([
      [0, 10],
      [20, 30],
    ]);
  });

  it("a hold at the end of a move is not a stop, and a pure zoom moves as fast as its edges", () => {
    const settle = spansOf(speedOf(along(30, (frame) => 300 * (1 - (1 - Math.min(1, frame / 20)) ** 3))));
    expect(settle.some((span) => span.kind === "stop")).toBe(false);
    const zoom = speedOf(Array.from({ length: 11 }, (_, frame) => ({ frame, x: 0, y: 0, size: 100 + 4 * frame })));
    expect(zoom.every((interval) => interval.speed === 2)).toBe(true);
  });

  it("samples several frames apart spread their speed over the frames between them", () => {
    const intervals = speedOf([
      { frame: 0, x: 0, y: 0, size: 10 },
      { frame: 4, x: 8, y: 0, size: 10 },
    ]);
    expect(intervals).toEqual([{ from: 0, to: 4, speed: 2 }]);
  });
});

describe("review alpha hero", () => {
  it("is the alpha-weighted centre of what a picture draws and the share it covers", () => {
    // 4x2 alpha: a full pixel at (1, 0) and a half one at (3, 1); faint alpha is no picture.
    const grey = Uint8Array.from([0, 255, 10, 0, 0, 0, 0, 128]);
    const mass = alphaMass(grey, 4, 2)!;
    expect(mass.x).toBeCloseTo((255 * 1.5 + 128 * 3.5) / 383 / 4, 6);
    expect(mass.y).toBeCloseTo((255 * 0.5 + 128 * 1.5) / 383 / 2, 6);
    expect(mass.area).toBeCloseTo(383 / 255 / 8, 6);
    expect(alphaMass(new Uint8Array(8), 4, 2)).toBeNull();
  });
});

describe("review speed chart", () => {
  it("draws the speed over the frames with the stretches shaded", () => {
    const intervals = speedOf(along(30, (frame) => 5 * frame));
    const chart = speedChart(intervals, [{ from: 0, to: 30, kind: "linear", speed: 5 }], { first: 0, end: 30 }, 200, 80);
    expect(chart.pixels).toHaveLength(200 * 80 * 3);
    const at = (x: number, y: number) => Array.from(chart.pixels.subarray((y * 200 + x) * 3, (y * 200 + x) * 3 + 3));
    expect(at(0, 0)).toEqual([...CHART_COLOURS.background]);
    expect(at(100, 30)).toEqual([...CHART_COLOURS.linear]);
    // The constant speed is a flat line near the top of the plot.
    const column = Array.from({ length: 80 }, (_, y) => at(100, y));
    expect(column.some((pixel) => pixel.join() === CHART_COLOURS.line.join())).toBe(true);
  });
});

describe("PNG encoders", () => {
  /** Header fields and the unfiltered rows of a PNG this encoder wrote. */
  const read = (png: Buffer) => {
    const width = png.readUInt32BE(16);
    const height = png.readUInt32BE(20);
    const colour = png[25]!;
    const length = png.readUInt32BE(33);
    const rows = inflateSync(png.subarray(41, 41 + length));
    return { width, height, colour, rows };
  };

  it("encodes RGB rows that read back byte for byte", () => {
    const pixels = Uint8Array.from({ length: 3 * 2 * 3 }, (_, i) => (i * 37) % 256);
    const { width, height, colour, rows } = read(encodeRgbPng(pixels, 3, 2));
    expect([width, height, colour]).toEqual([3, 2, 2]);
    expect(rows[0]).toBe(0);
    expect(Array.from(rows.subarray(1, 10))).toEqual(Array.from(pixels.subarray(0, 9)));
    expect(Array.from(rows.subarray(11, 20))).toEqual(Array.from(pixels.subarray(9, 18)));
    expect(() => encodeRgbPng(pixels, 4, 2)).toThrow("encodeRgbPng: 18 bytes for 4x2");
  });

  it("still encodes grey", () => {
    expect(read(encodeGrayPng(new Uint8Array(4), 2, 2)).colour).toBe(0);
  });
});
