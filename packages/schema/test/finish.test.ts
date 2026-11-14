import { describe, expect, it } from "vitest";
import { letterboxBars } from "../src/index.js";

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
