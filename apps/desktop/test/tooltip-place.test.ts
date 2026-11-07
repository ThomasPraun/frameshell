import { describe, expect, it } from "vitest";
import { placeTooltip } from "../src/renderer/src/tooltip-place.js";

const viewport = { width: 800, height: 600 };
const size = { width: 100, height: 20 };

describe("placeTooltip", () => {
  it("centers the tooltip below its control", () => {
    expect(placeTooltip({ left: 300, top: 100, width: 20, height: 20 }, size, viewport)).toEqual({ left: 260, top: 126, side: "below" });
  });

  it("goes above the control when there is no room below", () => {
    expect(placeTooltip({ left: 300, top: 570, width: 20, height: 20 }, size, viewport)).toEqual({ left: 260, top: 544, side: "above" });
  });

  it("stays below when there is no room above either", () => {
    expect(placeTooltip({ left: 300, top: 10, width: 20, height: 20 }, size, { width: 800, height: 40 }).side).toBe("below");
  });

  it("shifts sideways to stay inside the window", () => {
    expect(placeTooltip({ left: 0, top: 100, width: 20, height: 20 }, size, viewport).left).toBe(6);
    expect(placeTooltip({ left: 790, top: 100, width: 10, height: 20 }, size, viewport).left).toBe(694);
  });
});
