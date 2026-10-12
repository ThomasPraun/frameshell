import type { ProbedElement } from "@frameshell/protocol";
import { describe, expect, it } from "vitest";
import { elementBox, pagePoint, pickTarget, resolvePick } from "../src/renderer/src/preview/pick.js";
import type { Program } from "../src/renderer/src/preview/program.js";

// Seam under test: what the Pick tool points at (ADR 0011), with a fake page probe standing in for the live page.

const IDENTITY = { x: 0, y: 0, scale: 1, opacity: 1 };
const HD = { width: 1920, height: 1080 };

/** Footage on V1; on V2 a HyperFrames title at half size, centered, still rendering. */
const program: Program = {
  fps: 30,
  sampleRate: 48_000,
  resolution: HD,
  frames: 90,
  layers: [
    [{ kind: "media", clip: "c_cam", start: 0, end: 90, proxy: "p.mp4", in: 0, speed: 1, size: HD, placement: IDENTITY }],
    [
      {
        kind: "generated",
        clip: "c_title",
        type: "hyperframes",
        start: 30,
        end: 90,
        in: 15,
        render: { state: "rendering", progress: 0.4, error: null, key: "k1" },
        size: null,
        placement: { x: 0, y: 0, scale: 0.5, opacity: 1 },
      },
    ],
  ],
  audio: [],
};

const h1: ProbedElement = {
  selector: "#scene-2 > div.card > h1",
  tag: "h1",
  id: null,
  classes: [],
  text: "Launch",
  box: { x: 480, y: 270, width: 960, height: 135 },
  styles: {},
  html: "<h1>Launch</h1>",
  data: {},
  adapter: null,
};
const opaque = () => undefined;

describe("pickTarget", () => {
  it("lays the page where the render will be, at the composition time the frame shows", () => {
    expect(pickTarget(program, 60, 1)).toEqual({
      clip: "c_title",
      identity: "k1",
      box: { left: 0.25, top: 0.25, width: 0.5, height: 0.5 },
      // in 15 frames + 30 frames after the clip's start.
      seconds: 1.5,
    });
    expect(pickTarget(program, 60, 0)).toBeNull();
  });

  it("maps frame points to page pixels and element boxes back to the frame", () => {
    const box = { left: 0.25, top: 0.25, width: 0.5, height: 0.5 };
    expect(pagePoint(box, HD, { x: 0.5, y: 0.5 })).toEqual({ x: 960, y: 540 });
    expect(elementBox(box, HD, h1)).toEqual({ left: 0.375, top: 0.375, width: 0.25, height: 0.0625 });
  });
});

describe("resolvePick", () => {
  it("picks the element a generated clip's page paints there, with the layers under it", async () => {
    const asked: number[][] = [];
    const result = await resolvePick(program, 60, { x: 0.5, y: 0.5 }, opaque, async (_target, x, y, depth) => {
      asked.push([x, y, depth]);
      return [h1];
    });
    expect(asked).toEqual([[960, 540, 8]]);
    expect(result).toEqual({
      layers: [
        { clip: "c_title", type: "hyperframes", paints: true },
        { clip: "c_cam", type: "media", paints: true },
      ],
      target: "c_title",
      elements: [h1],
      unavailable: null,
      page: { left: 0.25, top: 0.25, width: 0.5, height: 0.5 },
    });
  });

  it("goes through where the page paints nothing, to the footage below", async () => {
    const result = await resolvePick(program, 60, { x: 0.3, y: 0.3 }, opaque, async () => []);
    expect(result.target).toBe("c_cam");
    expect(result.layers).toEqual([
      { clip: "c_title", type: "hyperframes", paints: false },
      { clip: "c_cam", type: "media", paints: true },
    ]);
    expect(result.elements).toEqual([]);
  });

  it("without a live page, the clip's box decides and the pick says why it has no element", async () => {
    const result = await resolvePick(program, 60, { x: 0.5, y: 0.5 }, opaque, async () => {
      throw new Error("the project's plugins are not trusted");
    });
    expect(result).toMatchObject({ target: "c_title", elements: [], unavailable: "the project's plugins are not trusted" });
  });

  it("finds nothing over black", async () => {
    const result = await resolvePick({ ...program, layers: [] }, 60, { x: 0.5, y: 0.5 }, opaque, async () => [h1]);
    expect(result).toEqual({ layers: [], target: null, elements: [], unavailable: null, page: null });
  });
});
