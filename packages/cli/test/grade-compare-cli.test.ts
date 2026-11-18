import type { DaemonConnection, GradeCompareResult } from "@frameshell/protocol";
import { describe, expect, it } from "vitest";
import { executeTimeline, parseLook, parseTimelineCommand } from "../src/timeline-commands.js";

// Seam under test: `grade compare` (ADR 0031) from argv to the `grade.compare` request and the report.

const result: GradeCompareResult = {
  view: "current",
  proposal: null,
  timeline: "main",
  clip: "c_talk",
  asset: "assets/talk.mp4",
  kind: "media",
  frame: 30,
  at: 1,
  path: "/p/.frameshell/grade/compare-c_talk-30.png",
  width: 1450,
  height: 278,
  columns: 3,
  rows: 1,
  tiles: [
    { label: "1 neutral", kind: "neutral", grade: null, flags: "--clear-grade" },
    { label: "2 current", kind: "current", grade: { exposure: 0.4 }, flags: "" },
    { label: "3 warm", kind: "look", grade: { temperature: 0.25 }, flags: "--grade-exposure 0 --grade-temperature 0.25" },
  ],
  warnings: ["Track v1 is hidden."],
};

function stub(reply: GradeCompareResult) {
  const sent: { method: string; params: Record<string, unknown> }[] = [];
  const conn = {
    request: async (method: string, params: Record<string, unknown>) => {
      sent.push({ method, params });
      return reply;
    },
  } as unknown as DaemonConnection;
  return { conn, sent };
}

describe("grade compare", () => {
  it("reads a look as [name:]field=value pairs", () => {
    expect(parseLook("warm:temperature=0.25,saturation=1.1")).toEqual({ name: "warm", temperature: 0.25, saturation: 1.1 });
    expect(parseLook("exposure=-0.5")).toEqual({ exposure: -0.5 });
    expect(parseLook("teal: lut=luts/teal.cube, lut-mix=0.6")).toEqual({ name: "teal", lut: "luts/teal.cube", lutMix: 0.6 });
    expect(() => parseLook("sepia")).toThrow(/--look: expected a built-in look .* or \[name:\]field=value/);
    expect(() => parseLook("warm:hue=2")).toThrow(/--look: expected/);
    expect(() => parseLook("contrast=high")).toThrow(/contrast expects a number/);
  });

  it("sends the clip, looks and options to grade.compare, on the given timeline", () => {
    const inv = parseTimelineCommand(["grade", "compare", "c_talk"], {
      timeline: "intro",
      look: ["warm:temperature=0.25", "contrast=1.2"],
      at: "1.5",
      out: "sheet.png",
      "tile-width": "320",
      format: "9x16",
    });
    expect(inv).toMatchObject({
      method: "grade.compare",
      withCwd: true,
      params: { timeline: "intro", clip: "c_talk", looks: [{ name: "warm", temperature: 0.25 }, { contrast: 1.2 }], at: 1.5, out: "sheet.png", tileWidth: 320, projectFormat: "9x16" },
    });
    // Unset: the daemon's defaults (the middle frame, 480 px tiles, the primary format).
    expect(parseTimelineCommand(["grade", "compare", "c_talk"], { look: ["exposure=1"] })!.params).toEqual({ clip: "c_talk", looks: [{ exposure: 1 }] });
  });

  it("refuses no look, too many, a bad tile width and other commands' flags", () => {
    expect(() => parseTimelineCommand(["grade", "compare", "c_talk"], {})).toThrow(/needs at least one --look/);
    expect(() => parseTimelineCommand(["grade", "compare", "c_talk"], { look: Array.from({ length: 17 }, () => "exposure=0") })).toThrow(/at most 16 looks/);
    expect(() => parseTimelineCommand(["grade", "compare", "c_talk"], { look: ["exposure=1"], "tile-width": "100" })).toThrow(/--tile-width/);
    expect(() => parseTimelineCommand(["grade", "compare", "c_talk"], { look: ["exposure=1"], samples: "3" })).toThrow(/does not take --samples/);
    expect(() => parseTimelineCommand(["grade", "compare"], { look: ["exposure=1"] })).toThrow(/takes 1 argument/);
  });

  it("prints the image and the clip set command that keeps each look; nothing is applied", async () => {
    const inv = parseTimelineCommand(["grade", "compare", "c_talk"], { look: ["warm:temperature=0.25"] })!;
    const { conn, sent } = stub(result);
    const text = await executeTimeline(conn, inv, "/p", false);
    expect(sent.map((call) => call.method)).toEqual(["grade.compare"]);
    expect(text).toContain("Grade compare of c_talk (assets/talk.mp4) on main · frame 30 at 1.000 s · 3 tiles, 3x1");
    expect(text).toContain("/p/.frameshell/grade/compare-c_talk-30.png (1450x278)");
    expect(text).toContain("1 neutral          frameshell clip set c_talk --clear-grade");
    expect(text).toContain("2 current          (the clip's grade now)");
    expect(text).toContain("3 warm             frameshell clip set c_talk --grade-exposure 0 --grade-temperature 0.25");
    expect(text).toContain("warning: Track v1 is hidden.");
  });

  it("names a generated or nested clip by its kind, as it has no source file", async () => {
    const inv = parseTimelineCommand(["grade", "compare", "c_talk"], { look: ["warm"] })!;
    const generated = await executeTimeline(stub({ ...result, asset: null, kind: "generated" }).conn, inv, "/p", false);
    expect(generated).toContain("Grade compare of c_talk (generated clip) on main");
    const nested = await executeTimeline(stub({ ...result, asset: null, kind: "timeline" }).conn, inv, "/p", false);
    expect(nested).toContain("Grade compare of c_talk (nested timeline) on main");
  });

  it("gives --json the daemon's result as it is", async () => {
    const inv = parseTimelineCommand(["grade", "compare", "c_talk"], { look: ["exposure=1"] })!;
    const { conn } = stub(result);
    expect(JSON.parse(await executeTimeline(conn, inv, "/p", true))).toEqual(result);
  });
});
