import { describe, expect, it } from "vitest";
import { setupTiming } from "../src/renderer/src/setup-elapsed.js";

describe("setupTiming", () => {
  it("shows nothing for a short step", () => {
    expect(setupTiming(0, 9_000, null)).toEqual({ elapsed: null, slow: false });
  });

  it("shows how long a step ran from ten seconds", () => {
    expect(setupTiming(0, 72_000, 0.4)).toEqual({ elapsed: "1:12", slow: false });
  });

  it("adds the slow hint to a long step with no percentage, like a model load on CPU", () => {
    expect(setupTiming(1_000, 601_000, null)).toEqual({ elapsed: "10:00", slow: true });
  });
});
