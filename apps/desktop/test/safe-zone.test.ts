import { SAFE_ZONES } from "@frameshell/schema";
import { describe, expect, it } from "vitest";
import { NO_SAFE_ZONE, addableFormats, formatName, framePlatform, readSafeZoneChoice, safeRect } from "../src/renderer/src/preview/safe-zone.js";

describe("safe-zone overlay", () => {
  it("reads a stored choice, and falls back to off for anything else", () => {
    expect(readSafeZoneChoice(JSON.stringify({ on: true, platform: "tiktok" }))).toEqual({ on: true, platform: "tiktok" });
    expect(readSafeZoneChoice(JSON.stringify({ on: true, platform: "myspace" }))).toEqual({ on: true, platform: null });
    expect(readSafeZoneChoice(null)).toEqual(NO_SAFE_ZONE);
    expect(readSafeZoneChoice("{nope")).toEqual(NO_SAFE_ZONE);
  });

  it("follows the frame's shape", () => {
    expect(framePlatform({ width: 1080, height: 1920 })).toBe("instagram-reels");
    expect(framePlatform({ width: 1920, height: 1080 })).toBe("youtube");
    expect(framePlatform({ width: 1080, height: 1080 })).toBe("youtube");
  });

  it("places the zone from the schema's numbers, scaled to the frame", () => {
    const reels = SAFE_ZONES["instagram-reels"];
    expect(safeRect("instagram-reels", { width: 1080, height: 1920 })).toEqual({
      top: reels.top / 1920,
      right: reels.right / 1080,
      bottom: reels.bottom / 1920,
      left: 0,
      sameShape: true,
    });
    // Half the size: the same fractions (rounded pixels).
    expect(safeRect("youtube", { width: 960, height: 540 })).toMatchObject({ top: 27 / 540, left: 48 / 960, sameShape: true });
    expect(safeRect("tiktok", { width: 1920, height: 1080 }).sameShape).toBe(false);
  });

  it("names built-in formats by aspect and offers the ones a project lacks", () => {
    expect(formatName("9x16")).toBe("9:16");
    expect(formatName("web-1600x900")).toBe("web-1600x900");
    expect(addableFormats([{ id: "16x9" }, { id: "9x16" }])).toEqual([
      { id: "1x1", width: 1080, height: 1080 },
      { id: "4x5", width: 1080, height: 1350 },
    ]);
  });
});
