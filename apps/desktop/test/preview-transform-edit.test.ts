import { describe, expect, it } from "vitest";
import type { Program } from "../src/renderer/src/preview/program.js";
import { dragPlacement, layerAt, layerBox, layersAt, layersIn, pictureBox, placementEdit } from "../src/renderer/src/preview/transform-edit.js";

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

/** Footage on V1, a full-frame HyperFrames overlay still rendering on V2, a half-opacity logo on V3 (ADR 0011). */
const stacked: Program = {
  ...program,
  layers: [
    program.layers[0]!,
    [{ kind: "generated", clip: "c_0200/c_title", type: "hyperframes", start: 0, end: 90, in: 0, render: null, size: null, placement: IDENTITY }],
    [{ kind: "still", clip: "c_logo", start: 0, end: 90, image: "assets/logo.png", version: "h", size: LOGO, placement: { x: 600, y: -300, scale: 0.25, opacity: 0.5 } }],
  ],
};

describe("layersAt", () => {
  const corner = { x: 0.8, y: 0.2 };

  it("lists every layer under a point, topmost first; a render not ready yet covers the project frame", () => {
    expect(layersAt(stacked, 30, corner)).toEqual([
      { clip: "c_logo", layer: 2, kind: "still", type: "media", paints: true },
      { clip: "c_0200/c_title", layer: 1, kind: "generated", type: "hyperframes", paints: true },
      { clip: "c_cam", layer: 0, kind: "media", type: "media", paints: true },
    ]);
    expect(layerBox(stacked, 30, "c_0200/c_title")?.box).toEqual({ left: 0, top: 0, width: 1, height: 1 });
  });

  it("lets a click through where a picture's alpha (times its opacity) is too faint to see", () => {
    // The overlay is transparent there, the logo's pixel half transparent at half opacity: the footage is the target.
    const alpha = new Map([
      [1, 0],
      [2, 0.06],
    ]);
    const hits = layersAt(stacked, 30, corner, (layer) => alpha.get(layer));
    expect(hits.map((hit) => [hit.clip, hit.paints])).toEqual([
      ["c_logo", false],
      ["c_0200/c_title", false],
      ["c_cam", true],
    ]);
    expect(layerAt(stacked, 30, corner, (layer) => alpha.get(layer))).toBe("c_cam");
    expect(layerAt(stacked, 30, corner)).toBe("c_logo");
  });

  it("finds nothing over black", () => {
    expect(layersAt(stacked, 95, corner)).toEqual([]);
    expect(layerAt(stacked, 95, corner)).toBeNull();
  });
});

describe("layersIn", () => {
  it("names the clips whose box meets a rectangle, topmost first", () => {
    expect(layersIn(stacked, 30, { x0: 0, y0: 0.6, x1: 0.3, y1: 1 }).map((hit) => hit.clip)).toEqual(["c_0200/c_title", "c_cam"]);
    expect(layersIn(stacked, 30, { x0: 0.7, y0: 0.05, x1: 0.9, y1: 0.3 }).map((hit) => hit.clip)).toEqual(["c_logo", "c_0200/c_title", "c_cam"]);
  });
});

