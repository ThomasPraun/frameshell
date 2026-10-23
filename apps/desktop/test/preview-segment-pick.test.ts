import type { SegmentedPoint } from "@frameshell/protocol";
import { describe, expect, it } from "vitest";
import type { Program } from "../src/renderer/src/preview/program.js";
import { isPhotoAt, photoAssets, steppedPoints, steppedSegment } from "../src/renderer/src/preview/segment-pick.js";
import type { SelectedPoint } from "../src/renderer/src/selection.js";

const placement = { x: 0, y: 0, scale: 1, opacity: 1 };
const program = {
  layers: [
    [{ kind: "still", clip: "c_a", start: 0, end: 30, image: "assets/a.jpg", version: "", size: { width: 10, height: 10 }, placement }],
    [
      { kind: "still", clip: "c_b", start: 0, end: 30, image: "assets/a.jpg", version: "", size: { width: 10, height: 10 }, placement },
      { kind: "generated", clip: "c_g", start: 30, end: 60, type: "hyperframes" },
    ],
  ],
} as unknown as Program;

const mask = (n: number) => ({
  mask: `.frameshell/context/m_${n}.png`,
  bbox: [0, 0, n, n] as [number, number, number, number],
  frameBox: [0, 0, n / 10, n / 10] as [number, number, number, number],
  area: n / 10,
  score: n / 10,
});
const segment: SegmentedPoint = { asset: "assets/a.jpg", size: { width: 10, height: 10 }, model: "mobilesam@x", chosen: 1, masks: [mask(1), mask(2), mask(3)] };
const point = (withSegment: boolean): SelectedPoint => ({ x: 0.5, y: 0.5, at: 0, layers: [], target: "c_a", elements: [], unavailable: null, ...(withSegment ? { segment } : {}) });

describe("photoAssets", () => {
  it("lists each photo once and skips generated clips", () => expect(photoAssets(program)).toEqual(["assets/a.jpg"]));
});

describe("isPhotoAt", () => {
  it("is true for a still clip in its span and false for generated clips or other frames", () => {
    expect(isPhotoAt(program, 5, "c_b")).toBe(true);
    expect(isPhotoAt(program, 40, "c_b")).toBe(false);
    expect(isPhotoAt(program, 40, "c_g")).toBe(false);
  });
});

describe("steppedSegment", () => {
  it("moves to a larger or smaller mask and stops at the ends", () => {
    expect(steppedSegment(segment, 1).chosen).toBe(2);
    expect(steppedSegment(segment, -1).chosen).toBe(0);
    expect(steppedSegment(steppedSegment(segment, 1), 1).chosen).toBe(2);
  });
});

describe("steppedPoints", () => {
  it("steps the last segmented point only", () => {
    const stepped = steppedPoints([point(true), point(false)], 1);
    expect(stepped?.[0]?.segment?.chosen).toBe(2);
    expect(stepped?.[1]?.segment).toBeUndefined();
  });
  it("is null with no segmented point or at the end of the range", () => {
    expect(steppedPoints([point(false)], 1)).toBeNull();
    expect(steppedPoints([{ ...point(true), segment: { ...segment, chosen: 2 } }], 1)).toBeNull();
  });
});
