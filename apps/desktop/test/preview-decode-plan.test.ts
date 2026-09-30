import { describe, expect, it } from "vitest";
import { type DecodeStep, decodeSteps, syncTable } from "../src/renderer/src/preview/decode-plan.js";

// Seam under test: the decode plan of one media span (ADR 0001: decode from the keyframe before the in-point, discard pre-roll).

/** Proxy of `count` samples with a keyframe every 15 (the proxy recipe's GOP). */
const gop15 = (count: number) => syncTable(Array.from({ length: count }, (_, i) => i % 15 === 0));

const span = (start: number, end: number, inFrame: number, speed = 1) => ({ start, end, in: inFrame, speed });

/** Compact form: `sample:from-to`, `sample:-` for pre-roll that is decoded and dropped, `K` marks key chunks. */
const compact = (steps: Iterable<DecodeStep>) =>
  [...steps].map((s) => `${s.key ? "K" : ""}${s.sample}:${s.from === s.to ? "-" : `${s.from}-${s.to}`}`);

describe("decodeSteps", () => {
  it("starts at the keyframe before the in-point and drops the pre-roll", () => {
    expect(compact(decodeSteps(span(100, 104, 18), 100, gop15(60)))).toEqual([
      "K15:-",
      "16:-",
      "17:-",
      "18:100-101",
      "19:101-102",
      "20:102-103",
      "21:103-104",
    ]);
  });

  it("starts mid-span from the requested frame (seek), still from a keyframe", () => {
    expect(compact(decodeSteps(span(0, 40, 0), 31, gop15(60)))).toEqual([
      "K30:-",
      "31:31-32",
      ...Array.from({ length: 8 }, (_, k) => `${32 + k}:${32 + k}-${33 + k}`),
    ]);
  });

  it("needs no pre-roll when the in-point is a keyframe, and marks every keyframe it passes", () => {
    expect(compact(decodeSteps(span(0, 2, 15), 0, gop15(60)))).toEqual(["K15:0-1", "16:1-2"]);
    expect(compact(decodeSteps(span(0, 3, 14), 0, gop15(60)))).toEqual(["K0:-", ...Array.from({ length: 13 }, (_, k) => `${k + 1}:-`), "14:0-1", "K15:1-2", "16:2-3"]);
  });

  it("holds each source frame over two program frames at half speed", () => {
    expect(compact(decodeSteps(span(0, 6, 30, 0.5), 0, gop15(60)))).toEqual(["K30:0-2", "31:2-4", "32:4-6"]);
  });

  it("skips source frames at double speed, decoding but not showing them", () => {
    expect(compact(decodeSteps(span(0, 3, 30, 2), 0, gop15(60)))).toEqual(["K30:0-1", "31:-", "32:1-2", "33:-", "34:2-3"]);
  });

  it("jumps to a later keyframe instead of decoding a whole GOP it does not show (high speed)", () => {
    expect(compact(decodeSteps(span(0, 2, 0, 20), 0, gop15(60)))).toEqual(["K0:0-1", "K15:-", "16:-", "17:-", "18:-", "19:-", "20:1-2"]);
  });

  it("holds the last proxy frame when the span runs past the end of the proxy (rounding)", () => {
    expect(compact(decodeSteps(span(0, 3, 58), 0, gop15(60)))).toEqual(["K45:-", ...Array.from({ length: 12 }, (_, k) => `${46 + k}:-`), "58:0-1", "59:1-3"]);
  });

  it("plans nothing when the requested frame is past the span", () => {
    expect(compact(decodeSteps(span(0, 3, 0), 3, gop15(60)))).toEqual([]);
  });
});
