import { describe, expect, it } from "vitest";
import { createTimeline, parseTimeline } from "../src/index.js";

describe("timeline file", () => {
  it("scaffolds an empty timeline at revision 0 that validates", () => {
    const timeline = createTimeline("main");
    expect(timeline).toMatchObject({ schemaVersion: 1, id: "main", revision: 0, tracks: [] });
    expect(parseTimeline(timeline).ok).toBe(true);
  });

  it("rejects a negative revision", () => {
    const result = parseTimeline({ ...createTimeline("main"), revision: -1 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/revision/);
  });
});
