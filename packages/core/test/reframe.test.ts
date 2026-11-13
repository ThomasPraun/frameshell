import { describe, expect, it } from "vitest";
import { layerRect } from "@frameshell/schema";
import { REFRAME_FACE_AT, type ReframePlacement, parseFrameFormat, planReframe, reframeBounds, reframePlacement, reframeTarget } from "../src/index.js";

const PROJECT = { width: 1080, height: 1920 };
const LANDSCAPE = { source: { width: 1920, height: 1080 }, project: PROJECT, format: { width: 9, height: 16 } };

const opaque = (placement: ReframePlacement) => ({ ...placement, opacity: 1 });

/** Where the point (`fx`, `fy`) of the picture lands in a 1080x1920 frame, in frame fractions, through the shared layer model. */
function landing(source: { width: number; height: number }, placement: ReframePlacement, fx: number, fy: number) {
  const rect = layerRect(source, PROJECT, PROJECT, opaque(placement));
  return { x: (rect.left + fx * rect.width) / PROJECT.width, y: (rect.top + fy * rect.height) / PROJECT.height, rect };
}

describe("parseFrameFormat", () => {
  it("reads 9x16 and 9:16, nothing else", () => {
    expect(parseFrameFormat("9x16")).toEqual({ width: 9, height: 16 });
    expect(parseFrameFormat(" 4:5 ")).toEqual({ width: 4, height: 5 });
    for (const bad of ["", "vertical", "0x16", "9x", "9x16x1", "-9x16"]) expect(parseFrameFormat(bad)).toBeNull();
  });
});

describe("reframeTarget", () => {
  const declared = [
    { id: "16x9", width: 1920, height: 1080 },
    { id: "9x16", width: 1080, height: 1920 },
    { id: "web-1600x900", width: 1600, height: 900 },
  ];

  it("takes a declared format other than the primary as that format's override, with its own aspect", () => {
    expect(reframeTarget("9x16", declared)).toEqual({ frame: { width: 1080, height: 1920 }, aspect: "9x16", format: "9x16" });
    expect(reframeTarget("web-1600x900", declared)).toEqual({ frame: { width: 1600, height: 900 }, aspect: "16x9", format: "web-1600x900" });
  });

  it("frames the clip itself for the primary, an aspect, or a project without formats", () => {
    expect(reframeTarget("16x9", declared)).toMatchObject({ aspect: "16x9", format: null });
    expect(reframeTarget("9:16", declared)).toEqual({ frame: { width: 9, height: 16 }, aspect: "9x16", format: null });
    expect(reframeTarget("8x10", [])).toMatchObject({ aspect: "4x5", format: null });
    expect(reframeTarget("vertical", declared)).toBeNull();
  });
});

