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

  it("takes the cuts sheet, and the per-clip kit: --pop as seconds or a name, --onion and --speed as clip ids", () => {
    expect(parseReview([], { sheets: "cuts" })).toEqual({ kind: "review", sheets: ["cuts"] });
    expect(parseReview([], { pop: "1.5" })).toEqual({ kind: "review", pop: 1.5 });
    expect(parseReview([], { pop: "hook+0.5" })).toEqual({ kind: "review", pop: "hook+0.5" });
    expect(parseReview([], { onion: "c_1", speed: "c_2" })).toEqual({ kind: "review", onion: "c_1", speed: "c_2" });
  });

  it("refuses the kit sheets in --sheets, an empty clip and a negative pop", () => {
    expect(() => parseReview([], { sheets: "pop" })).toThrow(UsageError);
    expect(() => parseReview([], { onion: " " })).toThrow("--onion takes a clip id");
    expect(() => parseReview([], { pop: "-1" })).toThrow("--pop takes seconds from 0");
  });
});
