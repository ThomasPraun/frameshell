import { describe, expect, it } from "vitest";
import { type MulticamGroup, type ShotClip, createTimeline, cropAt, parseTimeline, reframeAt, shotGroupTime, shotLayers } from "../src/index.js";

const group = (reframe?: { at: number; x: number; y: number }[], extra: Partial<MulticamGroup["angles"][number]> = {}): MulticamGroup => ({
  id: "g_talk",
  angles: [
    { id: "ana", name: "Ana", asset: "assets/ana.mp4", offset: 0, ...(reframe ? { reframe } : {}), ...extra },
    { id: "ben", name: "Ben", asset: "assets/ben.mp4", offset: 0 },
  ],
});

const shot = (layout: ShotClip["shot"], angles: string[], from = 0, to = 10, start = 0): ShotClip => ({ id: "c_1", type: "shot", start, in: from, out: to, shot: layout, angles });

const landscape = { width: 1920, height: 1080 };
const portrait = { width: 1080, height: 1920 };
const sizes = () => landscape;

const timelineWith = (g: unknown) => ({
  ...createTimeline("main"),
  groups: [g],
  tracks: [{ id: "t_p", kind: "program", group: "g_talk", clips: [shot("solo", ["ana"])] }],
});

describe("angle reframe keys (timeline model)", () => {
  it("accepts keys sorted by time", () => {
    const result = parseTimeline(timelineWith(group([{ at: 0, x: 0.3, y: 0.5 }, { at: 4, x: 0.7, y: 0.4 }])));
    expect(result.ok).toBe(true);
  });

  it("refuses keys out of order or at the same second", () => {
    for (const keys of [
      [{ at: 4, x: 0.3, y: 0.5 }, { at: 1, x: 0.7, y: 0.5 }],
      [{ at: 2, x: 0.3, y: 0.5 }, { at: 2, x: 0.7, y: 0.5 }],
    ]) {
      const result = parseTimeline(timelineWith(group(keys)));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("sorted by `at`");
    }
  });

  it("refuses a point outside the picture and an empty key list", () => {
    expect(parseTimeline(timelineWith(group([{ at: 0, x: 1.2, y: 0.5 }]))).ok).toBe(false);
    expect(parseTimeline(timelineWith(group([]))).ok).toBe(false);
  });
});

describe("reframeAt", () => {
  const keys = [
    { at: 2, x: 0.2, y: 0.5 },
    { at: 6, x: 0.6, y: 0.3 },
  ];

  it("holds the first key before it and the last after it", () => {
    expect(reframeAt(keys, 0)).toEqual({ x: 0.2, y: 0.5 });
    expect(reframeAt(keys, 9)).toEqual({ x: 0.6, y: 0.3 });
  });

  it("moves in a straight line between keys", () => {
    const point = reframeAt(keys, 4)!;
    expect(point.x).toBeCloseTo(0.4, 10);
    expect(point.y).toBeCloseTo(0.4, 10);
  });

  it("is null without keys", () => {
    expect(reframeAt(undefined, 1)).toBeNull();
  });
});

