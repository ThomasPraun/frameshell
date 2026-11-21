import { describe, expect, it } from "vitest";
import { type PointerSample, pointerFileOf } from "@frameshell/schema";
import { ZOOM, planZoom, pointerRests, zoomPlacement } from "../src/index.js";

const GEOMETRY = { source: { width: 1920, height: 1080 }, project: { width: 1920, height: 1080 } };
const BASE = { scale: 1, x: 0, y: 0 };

/** 20 Hz samples: the pointer still on each stop over `[from, to)`, darting about between stops. */
function track(stops: { from: number; to: number; x: number; y: number }[]): PointerSample[] {
  const samples: PointerSample[] = [];
  const end = stops[stops.length - 1]!.to;
  for (let i = 0; i * 0.05 < end - 1e-9; i++) {
    const t = Math.round(i * 50) / 1000;
    const stop = stops.find((candidate) => t >= candidate.from && t < candidate.to);
    samples.push(stop ? [t, stop.x, stop.y] : [t, (i * 0.37) % 1, 0.5]);
  }
  return samples;
}

describe("pointerFileOf", () => {
  it("names the hidden sidecar next to the file", () => {
    expect(pointerFileOf("assets/shoot/20261121-101500/screen.webm")).toBe("assets/shoot/20261121-101500/.screen.pointer.json");
    expect(pointerFileOf("demo.mp4")).toBe(".demo.pointer.json");
  });
});

describe("pointerRests", () => {
  it("finds stops of 0.8 s or more and ignores quick moves and off-screen samples", () => {
    const samples = track([
      { from: 0, to: 0.4, x: 0.1, y: 0.1 },
      { from: 1, to: 3, x: 0.8, y: 0.2 },
      { from: 4, to: 4.5, x: 0.3, y: 0.7 },
      { from: 5, to: 7, x: 0.3, y: 0.7 },
    ]);
    const off = samples.map(([t, x, y]): PointerSample => (t >= 5.5 && t < 6 ? [t, 1.4, y] : [t, x, y]));
    const rests = pointerRests(off, { from: 0, to: 10 }, 16 / 9);
    expect(rests.map((rest) => [rest.from, rest.to, Math.round(rest.x * 100) / 100])).toEqual([
      [1, 2.95, 0.8],
      [6, 6.95, 0.3],
    ]);
  });
});

describe("zoomPlacement", () => {
  it("centers the spot and never shows past the picture's edge", () => {
    expect(zoomPlacement(GEOMETRY, 2, { x: 0.5, y: 0.5 })).toEqual({ scale: 2, x: 0, y: 0 });
    // A quarter in from the left, at 2x: the picture moves right by half the frame, its left edge on the frame's.
    expect(zoomPlacement(GEOMETRY, 2, { x: 0.25, y: 0.5 })).toEqual({ scale: 2, x: 960, y: 0 });
    // The very corner clamps to the same limit.
    expect(zoomPlacement(GEOMETRY, 2, { x: 0, y: 0 })).toEqual({ scale: 2, x: 960, y: 540 });
  });
});

describe("planZoom", () => {
  const span = { from: 0, to: 20, toTimeline: (source: number) => 10 + source };

  it("pushes in before a rest, holds, and eases back after it", () => {
    const plan = planZoom(GEOMETRY, track([{ from: 0, to: 2, x: 0.05, y: 0.95 }, { from: 4.5, to: 6.55, x: 0.5, y: 0.5 }, { from: 9, to: 12, x: 0.05, y: 0.95 }]), span, { scale: 2, base: BASE });
    expect(plan.rests).toBe(3);
    // The first rest starts at 0, so its zoom starts at the clip's start; each zoom is its own.
    expect(plan.zooms).toBe(3);
    expect(plan.keys[0]).toMatchObject({ time: 10, scale: 1 });
    const second = plan.keys.filter((key) => key.time >= 13 && key.time <= 18);
    const round = (t: number) => Math.round(t * 1000) / 1000;
    expect(second.map((key) => key.time)).toEqual([round(14.5 - ZOOM.lead - ZOOM.ramp), round(14.5 - ZOOM.lead), round(16.5 + ZOOM.tail), round(16.5 + ZOOM.tail + ZOOM.ramp)]);
    expect(second.map((key) => key.scale)).toEqual([1, 2, 2, 1]);
    expect(second.map((key) => key.ease)).toEqual(["in-out", undefined, "in-out", undefined]);
  });

  it("keeps close rests in one zoom that glides between them", () => {
    const plan = planZoom(GEOMETRY, track([{ from: 1, to: 3, x: 0.25, y: 0.5 }, { from: 3.6, to: 5, x: 0.75, y: 0.5 }]), span, { scale: 2, base: BASE });
    expect(plan).toMatchObject({ rests: 2, zooms: 1 });
    expect(plan.keys.map((key) => key.x)).toEqual([0, 960, 960, -960, -960, 0]);
    expect(plan.keys.map((key) => key.scale)).toEqual([1, 2, 2, 2, 2, 1]);
  });

  it("writes nothing when the pointer never rests", () => {
    const samples: PointerSample[] = Array.from({ length: 200 }, (_, i) => [i * 0.05, (i % 20) / 20, 0.5]);
    expect(planZoom(GEOMETRY, samples, span, { scale: 2, base: BASE })).toEqual({ keys: [], zooms: 0, rests: 0 });
  });

  it("zooms over the clip's own scale and stays inside its stretch of the file", () => {
    const plan = planZoom(GEOMETRY, track([{ from: 5, to: 8, x: 0.5, y: 0.5 }]), { from: 6, to: 12, toTimeline: (source) => source - 6 }, { scale: 1.5, base: { scale: 1.2, x: 0, y: 0 } });
    expect(plan.keys[0]).toMatchObject({ time: 0, scale: 1.2 });
    expect(plan.keys[1]).toMatchObject({ scale: 1.8 });
  });
});
