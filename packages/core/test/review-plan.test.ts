import { describe, expect, it } from "vitest";
import {
  MAX_CONTACT_TILES,
  contactPicks,
  fileSampleRate,
  frameRange,
  motionPeaks,
  phonePicks,
  seamPicks,
  sheetLayout,
  splitImages,
  stripPicks,
  tileHeight,
  tileLabel,
  timelineCritical,
  timelineSampleStep,
} from "../src/review/plan.js";

const range = (first: number, end: number) => ({ first, end });

describe("review frame picks", () => {
  it("frameRange snaps seconds to frames and clips to the film", () => {
    expect(frameRange(90, 30)).toEqual(range(0, 90));
    expect(frameRange(90, 30, 0.5, 1.5)).toEqual(range(15, 45));
    expect(frameRange(90, 30, 2, 99)).toEqual(range(60, 90));
    expect(frameRange(90, 30, 3)).toBeNull();
    expect(frameRange(90, 30, 1, 1)).toBeNull();
  });

  it("contact picks: first and last frame, the critical times, a grid frame every half second unless one is near", () => {
    const picks = contactPicks(30, range(0, 90), [
      { at: 1.5, tag: "cut" },
      { at: 2.4, tag: "marker" },
      { at: 2.45, tag: "marker" },
      { at: 99, tag: "cue" },
    ]);
    expect(picks.map(({ frame, tag }) => [frame, tag])).toEqual([
      [0, "start"],
      [15, "grid"],
      [30, "grid"],
      [45, "cut"],
      [60, "grid"],
      [72, "marker"],
      [73, "marker"],
      [89, "end"],
    ]);
  });

  it("a given `every` sets the grid, and no more than a frame apart", () => {
    const picks = contactPicks(30, range(0, 60), [], 1);
    expect(picks.map((pick) => pick.frame)).toEqual([0, 30, 59]);
    expect(contactPicks(30, range(0, 6), [], 0.0001).map((pick) => pick.frame)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("a long film widens the grid to stay within the cap, and the cap thins grid frames before critical ones", () => {
    const long = contactPicks(30, range(0, 30 * 600), []);
    expect(long.length).toBeLessThanOrEqual(MAX_CONTACT_TILES);
    expect(long[0]).toEqual({ frame: 0, tag: "start" });
    expect(long.at(-1)).toEqual({ frame: 30 * 600 - 1, tag: "end" });
    const cuts = Array.from({ length: 200 }, (_, i) => ({ at: i * 3 + 1, tag: "cut" as const }));
    const crowded = contactPicks(30, range(0, 30 * 600), cuts);
    expect(crowded).toHaveLength(MAX_CONTACT_TILES);
    expect(crowded.filter((pick) => pick.tag === "grid")).toHaveLength(0);
    expect(crowded[0]!.tag).toBe("start");
    expect(crowded.at(-1)!.tag).toBe("end");
  });

  it("phone picks: one a second from the start of the range, coarser past 60 tiles", () => {
    expect(phonePicks(30, range(15, 100)).map((pick) => pick.frame)).toEqual([15, 45, 75]);
    const long = phonePicks(30, range(0, 30 * 300));
    expect(long.length).toBeLessThanOrEqual(60);
    expect(long.length).toBeGreaterThan(55);
  });

  it("seam picks: the last six then the first six; fewer on a short film, none on one frame", () => {
    expect(seamPicks(range(0, 90))!.map((pick) => pick.frame)).toEqual([84, 85, 86, 87, 88, 89, 0, 1, 2, 3, 4, 5]);
    expect(seamPicks(range(10, 17))!.map((pick) => [pick.frame, pick.tag])).toEqual([
      [14, "tail"],
      [15, "tail"],
      [16, "tail"],
      [10, "head"],
      [11, "head"],
      [12, "head"],
    ]);
    expect(seamPicks(range(3, 4))).toBeNull();
  });

  it("strip picks: 12 consecutive frames around the peak, moved inside the range", () => {
    expect(stripPicks(30, range(0, 90), 1).map((pick) => pick.frame)).toEqual([24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35]);
    expect(stripPicks(30, range(0, 90), 0)[0]!.frame).toBe(0);
    expect(stripPicks(30, range(0, 90), 3).at(-1)!.frame).toBe(89);
    expect(stripPicks(30, range(10, 15), 0.4).map((pick) => pick.frame)).toEqual([10, 11, 12, 13, 14]);
  });

  it("sample rates: every frame of a short timeline, spread over a long one; a file at most 15 a second", () => {
    expect(timelineSampleStep(60)).toBe(1);
    expect(timelineSampleStep(900)).toBe(10);
    expect(fileSampleRate(30, 30)).toBe(15);
    expect(fileSampleRate(30, 10)).toBe(10);
    expect(fileSampleRate(3600, 30)).toBeCloseTo(3000 / 3600);
  });
});

describe("review motion peaks", () => {
  it("takes the strongest changes first, each half a second from the others, and nothing under the floor", () => {
    const times = Array.from({ length: 10 }, (_, i) => i * 0.1);
    const energy = [0, 0, 40, 0.1, 30, 0, 0, 50, 0, 0.2];
    expect(motionPeaks(times, energy)).toEqual([
      { at: 0.65, energy: 50 },
      { at: 0.15, energy: 40 },
    ]);
    expect(motionPeaks([0, 1, 2], [0, 0.1, 0.2])).toEqual([]);
  });

  it("keeps five at most", () => {
    const times = Array.from({ length: 40 }, (_, i) => i);
    const energy = times.map((_, i) => (i === 0 ? 0 : 10 + i));
    expect(motionPeaks(times, energy)).toHaveLength(5);
  });
});

describe("review sheets", () => {
  it("lays a vertical film out in more, narrower columns", () => {
    expect(sheetLayout("contact", 16 / 9)).toEqual({ columns: 6, perImage: 30, tileWidth: 270 });
    expect(sheetLayout("contact", 9 / 16)).toEqual({ columns: 10, perImage: 30, tileWidth: 160 });
    expect(sheetLayout("phone", 9 / 16).tileWidth).toBe(360);
    expect(sheetLayout("motion", 16 / 9)).toEqual({ columns: 4, perImage: 12, tileWidth: 640 });
    expect(sheetLayout("motion", 9 / 16).perImage).toBe(12);
    expect(sheetLayout("seam", 1).perImage).toBe(12);
  });

  it("tile heights are even; images split in order; labels carry the tag unless it is a plain grid frame", () => {
    expect(tileHeight(270, 16 / 9)).toBe(152);
    expect(tileHeight(160, 9 / 16)).toBe(284);
    expect(splitImages([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(tileLabel(12.5, "grid")).toBe("12.50");
    expect(tileLabel(12.5, "second")).toBe("12.50");
    expect(tileLabel(1.5, "cut")).toBe("1.50 cut");
  });
});

describe("timelineCritical", () => {
  const clip = (start: number, end: number | null, extra: Record<string, unknown> = {}) => ({ id: `c_${start}`, type: "media", start, end, ...extra });
  const track = (kind: string, clips: ReturnType<typeof clip>[], extra: Record<string, unknown> = {}) => ({ id: kind, kind, name: null, follows: null, clips, ...extra });

  it("marks clip edges of visible picture tracks, markers, cues and the deepest zoom", () => {
    const view = {
      tracks: [
        track("video", [clip(0, 2), clip(2, 5, { in: 10, speed: 2, keys: { scale: [{ at: 10, value: 1 }, { at: 12, value: 1.4 }, { at: 14, value: 1 }] } })]),
        track("video", [clip(1, 3)], { hidden: true }),
        track("audio", [clip(0, 9)]),
        track("subtitles", []),
      ],
      markers: [{ id: "m_1", at: 4.5, label: "payoff" }],
    } as unknown as Parameters<typeof timelineCritical>[0];
    const found = timelineCritical(view, [0.8]);
    expect(found.filter((entry) => entry.tag === "cut").map((entry) => entry.at)).toEqual([0, 2, 2, 5]);
    expect(found.filter((entry) => entry.tag === "zoom")).toEqual([{ at: 3, tag: "zoom" }]);
    expect(found.filter((entry) => entry.tag === "marker")).toEqual([{ at: 4.5, tag: "marker" }]);
    expect(found.filter((entry) => entry.tag === "cue")).toEqual([{ at: 0.8, tag: "cue" }]);
  });

  it("skips flat or single keys and clips of unknown length", () => {
    const view = {
      tracks: [
        track("video", [
          clip(0, 2, { keys: { scale: [{ at: 0, value: 1 }, { at: 1, value: 1 }] } }),
          clip(2, 4, { keys: { scale: [{ at: 0, value: 2 }] } }),
          clip(4, null, { keys: { scale: [{ at: 0, value: 1 }, { at: 1, value: 2 }] } }),
        ]),
      ],
    } as unknown as Parameters<typeof timelineCritical>[0];
    const found = timelineCritical(view, []);
    expect(found.some((entry) => entry.tag === "zoom")).toBe(false);
    expect(found.filter((entry) => entry.tag === "cut").map((entry) => entry.at)).toEqual([0, 2, 2, 4, 4]);
  });
});
