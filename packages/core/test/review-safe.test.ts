import { describe, expect, it } from "vitest";
import { type ResolvedSubtitleTrack, SAFE_ZONES, type SubtitleCue, resolveSubtitleStyle } from "@frameshell/schema";
import { MAX_SAFE_TILES, sheetLayout } from "../src/review/plan.js";
import { crossingAt, crossings, cueBox, cueCrossings, filmInsets, safeFlags, sameOrientation, zoneBoxes } from "../src/review/safe.js";
import { shadeFilters } from "../src/review/sheet.js";

// The pure half of the `safe` sheet: zones in film pixels, caption boxes, which cues cross which zone.
const vertical = { width: 1080, height: 1920 };
const metrics = { capHeight: 0.7, width: (text: string) => 0.6 * text.length };

function cue(start: number, end: number, text: string): SubtitleCue {
  return { start, end, words: [{ id: "w", asset: "a", clip: "c", text, start, end, sourceStart: 0, sourceEnd: 1 }], highlight: false, entry: "none" };
}

function track(style: ResolvedSubtitleTrack["style"], cues: SubtitleCue[]): ResolvedSubtitleTrack {
  return { track: "s1", follows: "v1", style, unknownPreset: null, cues, fps: 30, missing: [] };
}

describe("safe zones in film pixels", () => {
  it("scales the platform's reference numbers to the film, per axis", () => {
    const ig = SAFE_ZONES["instagram-reels"];
    expect(filmInsets(ig, vertical)).toEqual({ top: ig.top, right: ig.right, bottom: ig.bottom, left: 0 });
    expect(filmInsets(ig, { width: 540, height: 960 })).toEqual({ top: ig.top / 2, right: ig.right / 2, bottom: ig.bottom / 2, left: 0 });
  });

  it("says whether the film suits the platform's orientation", () => {
    expect(sameOrientation(SAFE_ZONES.tiktok, vertical)).toBe(true);
    expect(sameOrientation(SAFE_ZONES.tiktok, { width: 1920, height: 1080 })).toBe(false);
    expect(sameOrientation(SAFE_ZONES.youtube, { width: 1920, height: 1080 })).toBe(true);
  });

  it("leaves out an edge that covers nothing", () => {
    const edges = zoneBoxes(filmInsets(SAFE_ZONES["instagram-reels"], vertical), vertical).map((zone) => zone.edge);
    expect(edges).toEqual(["top", "right", "bottom"]);
  });

  it("a box crosses the zones it overlaps by more than a border, and says how far in", () => {
    const insets = { top: 200, right: 100, bottom: 400, left: 0 };
    expect(crossings({ x0: 300, y0: 1500, x1: 700, y1: 1600 }, insets, vertical)).toEqual([{ edge: "bottom", reach: 80 }]);
    expect(crossings({ x0: 300, y0: 1000, x1: 700, y1: 1520 }, insets, vertical)).toEqual([]);
    expect(crossings({ x0: 900, y0: 100, x1: 1060, y1: 300 }, insets, vertical)).toEqual([
      { edge: "top", reach: 100 },
      { edge: "right", reach: 80 },
    ]);
  });
});

describe("caption boxes", () => {
  const { style } = resolveSubtitleStyle({ preset: "big-keyword" });

  it("measures a cue from the face: centred, as wide as its text, cap height above the baseline", () => {
    const box = cueBox(style, cue(0, 30, "HOLA"), vertical, metrics);
    // 0.065 of the short side = 70 px; outline 0.09 of that, 6.3 px.
    expect(box.x1 - box.x0).toBeCloseTo(0.6 * 4 * 70 + 2 * 6.3, 1);
    expect((box.x0 + box.x1) / 2).toBeCloseTo(540, 5);
    expect(box.y1).toBeGreaterThan(box.y0);
    const low = cueBox(style, cue(0, 30, "hoy"), vertical, metrics);
    expect(low.y1).toBeGreaterThan(box.y1);
  });

  it("a bottom caption of the big-keyword preset crosses the bottom zone of Instagram Reels but not YouTube's top", () => {
    const tracks = [track(style, [cue(0, 30, "HOLA"), cue(60, 90, "ADIOS")])];
    const ig = cueCrossings(tracks, filmInsets(SAFE_ZONES["instagram-reels"], vertical), vertical, metrics);
    expect(ig.map(({ start, zones }) => [start, zones.map((zone) => zone.edge)])).toEqual([
      [0, ["bottom"]],
      [60, ["bottom"]],
    ]);
    expect(ig[0]!.zones[0]!.reach).toBeGreaterThan(30);
    expect(cueCrossings(tracks, { top: 100, right: 0, bottom: 0, left: 0 }, vertical, metrics)).toEqual([]);
  });

  it("groups crossings by track and zone and finds the frames they show on", () => {
    const tracks = [track(style, [cue(0, 30, "HOLA"), cue(60, 90, "ADIOS"), cue(120, 150, "ADIOS")])];
    const found = cueCrossings(tracks, filmInsets(SAFE_ZONES["instagram-reels"], vertical), vertical, metrics);
    const flags = safeFlags(found, 30);
    expect(flags).toEqual([{ subject: "subtitle", track: "s1", zone: "bottom", cues: 3, first: 0, last: 4, reach: expect.any(Number) }]);
    expect(crossingAt(found, 29)).toBe(true);
    expect(crossingAt(found, 30)).toBe(false);
    expect(crossingAt(found, 60)).toBe(true);
  });
});

describe("safe sheet drawing and layout", () => {
  it("shades each covered edge of a tile and outlines it; nothing without zones", () => {
    expect(shadeFilters({ width: 200, height: 400 }, undefined)).toBe("");
    const filters = shadeFilters({ width: 200, height: 400 }, { top: 0.1, bottom: 0.2, left: 0, right: 0.1 });
    expect(filters.split("drawbox=").length - 1).toBe(6);
    expect(filters).toContain("x=0:y=0:w=200:h=40:color=red@0.3:t=fill");
    expect(filters).toContain("x=0:y=320:w=200:h=80:color=red@0.3:t=fill");
    expect(filters).toContain("x=180:y=0:w=20:h=400:color=red@0.3:t=fill");
  });

  it("tiles a vertical film wider and a horizontal one with fewer, bigger tiles", () => {
    expect(sheetLayout("safe", 9 / 16)).toEqual({ columns: 6, perImage: 18, tileWidth: 200 });
    expect(sheetLayout("safe", 16 / 9)).toEqual({ columns: 4, perImage: 12, tileWidth: 360 });
    expect(MAX_SAFE_TILES).toBe(36);
  });
});
