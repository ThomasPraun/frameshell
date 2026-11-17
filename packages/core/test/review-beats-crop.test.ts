import { describe, expect, it } from "vitest";
import type { Clip } from "@frameshell/schema";
import { BEAT_PICK_PHASE, MAX_BEAT_TILES, type BeatGrid, beatPicks, cropRect, sheetLayout, tileLabel } from "../src/review/plan.js";
import { clipPointInFilm } from "../src/review/placement.js";

const range = (first: number, end: number) => ({ first, end });

/** A 120 BPM grid in 4/4 from 0 s: a beat every 0.5 s, a bar every 2 s. */
function grid(seconds: number, extra: Partial<BeatGrid> = {}): BeatGrid {
  const beats = Array.from({ length: Math.round(seconds / 0.5) }, (_, i) => i * 0.5);
  return { beats, bars: beats.filter((_, i) => i % 4 === 0), beatBase: 0, barBase: 0, bpm: 120, ...extra };
}

describe("beats sheet picks", () => {
  it("takes each beat a quarter beat after its hit and names bar starts and beats like beat:N and bar:N", () => {
    const picks = beatPicks(30, range(0, 120), grid(4));
    expect(BEAT_PICK_PHASE).toBe(0.25);
    expect(picks.map((pick) => pick.frame)).toEqual([3, 18, 33, 48, 63, 78, 93, 108]);
    expect(picks.map((pick) => pick.name)).toEqual(["bar 1", "beat 2", "beat 3", "beat 4", "bar 2", "beat 6", "beat 7", "beat 8"]);
    expect(picks.every((pick) => pick.tag === "beat")).toBe(true);
  });

  it("gives the last beat the length of the one before it, and a lone beat the tempo's", () => {
    const uneven: BeatGrid = { beats: [0, 1, 1.4], bars: [0], beatBase: 0, barBase: 0, bpm: 60 };
    // 1.4 + 0.25 * 0.4 = 1.5 s.
    expect(beatPicks(30, range(0, 90), uneven).map((pick) => pick.frame)).toEqual([7, 33, 45]);
    expect(beatPicks(30, range(0, 90), { beats: [1], bars: [], beatBase: 0, barBase: 0, bpm: 60 })).toEqual([{ frame: 37, tag: "beat", name: "beat 1" }]);
  });

  it("keeps only beats whose hit is in the range, counted from the grid's bases, and never past the range", () => {
    const picks = beatPicks(30, range(30, 61), grid(4, { beatBase: 8, barBase: 2 }));
    expect(picks.map((pick) => [pick.frame, pick.name])).toEqual([
      [33, "beat 11"],
      [48, "beat 12"],
      [60, "bar 4"],
    ]);
  });

  it("thins a long grid evenly to the cap, keeping bar starts first", () => {
    const picks = beatPicks(30, range(0, 30 * 120), grid(120));
    expect(picks).toHaveLength(MAX_BEAT_TILES);
    expect(picks.filter((pick) => pick.name.startsWith("bar ")).length).toBe(60);
    const few = beatPicks(30, range(0, 30 * 40), grid(40), 30);
    expect(few).toHaveLength(30);
    expect(few.filter((pick) => pick.name.startsWith("bar ")).length).toBe(20);
    expect(few.map((pick) => pick.frame)).toEqual([...few.map((pick) => pick.frame)].sort((a, b) => a - b));
  });

  it("labels a tile with its beat's name and tiles the sheet like the contact sheet", () => {
    expect(tileLabel(1.5, "beat", "bar 2")).toBe("1.50 bar 2");
    expect(tileLabel(1.5, "cut")).toBe("1.50 cut");
    expect(sheetLayout("beats", 16 / 9)).toEqual(sheetLayout("contact", 16 / 9));
  });
});

describe("cropAt crops", () => {
  const frame = { width: 1920, height: 1080 };

  it("crops a quarter of the width around the point, with the frame's proportions, kept inside the frame", () => {
    expect(cropRect(frame, { x: 960, y: 540 }, 0.25)).toEqual({ x: 720, y: 405, width: 480, height: 270 });
    expect(cropRect(frame, { x: 1900, y: 1070 }, 0.25)).toEqual({ x: 1440, y: 810, width: 480, height: 270 });
    expect(cropRect(frame, { x: 0, y: 0 }, 1)).toEqual({ x: 0, y: 0, width: 1920, height: 1080 });
  });

  it("stays inside the picture letterbox bars leave, shrinking to fit it", () => {
    const picture = { left: 0, top: 140, width: 1920, height: 800 };
    expect(cropRect(frame, { x: 960, y: 100 }, 0.25, picture)).toEqual({ x: 720, y: 140, width: 480, height: 270 });
    const whole = cropRect(frame, { x: 960, y: 540 }, 1, picture);
    expect(whole.height).toBeLessThanOrEqual(800);
    expect(whole.y).toBeGreaterThanOrEqual(140);
  });

  it("follows a point of a clip's picture through its keyed move and scale", () => {
    const clip = {
      id: "c_1",
      type: "media",
      asset: "assets/a.mp4",
      start: 0,
      in: 0,
      out: 2,
      keys: { x: [{ at: 0, value: 0 }, { at: 2, value: 480 }], scale: [{ at: 0, value: 0.5 }, { at: 2, value: 0.5 }] },
    } as unknown as Clip;
    const picture = { clip, source: frame, generated: false, base: true };
    // Half size, centred: the clip's centre is the frame's, its top-left corner a quarter in.
    expect(clipPointInFilm(picture, 0, { x: 0.5, y: 0.5 }, frame, frame)).toEqual({ x: 960, y: 540 });
    expect(clipPointInFilm(picture, 0, { x: 0, y: 0 }, frame, frame)).toEqual({ x: 480, y: 270 });
    // At 1 s the clip has moved 240 px right.
    expect(clipPointInFilm(picture, 1, { x: 0.5, y: 0.5 }, frame, frame)).toEqual({ x: 1200, y: 540 });
  });

  it("maps a point of an untransformed clip through the format's cover crop", () => {
    const clip = { id: "c_1", type: "media", asset: "assets/a.mp4", start: 0, in: 0, out: 2 } as unknown as Clip;
    const vertical = { width: 1080, height: 1920 };
    const picture = { clip, source: frame, generated: false, base: true };
    // The cover crop keeps the middle 608 px of the 1920 px wide picture: its centre stays in the middle of the frame.
    const centre = clipPointInFilm(picture, 0, { x: 0.5, y: 0.5 }, vertical, frame, { cover: true, captionScale: 1 });
    expect(Math.abs(centre.x - 540)).toBeLessThan(4);
    expect(centre.y).toBeCloseTo(960, 0);
    const fitted = clipPointInFilm(picture, 0, { x: 0.5, y: 0.5 }, vertical, frame);
    expect(fitted).toEqual({ x: 540, y: 960 });
    const right = clipPointInFilm(picture, 0, { x: 0.6, y: 0.5 }, vertical, frame, { cover: true, captionScale: 1 });
    expect(right.x).toBeGreaterThan(clipPointInFilm(picture, 0, { x: 0.6, y: 0.5 }, vertical, frame).x);
  });
});
