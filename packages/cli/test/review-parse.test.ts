import { describe, expect, it } from "vitest";
import { parseReview } from "../src/review-commands.js";
import { UsageError } from "../src/timeline-commands.js";

describe("review flags", () => {
  it("takes the beats sheet only when named", () => {
    expect(parseReview([], { sheets: "beats" })).toEqual({ kind: "review", sheets: ["beats"] });
    expect(parseReview([], { sheets: "contact,beats,metrics" })).toEqual({ kind: "review", sheets: ["contact", "beats", "metrics"] });
    expect(parseReview([], {})).toEqual({ kind: "review" });
  });

  it("reads --crop-at x,y with an optional size, and --clip as the clip it follows", () => {
    expect(parseReview([], { "crop-at": "0.5,0.8" })).toEqual({ kind: "review", cropAt: { x: 0.5, y: 0.8 } });
    expect(parseReview([], { "crop-at": "0.5,0.8,0.25" })).toEqual({ kind: "review", cropAt: { x: 0.5, y: 0.8, size: 0.25 } });
    expect(parseReview([], { "crop-at": "0,1", clip: "c_1" })).toEqual({ kind: "review", cropAt: { x: 0, y: 1, clip: "c_1" } });
  });

  it("refuses a crop point off the frame, a zero size, and --clip without --crop-at", () => {
    for (const bad of ["0.5", "1.2,0.5", "0.5,0.5,0", "0.5,0.5,0.2,1", "a,b", "0.5,"]) {
      expect(() => parseReview([], { "crop-at": bad }), bad).toThrow(UsageError);
    }
    expect(() => parseReview([], { clip: "c_1" })).toThrow("pass --crop-at x,y too");
  });
});
