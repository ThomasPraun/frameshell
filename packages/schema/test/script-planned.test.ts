import { describe, expect, it } from "vitest";
import { parseScript, parseScriptPlan, readPlannedRange } from "../src/index.js";

describe("readPlannedRange (ADR 0015)", () => {
  it("reads a clock range in seconds", () => {
    expect(readPlannedRange("Hook (0:06-0:18)")).toEqual({ range: { start: 6, end: 18 }, reversed: false });
    expect(readPlannedRange("Hook (1:02:03.5 – 1:02:10)").range).toEqual({ start: 3723.5, end: 3730 });
  });

  it("reads bars as inclusive 1-based bar refs, and explicit grid refs as written", () => {
    expect(readPlannedRange("Proof (bars 4-9)").range).toEqual({ start: "bar:4", end: "bar:10" });
    expect(readPlannedRange("Proof (Bar 2)").range).toEqual({ start: "bar:2", end: "bar:3" });
    expect(readPlannedRange("Proof (bar:4-bar:10)").range).toEqual({ start: "bar:4", end: "bar:10" });
    expect(readPlannedRange("Proof (beat:1 – beat:9)").range).toEqual({ start: "beat:1", end: "beat:9" });
  });

  it("prefers the clock range, which needs no grid, whatever the order", () => {
    expect(readPlannedRange("Proof (bars 4-9, 0:06-0:18)").range).toEqual({ start: 6, end: 18 });
    expect(readPlannedRange("Proof (0:06-0:18; bars 4-9)").range).toEqual({ start: 6, end: 18 });
  });

  it("names no range for a heading without one, and flags a reversed range", () => {
    expect(readPlannedRange("Proof")).toEqual({ range: null, reversed: false });
    expect(readPlannedRange("Proof (draft)")).toEqual({ range: null, reversed: false });
    expect(readPlannedRange("Proof (0:18-0:06)")).toEqual({ range: null, reversed: true });
    expect(readPlannedRange("Proof (bars 9-4)")).toEqual({ range: null, reversed: true });
    expect(readPlannedRange("Proof (0:18-0:06, bars 4-9)")).toEqual({ range: { start: "bar:4", end: "bar:10" }, reversed: false });
  });
});

describe("parseScriptPlan", () => {
  it("gives each scene's range in file order, leaving titles and slugs as parseScript has them", () => {
    const text = "## Hook (0:00-0:06)\nA.\n## Plain\nB.\n## Proof (bars 4-9)\nC.\n## Backwards (0:20-0:10)\nD.\n";
    const { outline, planned } = parseScriptPlan(text);
    expect(planned).toEqual([{ start: 0, end: 6 }, null, { start: "bar:4", end: "bar:10" }, null]);
    expect(outline).toEqual(parseScript(text));
    expect(outline.scenes[0]!.title).toBe("Hook (0:00-0:06)");
    expect(outline.warnings).toEqual(["Line 7: heading range ends before it starts; planned range ignored."]);
  });

  it("reads the heading as written in a shoot script, where the title loses its timing", () => {
    const { outline, planned } = parseScriptPlan("---\nshoot: true\n---\n## Hook (0:05–0:14)\nHello there.\n");
    expect(outline.scenes[0]!.title).toBe("Hook");
    expect(planned).toEqual([{ start: 5, end: 14 }]);
  });
});
