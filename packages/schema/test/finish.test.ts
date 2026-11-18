import { describe, expect, it } from "vitest";
import {
  type ClipTrack,
  type Timeline,
  grainOf,
  grainPhase,
  grainPlate,
  grainSeed,
  grainSpread,
  letterboxBars,
  letterboxPicture,
  parseAspect,
  parseTimeline,
  vignetteGain,
  vignetteLevel,
  vignetteOf,
  withSubjectLayers,
} from "../src/index.js";

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

describe("parseAspect", () => {
  it("reads a decimal, a ratio with a colon or a slash, and nothing else", () => {
    expect(parseAspect("2.39")).toBe(2.39);
    expect(parseAspect(" 2.39:1 ")).toBe(2.39);
    expect(parseAspect("4:3")).toBeCloseTo(4 / 3, 12);
    expect(parseAspect("16/9")).toBeCloseTo(16 / 9, 12);
    expect(parseAspect(".5")).toBe(0.5);
    for (const raw of ["", "0", "0:1", "4:0", "wide", "2,39", "-2", "1:2:3"]) expect(parseAspect(raw), raw).toBeNull();
  });
});

describe("letterbox picture (ADR 0043 slice 4)", () => {
  it("is the frame minus the bars of letterboxBars, for bars top and bottom, at the sides and a single one", () => {
    expect(letterboxPicture({ width: 1920, height: 1080 }, 2.39)).toEqual({ left: 0, top: 138, width: 1920, height: 803 });
    expect(letterboxPicture({ width: 1080, height: 1920 }, 1)).toEqual({ left: 0, top: 420, width: 1080, height: 1080 });
    expect(letterboxPicture({ width: 1920, height: 1080 }, 4 / 3)).toEqual({ left: 240, top: 0, width: 1440, height: 1080 });
    // One row short of the frame: only the second bar exists, the picture starts at the top.
    expect(letterboxBars({ width: 100, height: 57 }, 100 / 56)).toEqual([{ left: 0, top: 56, width: 100, height: 1 }]);
    expect(letterboxPicture({ width: 100, height: 57 }, 100 / 56)).toEqual({ left: 0, top: 0, width: 100, height: 56 });
  });

  it("is null with no letterbox or no bars", () => {
    expect(letterboxPicture({ width: 1920, height: 1080 }, undefined)).toBeNull();
    expect(letterboxPicture({ width: 1920, height: 1080 }, 16 / 9)).toBeNull();
  });

  it("agrees with the bars on many frames and aspects: bars and picture tile the frame", () => {
    for (const frame of [{ width: 1920, height: 1080 }, { width: 1080, height: 1350 }, { width: 99, height: 57 }]) {
      for (const aspect of [2.39, 1.85, 4 / 3, 1, 0.5625, 3]) {
        const bars = letterboxBars(frame, aspect);
        const picture = letterboxPicture(frame, aspect);
        const area = bars.reduce((sum, bar) => sum + bar.width * bar.height, 0) + (picture ? picture.width * picture.height : frame.width * frame.height);
        expect(area, `${frame.width}x${frame.height} at ${aspect}`).toBe(frame.width * frame.height);
        expect(picture === null, `${frame.width}x${frame.height} at ${aspect}`).toBe(bars.length === 0);
      }
    }
  });
});

describe("grain (ADR 0043)", () => {
  it("seeds a clip by the low 31 bits of FNV-1a of its id unless it names a seed", () => {
    // FNV-1a 32-bit test vectors: "" 0x811c9dc5, "a" 0xe40c292c, "foobar" 0xbf9cf968.
    expect([grainSeed(""), grainSeed("a"), grainSeed("foobar")]).toEqual([0x011c9dc5, 0x640c292c, 0x3f9cf968]);
    expect(grainOf({ id: "c_talk", type: "media", grain: {} })).toEqual({ amount: 0.35, size: 1.5, seed: grainSeed("c_talk"), strength: 17 });
    expect(grainOf({ id: "c_talk", type: "hyperframes", grain: { amount: 1, size: 3, seed: 9 } })).toEqual({ amount: 1, size: 3, seed: 9, strength: 48 });
  });

  it("gives none to clips without it, an amount too small to show, shots and nested timelines", () => {
    expect(grainOf({ id: "c", type: "media" })).toBeNull();
    expect(grainOf({ id: "c", type: "media", grain: { amount: 0.02 } })).toBeNull();
    expect(grainOf({ id: "c", type: "shot", grain: {} })).toBeNull();
    expect(grainOf({ id: "c", type: "timeline", grain: {} })).toBeNull();
  });

  it("phases the pattern by timeline frame modulo 64", () => {
    expect([0, 63, 64, 70, 134, -1].map(grainPhase)).toEqual([0, 63, 0, 6, 6, 63]);
  });

  it("puts one cell per size project pixels of the layer, never more than the picture has", () => {
    expect(grainPlate(1.5, { width: 1920, height: 1080 }, { width: 3840, height: 2160 })).toEqual({ width: 1280, height: 720 });
    expect(grainPlate(1, { width: 1920, height: 1080 }, { width: 1280, height: 720 })).toEqual({ width: 1280, height: 720 });
    expect(grainPlate(4, { width: 2, height: 2 }, { width: 100, height: 100 })).toEqual({ width: 1, height: 1 });
  });

  it("expects uniform integer values centred on 0, softened by 2/3 when scaled up", () => {
    const grain = { amount: 0.5, size: 1, seed: 1, strength: 24 };
    expect(grainSpread(grain, false)).toEqual({ mean: -0.5, std: Math.sqrt(575 / 12) });
    expect(grainSpread({ ...grain, strength: 17 }, true)).toEqual({ mean: 0, std: (Math.sqrt(288 / 12) * 2) / 3 });
  });

  it("keeps the plate clip's grain and seed on its subject-matte copy", () => {
    const timeline: Timeline = {
      schemaVersion: 1,
      id: "main",
      revision: 1,
      tracks: [
        { id: "v1", kind: "video", clips: [{ id: "c_talk", type: "media", asset: "assets/talk.mp4", start: 0, in: 0, out: 3, grain: { amount: 0.4 } }] },
        { id: "v2", kind: "video", behind: "v1", clips: [{ id: "c_t", type: "media", asset: "assets/title.png", start: 0, in: 0, out: 3 }] },
      ],
    };
    const lifted = withSubjectLayers(timeline);
    const plate = (lifted.tracks[0] as ClipTrack).clips[0]!;
    const copy = (lifted.tracks.find((track) => track.id === "v2/subject") as ClipTrack).clips[0]!;
    expect(grainOf(copy)).toEqual(grainOf(plate));
    expect(grainOf(copy)!.seed).toBe(grainSeed("c_talk"));
  });

  it("parses a timeline whose clips carry grain, and refuses a seed that is not a whole number", () => {
    const timeline = (grain: object) => ({
      schemaVersion: 1,
      id: "main",
      revision: 1,
      tracks: [{ id: "v1", kind: "video", clips: [{ id: "c_talk", type: "media", asset: "assets/talk.mp4", start: 0, in: 0, out: 3, grain }] }],
    });
    expect(parseTimeline(timeline({ amount: 0.4, size: 2, seed: 7 })).ok).toBe(true);
    expect(parseTimeline(timeline({ seed: 1.5 })).ok).toBe(false);
    expect(parseTimeline(timeline({ size: 0.5 })).ok).toBe(false);
  });
});
