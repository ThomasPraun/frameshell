import { describe, expect, it } from "vitest";
import { parseTimelineCommand } from "../src/timeline-commands.js";

// Seam under test: `transition set --kind iris --origin` and `--kind dip-cut` (ADR 0030) from argv to the request.

describe("transition set shapes (#483)", () => {
  it("passes an iris's --origin as four frame fractions", () => {
    const parsed = parseTimelineCommand(["transition", "set"], { at: "12.5", kind: "iris", origin: "0.6, 0.2,0.8,0.4" });
    expect(parsed).toMatchObject({ method: "transition.set", params: { at: 12.5, kind: "iris", origin: [0.6, 0.2, 0.8, 0.4] } });
  });

  it("passes a dip cut without origin or direction", () => {
    const parsed = parseTimelineCommand(["transition", "set"], { at: "4", kind: "dip-cut" });
    expect(parsed!.params).toEqual({ at: 4, kind: "dip-cut" });
  });

  it("refuses an --origin that is not four numbers", () => {
    for (const origin of ["0.5,0.5", "a,b,c,d", "0.1,,0.2,0.3", "0.1,0.2,0.3,0.4,0.5"]) {
      expect(() => parseTimelineCommand(["transition", "set"], { at: "1", kind: "iris", origin }), origin).toThrow(/--origin: expected x0,y0,x1,y1/);
    }
  });
});
