import { describe, expect, it } from "vitest";
import type { Program } from "../src/renderer/src/preview/program.js";
import { dragPlacement, layerAt, layerBox, placementEdit } from "../src/renderer/src/preview/transform-edit.js";

// Seam under test: the preview's on-canvas transform handles, as pure geometry (the component only forwards pointer events).

const IDENTITY = { x: 0, y: 0, scale: 1, opacity: 1 };
const HD = { width: 1920, height: 1080 };
const LOGO = { width: 500, height: 500 };

/** Base footage on V1, a logo on V2 (quarter size, top right) from frame 30. */
const program: Program = {
  fps: 30,
  sampleRate: 48_000,
  resolution: HD,
  frames: 90,
  layers: [
    [{ kind: "media", clip: "c_cam", start: 0, end: 90, proxy: "p.mp4", in: 0, speed: 1, size: HD, placement: IDENTITY }],
    [{ kind: "still", clip: "c_logo", start: 30, end: 90, image: "assets/logo.png", version: "h", size: LOGO, placement: { x: 600, y: -300, scale: 0.25, opacity: 1 } }],
  ],
  audio: [],
};

describe("layerBox", () => {
  it("places a layer's box in fractions of the frame, as the engine draws it", () => {
    // 270 px square at (1425, 105) of 1920x1080.
    expect(layerBox(program, 60, "c_logo")).toEqual({
      layer: 1,
      size: LOGO,
      placement: { x: 600, y: -300, scale: 0.25, opacity: 1 },
      box: { left: 1425 / 1920, top: 105 / 1080, width: 270 / 1920, height: 270 / 1080 },
    });
  });

  it("is null when the clip does not show at that frame, or only as a placeholder", () => {
    expect(layerBox(program, 10, "c_logo")).toBeNull();
    expect(layerBox(program, 60, "c_other")).toBeNull();
  });
});

describe("layerAt", () => {
  it("finds the topmost layer under a point of the frame", () => {
    expect(layerAt(program, 60, { x: 0.8, y: 0.2 })).toBe("c_logo");
    expect(layerAt(program, 60, { x: 0.2, y: 0.8 })).toBe("c_cam");
    expect(layerAt(program, 10, { x: 0.8, y: 0.2 })).toBe("c_cam");
  });
});

describe("dragPlacement", () => {
  const start = { x: 600, y: -300, scale: 0.25, opacity: 1 };
  // The frame shows at 960x540 CSS px: one CSS px is two project px.
  const frame = { width: 960, height: 540 };

  it("moves by the pointer's travel in project pixels, whole pixels", () => {
    expect(dragPlacement({ kind: "move", start, from: { x: 800, y: 100 }, to: { x: 750.4, y: 130 }, frame, project: HD })).toEqual({
      x: 501,
      y: -240,
      scale: 0.25,
      opacity: 1,
    });
  });

  it("scales about the layer's center by the pointer's distance from it", () => {
    // Center at (1560, 240) project px = (780, 120) CSS px; corner 67.5 px right and up, dragged twice as far.
    const scaled = dragPlacement({ kind: "scale", start, from: { x: 847.5, y: 52.5 }, to: { x: 915, y: -15 }, frame, project: HD });
    expect(scaled).toEqual({ x: 600, y: -300, scale: 0.5, opacity: 1 });
    // Never down to nothing.
    expect(dragPlacement({ kind: "scale", start, from: { x: 847.5, y: 52.5 }, to: { x: 780, y: 120 }, frame, project: HD }).scale).toBe(0.01);
  });
});

describe("placementEdit", () => {
  it("sends only what changed, as one clip.set", () => {
    expect(placementEdit("c_logo", { x: 600, y: -300, scale: 0.25, opacity: 1 }, { x: 501, y: -300, scale: 0.25, opacity: 1 })).toEqual({
      op: "clip.set",
      args: { clip: "c_logo", transform: { x: 501 } },
    });
    expect(placementEdit("c_logo", IDENTITY, IDENTITY)).toBeNull();
  });
});
