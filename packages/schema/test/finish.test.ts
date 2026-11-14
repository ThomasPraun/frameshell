import { describe, expect, it } from "vitest";
import { letterboxBars, parseTimeline, vignetteGain, vignetteLevel, vignetteOf } from "../src/index.js";

describe("vignette (ADR 0043)", () => {
  const frame = { width: 1920, height: 1080 };
  const lens = { strength: 0.5, radius: 1, softness: 0.6 };

  it("leaves the centre alone, reaches 1 - strength at the radius, and falls off smoothly and evenly between", () => {
    expect(vignetteGain(960, 540, frame, lens)).toBe(1);
    // Within radius - softness (0.4 half-diagonals) nothing changes.
    expect(vignetteGain(960 + 0.39 * 1101.45, 540, frame, lens)).toBe(1);
    // The corners are 1 half-diagonal out.
    expect(vignetteGain(0, 0, frame, lens)).toBeCloseTo(0.5, 12);
    expect(vignetteGain(1920, 1080, frame, { ...lens, radius: 0.8 })).toBeCloseTo(0.5, 12);
    // Halfway through the falloff, smoothstep is at 0.5.
    expect(vignetteGain(960, 540 + 0.7 * Math.hypot(960, 540), frame, lens)).toBeCloseTo(0.75, 12);
    let last = 1;
    for (let x = 960; x >= 0; x -= 10) {
      const gain = vignetteGain(x, 0, frame, lens);
      expect(gain).toBeLessThanOrEqual(last);
      last = gain;
    }
  });

  it("is round in pixels on any aspect, and a softness of 0 is a hard edge", () => {
    expect(vignetteGain(960 + 300, 540, frame, lens)).toBe(vignetteGain(960, 540 + 300, frame, lens));
    const hard = { strength: 1, radius: 0.5, softness: 0 };
    const half = 0.5 * Math.hypot(960, 540);
    expect(vignetteGain(960 + half - 1, 540, frame, hard)).toBe(1);
    expect(vignetteGain(960 + half + 1, 540, frame, hard)).toBe(0);
  });

  it("writes levels as an 8-bit plate rounds them", () => {
    expect([vignetteLevel(1), vignetteLevel(0.5), vignetteLevel(0)]).toEqual([255, 128, 0]);
  });

  it("fills in defaults, and gives none to clips without one, a strength of 0, shots and nested timelines", () => {
    expect(vignetteOf({ type: "media", vignette: {} })).toEqual({ strength: 0.35, radius: 1, softness: 0.6 });
    expect(vignetteOf({ type: "hyperframes", vignette: { radius: 0.7 } })).toEqual({ strength: 0.35, radius: 0.7, softness: 0.6 });
    expect(vignetteOf({ type: "media" })).toBeNull();
    expect(vignetteOf({ type: "media", vignette: { strength: 0 } })).toBeNull();
    expect(vignetteOf({ type: "shot", vignette: {} })).toBeNull();
    expect(vignetteOf({ type: "timeline", vignette: {} })).toBeNull();
  });

  it("is a field of media and adapter clips only, in range", () => {
    const withClip = (clip: object) => parseTimeline({ schemaVersion: 1, id: "main", revision: 1, tracks: [{ id: "v1", kind: "video", clips: [clip] }] }).ok;
    const media = { id: "c_1", type: "media", asset: "assets/a.mp4", start: 0, in: 0, out: 1 };
    expect(withClip({ ...media, vignette: { strength: 0.4, radius: 1.5, softness: 0 } })).toBe(true);
    expect(withClip({ id: "c_2", type: "hyperframes", start: 0, duration: 1, vignette: {} })).toBe(true);
    expect(withClip({ ...media, vignette: { radius: 1.6 } })).toBe(false);
    expect(withClip({ ...media, vignette: { amount: 1 } })).toBe(false);
    expect(withClip({ id: "c_3", type: "timeline", source: "timelines/a.json", start: 0, vignette: {} })).toBe(false);
  });
});

describe("letterbox bars (ADR 0043)", () => {
  it("puts bars top and bottom for a wider aspect, the odd row in the second bar", () => {
    expect(letterboxBars({ width: 1920, height: 1080 }, 2.39)).toEqual([
      { left: 0, top: 0, width: 1920, height: 138 },
      { left: 0, top: 941, width: 1920, height: 139 },
    ]);
  });

  it("puts bars at the sides for a narrower aspect", () => {
    expect(letterboxBars({ width: 1920, height: 1080 }, 4 / 3)).toEqual([
      { left: 0, top: 0, width: 240, height: 1080 },
      { left: 1680, top: 0, width: 240, height: 1080 },
    ]);
    expect(letterboxBars({ width: 1080, height: 1920 }, 1)).toEqual([
      { left: 0, top: 0, width: 1080, height: 420 },
      { left: 0, top: 1500, width: 1080, height: 420 },
    ]);
  });

  it("draws nothing when the aspect matches the frame to the pixel, and always keeps one row or column of picture", () => {
    expect(letterboxBars({ width: 1920, height: 1080 }, 16 / 9)).toEqual([]);
    expect(letterboxBars({ width: 1920, height: 1080 }, 1.7778)).toEqual([]);
    const [top, bottom] = letterboxBars({ width: 100, height: 100 }, 1e6);
    expect(top!.height + bottom!.height).toBe(99);
  });
});
