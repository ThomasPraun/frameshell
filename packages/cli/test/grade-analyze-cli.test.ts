import type { DaemonConnection, GradeAnalyzeResult } from "@frameshell/protocol";
import { describe, expect, it } from "vitest";
import { executeTimeline, formatGradeAnalyze, parseTimelineCommand } from "../src/timeline-commands.js";

// Seam under test: `grade analyze` (ADR 0031) from argv to the `grade.analyze` request and the report.

const result: GradeAnalyzeResult = {
  view: "current",
  proposal: null,
  timeline: "main",
  clip: "c_talk",
  asset: "assets/talk.mp4",
  kind: "media",
  mode: "range",
  from: 0,
  to: 4,
  frames: 8,
  samples: [{ at: 0.25, luma: 0.28 }],
  levels: { luma: { min: 0.02, low: 0.11, mean: 0.28, high: 0.5, max: 0.62 }, saturation: 0.09, warmth: 0.091, tint: -0.004 },
  current: null,
  suggestion: { exposure: 0.62, temperature: -0.2, contrast: 1.25 },
  reasons: ["exposure +0.62: the mean brightness is 0.28, the target 0.45."],
  flags: "--grade-exposure 0.62 --grade-temperature=-0.2 --grade-contrast 1.25",
  warnings: ["c_talk already has a grade."],
};

function stub(reply: GradeAnalyzeResult) {
  const sent: { method: string; params: Record<string, unknown> }[] = [];
  const conn = {
    request: async (method: string, params: Record<string, unknown>) => {
      sent.push({ method, params });
      return reply;
    },
  } as unknown as DaemonConnection;
  return { conn, sent };
}

describe("grade analyze", () => {
  it("sends the clip and scope to grade.analyze, on the given timeline", () => {
    expect(parseTimelineCommand(["grade", "analyze", "c_talk"], { timeline: "intro", from: "2", to: "6.5", samples: "5" })).toMatchObject({
      method: "grade.analyze",
      withCwd: true,
      params: { timeline: "intro", clip: "c_talk", from: 2, to: 6.5, samples: 5 },
    });
    expect(parseTimelineCommand(["grade", "analyze", "c_talk"], { at: "1.5" })!.params).toMatchObject({ clip: "c_talk", at: 1.5 });
    // Unset: the daemon's defaults (the whole clip, 8 frames).
    expect(parseTimelineCommand(["grade", "analyze", "c_talk"], {})!.params).toEqual({ clip: "c_talk" });
  });

  it("refuses a frame with a range, bad counts, other commands' flags, and a missing clip", () => {
    expect(() => parseTimelineCommand(["grade", "analyze", "c_talk"], { at: "1", from: "0" })).toThrow(/give one/);
    expect(() => parseTimelineCommand(["grade", "analyze", "c_talk"], { samples: "0" })).toThrow(/--samples: expected a whole number from 1 to 32/);
    expect(() => parseTimelineCommand(["grade", "analyze", "c_talk"], { samples: "2.5" })).toThrow(/--samples/);
    expect(() => parseTimelineCommand(["grade", "analyze", "c_talk"], { at: "soon" })).toThrow(/--at: expected a number/);
    expect(() => parseTimelineCommand(["grade", "analyze", "c_talk"], { speed: "2" })).toThrow(/does not take --speed/);
    expect(() => parseTimelineCommand(["grade", "analyze"], {})).toThrow(/takes 1 argument/);
    expect(parseTimelineCommand(["grade", "other", "c_talk"], {})).toBeNull();
  });

  it("prints the levels, why, and the command that applies the suggestion; nothing is applied", async () => {
    const inv = parseTimelineCommand(["grade", "analyze", "c_talk"], {})!;
    const { conn, sent } = stub(result);
    const text = await executeTimeline(conn, inv, "/p", false);
    expect(sent.map((call) => call.method)).toEqual(["grade.analyze"]);
    expect(text).toContain("Grade analysis of c_talk (assets/talk.mp4) on main · 8 frames from 0.000 to 4.000 s");
    expect(text).toContain("mean 0.28");
    expect(text).toContain("warmth +0.091");
    expect(text).toContain("Suggested correction (not applied):");
    expect(text).toContain("Apply: frameshell clip set c_talk --grade-exposure 0.62 --grade-temperature=-0.2 --grade-contrast 1.25");
    expect(text).toContain("warning: c_talk already has a grade.");
  });

  it("says so when there is nothing to suggest, and prints a frame by its time", () => {
    const none = formatGradeAnalyze({ ...result, mode: "frame", from: 1.5, to: 1.5, frames: 1, suggestion: {}, flags: "", reasons: ["The picture is within the targets: no correction suggested."], warnings: [] });
    expect(none).toContain("on main · at 1.500 s");
    expect(none).toContain("No correction suggested:");
    expect(none).not.toContain("Apply:");
  });

  it("names a generated clip's render by its kind, as it has no source file", () => {
    const text = formatGradeAnalyze({ ...result, asset: null, kind: "generated" });
    expect(text).toContain("Grade analysis of c_talk (generated clip) on main");
  });

  it("gives --json the daemon's result as it is", async () => {
    const inv = parseTimelineCommand(["grade", "analyze", "c_talk"], {})!;
    expect(JSON.parse(await executeTimeline(stub(result).conn, inv, "/p", true))).toEqual(result);
  });
});
