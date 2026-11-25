import { describe, expect, it } from "vitest";
import { tabOverflow } from "../src/renderer/src/tab-overflow.js";

const tabs = [
  { start: 0, end: 60 },
  { start: 60, end: 120 },
  { start: 120, end: 180 },
  { start: 180, end: 240 },
];

describe("tabOverflow", () => {
  it("says nothing is hidden when every tab fits", () => {
    expect(tabOverflow(tabs, 0, 300)).toEqual({ before: false, after: false, hidden: [] });
  });

  it("lists the tabs cut off at the end, a partly shown one included", () => {
    expect(tabOverflow(tabs, 0, 150)).toEqual({ before: false, after: true, hidden: [2, 3] });
  });

  it("lists the tabs scrolled past at the start", () => {
    expect(tabOverflow(tabs, 90, 150)).toEqual({ before: true, after: false, hidden: [0, 1] });
  });

  it("ignores a sub-pixel edge", () => {
    expect(tabOverflow(tabs, 0, 239)).toEqual({ before: false, after: false, hidden: [] });
  });
});