describe("reframePlacement", () => {
  it("covers the vertical frame with a landscape picture and puts the face at the middle, 30 % from the top", () => {
    // A face at 40 % of the width: the picture shifts right of its centered place to bring it to the middle.
    const placement = reframePlacement(LANDSCAPE, { x: 0.4, y: 0.5 });
    const { rect, x, y } = landing(LANDSCAPE.source, placement, 0.4, 0.5);
    expect(x).toBeCloseTo(REFRAME_FACE_AT.x, 2);
    // The picture's height just covers the frame, so the face cannot rise to 30 %: the vertical clamp holds it at the middle.
    expect(y).toBeCloseTo(0.5, 2);
    expect(rect.left).toBeLessThanOrEqual(0);
    expect(rect.left + rect.width).toBeGreaterThanOrEqual(PROJECT.width);
    expect(rect.top).toBeLessThanOrEqual(0);
    expect(rect.top + rect.height).toBeGreaterThanOrEqual(PROJECT.height);
  });

  it("clamps at the picture's edge so the frame never shows outside it", () => {
    const left = reframePlacement(LANDSCAPE, { x: 0.02, y: 0.5 });
    const right = reframePlacement(LANDSCAPE, { x: 0.98, y: 0.5 });
    const { maxX } = reframeBounds(LANDSCAPE);
    expect(left.x).toBe(maxX);
    expect(right.x).toBe(-left.x);
    expect(landing(LANDSCAPE.source, left, 0, 0).rect.left).toBeLessThanOrEqual(0);
    expect(landing(LANDSCAPE.source, right, 0, 0).rect.left + landing(LANDSCAPE.source, right, 0, 0).rect.width).toBeGreaterThanOrEqual(PROJECT.width);
  });

  it("puts the face 30 % from the top when the picture is taller than the frame", () => {
    // 1:1 into 16:9 has height to spare.
    const geometry = { source: { width: 1000, height: 1000 }, project: { width: 1920, height: 1080 }, format: { width: 16, height: 9 } };
    const placement = reframePlacement(geometry, { x: 0.5, y: 0.45 });
    const rect = layerRect(geometry.source, geometry.project, geometry.project, opaque(placement));
    expect((rect.top + 0.45 * rect.height) / 1080).toBeCloseTo(0.3, 2);
    expect(rect.top).toBeLessThanOrEqual(0);
    expect(rect.top + rect.height).toBeGreaterThanOrEqual(1080);
  });

  it("leaves a picture already in the frame's aspect alone", () => {
    const geometry = { source: { width: 1080, height: 1920 }, project: PROJECT, format: { width: 9, height: 16 } };
    const placement = reframePlacement(geometry, { x: 0.3, y: 0.4 });
    // Only the 0.2 % headroom is left to move in.
    expect(Math.abs(placement.x)).toBeLessThan(2);
    expect(Math.abs(placement.y)).toBeLessThan(2);
    expect(placement.scale).toBeGreaterThanOrEqual(1);
    expect(placement.scale).toBeLessThan(1.003);
  });

  it("agrees with the layer model for a project in another aspect than the format (the export frame)", () => {
    // A 16:9 project, exported at 1080x1920: offsets are project pixels scaled per axis.
    const geometry = { source: { width: 1920, height: 1080 }, project: { width: 1920, height: 1080 }, format: { width: 9, height: 16 } };
    const placement = reframePlacement(geometry, { x: 0.3, y: 0.5 });
    const rect = layerRect(geometry.source, { width: 1080, height: 1920 }, geometry.project, opaque(placement));
    expect((rect.left + 0.3 * rect.width) / 1080).toBeCloseTo(0.5, 2);
    expect(rect.left).toBeLessThanOrEqual(0);
    expect(rect.left + rect.width).toBeGreaterThanOrEqual(1080);
  });

  it("rotation is the caller's: a sideways file reported already turned frames like the turned picture", () => {
    // A phone's portrait video probes as 1080x1920 (rotation applied), so it fits the vertical frame as it is.
    const turned = { source: { width: 1080, height: 1920 }, project: PROJECT, format: { width: 9, height: 16 } };
    expect(reframePlacement(turned, { x: 0.5, y: 0.5 }).scale).toBeLessThan(1.003);
  });
});

describe("planReframe", () => {
  const identity = (seconds: number) => seconds;

  it("gives a static placement and no keys for a face that holds one place", () => {
    const plan = planReframe(LANDSCAPE, [{ time: 0, x: 0.4, y: 0.5 }], identity);
    expect(plan.keys).toEqual([]);
    expect(plan.moves).toEqual({ x: false, y: false });
    expect(plan.x).toBe(reframePlacement(LANDSCAPE, { x: 0.4, y: 0.5 }).x);
  });

  it("keys x where the face moves, easing the key that starts a move, on the timeline clock", () => {
    // The clip starts at 10 s and plays the file from 2 s; the face stops left, then glides right at 5 s.
    const plan = planReframe(
      LANDSCAPE,
      [
        { time: 4.5, x: 0.3, y: 0.5 },
        { time: 5, x: 0.7, y: 0.5 },
      ],
      (source) => 10 + (source - 2),
    );
    expect(plan.moves).toEqual({ x: true, y: false });
    expect(plan.keys.map((key) => key.time)).toEqual([12.5, 13]);
    expect(plan.keys[0]).toMatchObject({ ease: "in-out" });
    expect(plan.keys[1]).not.toHaveProperty("ease");
    expect(plan.keys[0]!.x).toBeGreaterThan(0);
    // Faces at 0.3 and 0.7 sit symmetric about the middle.
    expect(plan.keys[1]!.x).toBe(-plan.keys[0]!.x);
    expect(plan.x).toBe(plan.keys[0]!.x);
  });

  it("keeps every key inside the limits, whatever the face does", () => {
    const { maxX, maxY } = reframeBounds(LANDSCAPE);
    const wild = [0, 0.02, 0.5, 0.99, 0.2].map((x, i) => ({ time: i * 3, x, y: x }));
    const plan = planReframe(LANDSCAPE, wild, identity);
    expect(plan.keys.length).toBeGreaterThan(1);
    for (const key of plan.keys) {
      expect(Math.abs(key.x)).toBeLessThanOrEqual(maxX);
      expect(Math.abs(key.y)).toBeLessThanOrEqual(maxY);
    }
  });
});
