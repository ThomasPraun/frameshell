import { describe, expect, it } from "vitest";
import { parseTimelineCommand } from "../src/timeline-commands.js";

// Seam under test: `clip set --grade-*` / `--clear-grade` (ADR 0031, #384) from argv to the `clip.set` request.

describe("clip set --grade-* (#384)", () => {
  it("sends only the numbers given, merged by the daemon into the clip's grade", () => {
    expect(parseTimelineCommand(["clip", "set", "c_talk"], { "grade-exposure": "0.5", "grade-saturation": "1.2" })!.params).toEqual({
      clip: "c_talk",
      grade: { exposure: 0.5, saturation: 1.2 },
    });
    expect(parseTimelineCommand(["clip", "set", "c_talk"], { "grade-lut": "luts/warm.cube", "grade-lut-mix": "0.6" })!.params["grade"]).toEqual({
      lut: "luts/warm.cube",
      lutMix: 0.6,
    });
  });

  it("removes the LUT with --grade-lut none and the whole grade with --clear-grade, alone", () => {
    expect(parseTimelineCommand(["clip", "set", "c_talk"], { "grade-lut": "none" })!.params["grade"]).toEqual({ lut: null });
    expect(parseTimelineCommand(["clip", "set", "c_talk"], { "clear-grade": true })!.params).toEqual({ clip: "c_talk", grade: null });
    expect(() => parseTimelineCommand(["clip", "set", "c_talk"], { "clear-grade": true, "grade-tint": "0.1" })).toThrow(/--clear-grade alone/);
  });
});

describe("clip set --vignette (ADR 0043)", () => {
  it("sends only the numbers given, merged by the daemon into the clip's vignette", () => {
    expect(parseTimelineCommand(["clip", "set", "c_talk"], { vignette: "0.4" })!.params).toEqual({ clip: "c_talk", vignette: { strength: 0.4 } });
    expect(parseTimelineCommand(["clip", "set", "c_talk"], { "vignette-radius": "0.8", "vignette-softness": "0" })!.params["vignette"]).toEqual({
      radius: 0.8,
      softness: 0,
    });
  });

  it("removes the vignette with --clear-vignette, alone", () => {
    expect(parseTimelineCommand(["clip", "set", "c_talk"], { "clear-vignette": true })!.params).toEqual({ clip: "c_talk", vignette: null });
    expect(() => parseTimelineCommand(["clip", "set", "c_talk"], { "clear-vignette": true, vignette: "0.3" })).toThrow(/--clear-vignette alone/);
  });
});
