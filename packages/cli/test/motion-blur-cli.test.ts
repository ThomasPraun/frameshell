import { describe, expect, it } from "vitest";
import { parseTimelineCommand } from "../src/timeline-commands.js";

// Seam under test: `clip set --motion-blur` / `--motion-blur-*` (ADR 0041) from argv to the `clip.set` request.
describe("clip set --motion-blur", () => {
  it("turns blur on with the defaults, sets single settings, clears with --clear-motion-blur", () => {
    expect(parseTimelineCommand(["clip", "set", "c_card"], { "motion-blur": true })!.params).toEqual({ clip: "c_card", motionBlur: {} });
    expect(
      parseTimelineCommand(["clip", "set", "c_card"], { "motion-blur-shutter": "90", "motion-blur-samples": "16", "motion-blur-blend": "srgb" })!.params,
    ).toEqual({ clip: "c_card", motionBlur: { shutter: 90, samples: 16, blend: "srgb" } });
    expect(parseTimelineCommand(["clip", "set", "c_card"], { "clear-motion-blur": true })!.params).toEqual({ clip: "c_card", motionBlur: null });
  });

  it("refuses --clear-motion-blur with settings and an unknown blend", () => {
    expect(() => parseTimelineCommand(["clip", "set", "c_card"], { "clear-motion-blur": true, "motion-blur": true })).toThrow(/--clear-motion-blur alone/);
    expect(() => parseTimelineCommand(["clip", "set", "c_card"], { "motion-blur-blend": "log" })).toThrow(/linear or srgb/);
  });
});
