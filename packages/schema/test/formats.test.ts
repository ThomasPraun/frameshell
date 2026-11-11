import { describe, expect, it } from "vitest";
import { type Timeline, createProjectConfig, parseProjectConfig, primaryFormatId, projectFormats, resolveFormat, sameAspect } from "../src/index.js";

const timeline: Timeline = { schemaVersion: 1, id: "main", revision: 0, tracks: [] };
const landscape = { resolution: { width: 1920, height: 1080 } };

describe("project formats (ADR 0027)", () => {
  it("gives a project without formats one, its resolution, named by its built-in canvas or its size", () => {
    expect(projectFormats(landscape)).toEqual([{ id: "16x9", width: 1920, height: 1080 }]);
    expect(projectFormats({ resolution: { width: 1080, height: 1920 } })).toEqual([{ id: "9x16", width: 1080, height: 1920 }]);
    expect(primaryFormatId({ width: 3840, height: 2160 })).toBe("3840x2160");
  });

  it("resolves the primary format as the timeline is, every other one covering, vertical captions 1.3x", () => {
    const config = { ...landscape, formats: [{ id: "16x9", width: 1920, height: 1080 }, { id: "9x16", width: 1080, height: 1920 }, { id: "1x1", width: 1080, height: 1080 }] };
    const primary = resolveFormat(timeline, config)!;
    expect(primary.timeline).toBe(timeline);
    expect(primary.format).toEqual({ id: "16x9", width: 1920, height: 1080, primary: true, cover: false, captionScale: 1 });
    expect(resolveFormat(timeline, config, "9x16")!.format).toMatchObject({ primary: false, cover: true, captionScale: 1.3 });
    expect(resolveFormat(timeline, config, "1x1")!.format).toMatchObject({ primary: false, cover: true, captionScale: 1 });
    expect(resolveFormat(timeline, config, "4x5")).toBeNull();
  });

  it("keeps captions as styled in a vertical primary format", () => {
    expect(resolveFormat(timeline, { resolution: { width: 1080, height: 1920 } })!.format).toMatchObject({ id: "9x16", cover: false, captionScale: 1 });
  });

  it("compares aspects within 1 %", () => {
    expect(sameAspect({ width: 1920, height: 1080 }, { width: 2560, height: 1440 })).toBe(true);
    expect(sameAspect({ width: 1366, height: 768 }, { width: 1920, height: 1080 })).toBe(true);
    expect(sameAspect({ width: 1080, height: 1920 }, { width: 1920, height: 1080 })).toBe(false);
  });

  describe("in frameshell.json", () => {
    const base = createProjectConfig("Launch");
    const parse = (formats: unknown, extra: Record<string, unknown> = {}) => parseProjectConfig({ ...base, ...extra, formats });

    it("accepts the primary first plus built-in and custom formats", () => {
      const result = parse([{ id: "16x9", width: 1920, height: 1080 }, { id: "9x16", width: 1080, height: 1920 }, { id: "web-1600x900", width: 1600, height: 900 }]);
      expect(result.ok).toBe(true);
    });

    it.each([
      [[{ id: "9x16", width: 1080, height: 1920 }], /formats\.0: the first format is the primary one and must equal `resolution`/],
      [[{ id: "16x9", width: 1920, height: 1080 }, { id: "16x9", width: 1920, height: 1080 }], /formats\.1\.id: format id 16x9 is listed twice/],
      [[{ id: "16x9", width: 1920, height: 1080 }, { id: "9x16", width: 720, height: 1280 }], /formats\.1: built-in format 9x16 is 1080x1920; use a custom id/],
      [[{ id: "16x9", width: 1920, height: 1080 }, { id: "odd", width: 1081, height: 1920 }], /formats\.1: format odd is 1081x1920; video encoders need even sizes/],
      [[{ id: "16x9", width: 1920, height: 1080 }, { id: "png", width: 1080, height: 1920 }], /formats\.1\.id: must not be an image type/],
      [[{ id: "16x9", width: 1920, height: 1080 }, { id: "Vertical", width: 1080, height: 1920 }], /formats\.1\.id: must be lowercase letters/],
      [[], /formats: Too small/],
    ])("refuses %j", (formats, error) => {
      const result = parse(formats);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(error);
    });

    it("refuses formats in an image project", () => {
      const result = parse([{ id: "16x9", width: 1920, height: 1080 }], { kind: "image" });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/formats: image projects have one frame/);
    });
  });
});
