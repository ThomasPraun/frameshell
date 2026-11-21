import { describe, expect, it } from "vitest";
import { type MeasuredText, textFitProblems, textFitTimes } from "../src/clips/text-fit.js";

const SIZE = { width: 100, height: 50 };
const line = (selector: string, x: number, width: number, spill = { right: 0, bottom: 0 }): MeasuredText => ({
  selector,
  text: selector,
  text_box: { x, y: 10, width, height: 10 },
  spill,
});

describe("text fit", () => {
  it("checks 50, 70 and 90 percent of the played part", () => {
    expect(textFitTimes(2, 4)).toEqual([4, 4.8, 5.6]);
  });

  it("finds text past the frame and past its box, worst time per element and kind, worst first", () => {
    const problems = textFitProblems(
      [
        [line("#a", 10, 50), line("#b", 90, 20)],
        [line("#a", 10, 50, { right: 6, bottom: 0 }), line("#b", 95, 20, { right: 0, bottom: 3 })],
      ],
      [1, 2],
      SIZE,
    );
    expect(problems).toEqual([
      { kind: "outside", at: 2, by: 15, side: "right", selector: "#b", text: "#b", box: { x: 95, y: 10, width: 20, height: 10 } },
      { kind: "overflows", at: 2, by: 6, side: "right", selector: "#a", text: "#a", box: { x: 10, y: 10, width: 50, height: 10 } },
      { kind: "overflows", at: 2, by: 3, side: "bottom", selector: "#b", text: "#b", box: { x: 95, y: 10, width: 20, height: 10 } },
    ]);
  });

  it("forgives one pixel of rounding", () => {
    expect(textFitProblems([[line("#a", -1, 101, { right: 1, bottom: 0.5 })]], [0], SIZE)).toEqual([]);
  });
});