describe("shot layout with reframe (composite)", () => {
  it("cuts a 9:16 solo of a 16:9 camera around the key's point", () => {
    // 608x1080 strip: centered on x = 0.25 * 1920 = 480.
    const [layer] = shotLayers(shot("solo", ["ana"]), group([{ at: 0, x: 0.25, y: 0.5 }]), portrait, sizes);
    expect(layer!.crop).toEqual({ left: 176, top: 0, width: 608, height: 1080 });
    expect(layer!.reframe).toBeUndefined();
  });

  it("keeps the cut inside the picture", () => {
    expect(shotLayers(shot("solo", ["ana"]), group([{ at: 0, x: 0, y: 0.5 }]), portrait, sizes)[0]!.crop.left).toBe(0);
    expect(shotLayers(shot("solo", ["ana"]), group([{ at: 0, x: 1, y: 0.5 }]), portrait, sizes)[0]!.crop.left).toBe(1312);
  });

  it("keeps the cut inside the angle's own crop", () => {
    // Crop keeps x 480..1440; the 405-wide strip cannot start left of 480 or end right of 1440.
    const cropped = group([{ at: 0, x: 0, y: 0.5 }], { crop: { left: 0.25, right: 0.25 } });
    const [layer] = shotLayers(shot("solo", ["ana"]), cropped, portrait, sizes);
    expect(layer!.crop).toMatchObject({ left: 480, top: 0, height: 1080 });
    const right = shotLayers(shot("solo", ["ana"]), group([{ at: 0, x: 1, y: 0.5 }], { crop: { left: 0.25, right: 0.25 } }), portrait, sizes)[0]!;
    expect(right.crop.left + right.crop.width).toBe(1440);
  });

  it("gives the path when the cut moves during the shot, and the crop at the time asked", () => {
    const moving = group([
      { at: 0, x: 0.25, y: 0.5 },
      { at: 10, x: 0.75, y: 0.5 },
    ]);
    const [start] = shotLayers(shot("solo", ["ana"]), moving, portrait, sizes);
    expect(start!.crop.left).toBe(176);
    expect(start!.reframe).toMatchObject({ width: 608, height: 1080, left: [0, 1312], top: [0, 0] });
    const [middle] = shotLayers(shot("solo", ["ana"]), moving, portrait, sizes, 5);
    expect(middle!.crop.left).toBe(656);
    expect(cropAt(start!.reframe!, 10)).toEqual({ left: 1136, top: 0, width: 608, height: 1080 });
  });

  it("leaves out the path when the keys move the cut only outside the shot", () => {
    const later = group([
      { at: 20, x: 0.25, y: 0.5 },
      { at: 30, x: 0.75, y: 0.5 },
    ]);
    const [layer] = shotLayers(shot("solo", ["ana"]), later, portrait, sizes);
    expect(layer!.crop.left).toBe(176);
    expect(layer!.reframe).toBeUndefined();
  });

  it("changes nothing where the tile has the picture's aspect", () => {
    const [layer] = shotLayers(shot("solo", ["ana"]), group([{ at: 0, x: 0.1, y: 0.1 }, { at: 5, x: 0.9, y: 0.9 }]), landscape, sizes);
    expect(layer!.crop).toEqual({ left: 0, top: 0, width: 1920, height: 1080 });
    expect(layer!.reframe).toBeUndefined();
  });

  it("moves each tile of a stacked 9:16 two-up", () => {
    const layers = shotLayers(shot("two-up", ["ana", "ben"]), group([{ at: 0, x: 0.2, y: 0.5 }]), portrait, sizes);
    expect(layers[0]!.tile).toEqual({ left: 0, top: 0, width: 1080, height: 960 });
    // 9:8 tile of a 16:9 picture: 1215x1080, centered on x = 384, held at the left edge.
    expect(layers[0]!.crop).toEqual({ left: 0, top: 0, width: 1215, height: 1080 });
    expect(layers[1]!.crop).toEqual({ left: 352, top: 0, width: 1215, height: 1080 });
  });

  it("never cuts a screen, but moves a pip inset", () => {
    const screens = group([{ at: 0, x: 0, y: 0.5 }]);
    expect(shotLayers(shot("screen", ["ana"]), screens, portrait, sizes)[0]!.crop).toEqual({ left: 0, top: 0, width: 1920, height: 1080 });
    const insetFirst: MulticamGroup = { ...screens, angles: [...screens.angles].reverse() };
    const [, inset] = shotLayers(shot("pip", ["ben", "ana"]), insetFirst, landscape, sizes);
    expect(inset!.crop).toEqual({ left: 0, top: 0, width: 1920, height: 1080 });
  });

  it("maps timeline seconds to the shot's group seconds", () => {
    expect(shotGroupTime(shot("solo", ["ana"], 30, 40, 12), 15)).toBe(33);
  });
});