describe("multicam shots", () => {
  const angles = [
    { id: "ana", name: "Ana", asset: "assets/ana.mp4", offset: 0 },
    { id: "ben", name: "Ben", asset: "assets/ben.mp4", offset: 0 },
  ];
  const layout = {
    shot: { id: "c_s1", type: "shot" as const, start: 0, in: 0, out: 3, shot: "two-up" as const, angles: ["ana", "ben"] },
    group: { id: "g_talk", angles },
    sizes: { "assets/ana.mp4": HD, "assets/ben.mp4": HD },
  };
  const angle = (id: string) => ({ kind: "angle" as const, clip: "c_s1", start: 0, end: 90, proxy: `${id}.mp4`, in: 0, speed: 1, angle: id, layout });
  const twoUp: Program = { ...program, layers: [program.layers[0]!, [angle("ana")], [angle("ben")]] };

  it("hits the tile of the angle under the point, as footage of the shot", () => {
    expect(layersAt(twoUp, 30, { x: 0.75, y: 0.5 })).toEqual([
      { clip: "c_s1", layer: 2, kind: "media", type: "shot", paints: true },
      { clip: "c_cam", layer: 0, kind: "media", type: "media", paints: true },
    ]);
  });

  it("names a shot once for a region over several of its tiles, at its topmost angle there", () => {
    expect(layersIn(twoUp, 30, { x0: 0.4, y0: 0.4, x1: 0.6, y1: 0.6 }).map(({ clip, layer }) => [clip, layer])).toEqual([
      ["c_s1", 2],
      ["c_cam", 0],
    ]);
  });

  it("gives a shot no handles: shots fill their tiles, they have no placement", () => {
    expect(layerBox(twoUp, 30, "c_s1")).toBeNull();
  });

  it("outlines the tile of the shot's angle under the pointer", () => {
    expect(pictureBox(twoUp, 30, "c_s1", { x: 0.25, y: 0.5 })).toMatchObject({ layer: 1, box: { left: 0, top: 0, width: 0.5, height: 1 } });
    expect(pictureBox(twoUp, 30, "c_s1", { x: 0.75, y: 0.5 })).toMatchObject({ layer: 2, box: { left: 0.5, top: 0, width: 0.5, height: 1 } });
    expect(pictureBox(twoUp, 30, "c_cam", { x: 0.5, y: 0.5 })).toEqual(layerBox(twoUp, 30, "c_cam"));
    expect(pictureBox(twoUp, 120, "c_s1", { x: 0.5, y: 0.5 })).toBeNull();
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

  it("sets a format's override when given one (ADR 0027)", () => {
    expect(placementEdit("c_logo", IDENTITY, { ...IDENTITY, y: 700 }, "9x16")).toEqual({ op: "clip.set", args: { clip: "c_logo", transform: { y: 700 }, format: "9x16" } });
  });
});

describe("in a project format (ADR 0027)", () => {
  const TALL = { width: 1080, height: 1920 };
  /** The same layers as the preview shows them in 9:16: the footage covers the frame (its centre 608x1080). */
  const vertical: Program = {
    ...program,
    layers: [[{ ...program.layers[0]![0]!, cover: { left: 656, top: 0, width: 608, height: 1080 } } as Program["layers"][number][number]], program.layers[1]!],
  };

  it("boxes placed layers in the format's frame, offsets scaled from project pixels as the engine draws them", () => {
    // 500 px square fitted into 1080 wide, a quarter: 270 px; x 600 of 1920 is 337.5 of 1080, y -300 of 1080 is -533.3 of 1920.
    const box = layerBox(vertical, 60, "c_logo", TALL)!.box;
    expect(Math.abs(box.width * TALL.width - 270)).toBeLessThanOrEqual(1);
    expect(Math.abs((box.left + box.width / 2) * TALL.width - (540 + 337.5))).toBeLessThanOrEqual(1);
    expect(Math.abs((box.top + box.height / 2) * TALL.height - (960 - 533.3))).toBeLessThanOrEqual(1);
    expect(layerAt(vertical, 60, { x: box.left + box.width / 2, y: box.top + box.height / 2 }, undefined, TALL)).toBe("c_logo");
  });

  it("gives covering footage the placement that fills the frame, for its handles to start from", () => {
    const covered = layerBox(vertical, 60, "c_cam", TALL)!;
    // 1920 / 608 = 3.1605, rounded up: stored, it still fills the 1920 px height.
    expect(covered).toMatchObject({ covered: true, placement: { x: 0, y: 0, scale: 3.161, opacity: 1 } });
    // Full height; the 16:9 picture reaches past both sides of the 9:16 frame, centred.
    expect(covered.box.height).toBeGreaterThanOrEqual(1);
    expect(covered.box.height).toBeCloseTo(1, 2);
    expect(covered.box.width).toBeCloseTo(1920 / 608, 2);
    expect(covered.box.left + covered.box.width / 2).toBeCloseTo(0.5, 2);
  });
});
