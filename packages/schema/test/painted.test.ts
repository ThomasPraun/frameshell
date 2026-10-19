import { describe, expect, it } from "vitest";
import { MulticamGroupSchema, type PaintedTurn, paintStretches } from "../src/index.js";

const order = ["ana", "ben"];
const stretch = (angle: string, start: number, end: number, speaking = true): PaintedTurn => ({ angle, start, end, speaking });

describe("paintStretches", () => {
  it("adds a stretch and sorts by group order, then start", () => {
    const result = paintStretches([stretch("ben", 5, 6)], { angle: "ana", start: 8, end: 9, speaking: true }, order);
    expect(result).toEqual([stretch("ana", 8, 9), stretch("ben", 5, 6)]);
  });

  it("replaces the middle of a longer stretch, keeping both sides", () => {
    const result = paintStretches([stretch("ana", 0, 10)], { angle: "ana", start: 4, end: 6, speaking: false }, order);
    expect(result).toEqual([stretch("ana", 0, 4), stretch("ana", 4, 6, false), stretch("ana", 6, 10)]);
  });

  it("merges touching stretches of one kind, not of different kinds", () => {
    const start = [stretch("ana", 0, 2), stretch("ana", 4, 6, false)];
    expect(paintStretches(start, { angle: "ana", start: 2, end: 4, speaking: true }, order)).toEqual([stretch("ana", 0, 4), stretch("ana", 4, 6, false)]);
  });

  it("removes the range for null and leaves other angles alone", () => {
    const start = [stretch("ana", 0, 10), stretch("ben", 2, 4)];
    expect(paintStretches(start, { angle: "ana", start: 2, end: 4, speaking: null }, order)).toEqual([stretch("ana", 0, 2), stretch("ana", 4, 10), stretch("ben", 2, 4)]);
  });

  it("rounds to milliseconds and does not change its input", () => {
    const start = [stretch("ana", 0, 10)];
    paintStretches(start, { angle: "ana", start: 1.00049, end: 2.0004, speaking: false }, order);
    expect(start).toEqual([stretch("ana", 0, 10)]);
    expect(paintStretches([], { angle: "ana", start: 1.00049, end: 2.0004, speaking: true }, order)).toEqual([stretch("ana", 1, 2)]);
  });
});

describe("painted turns in a group", () => {
  const group = (painted: unknown) => ({
    id: "g_1",
    angles: [
      { id: "ana", name: "Ana", asset: "assets/ana.mp4", offset: 0 },
      { id: "ben", name: "Ben", asset: "assets/ben.mp4", offset: 0 },
    ],
    painted,
  });

  it("accepts stretches of known angles that do not overlap", () => {
    expect(MulticamGroupSchema.safeParse(group([stretch("ana", 0, 2), stretch("ana", 2, 3, false), stretch("ben", 1, 2.5)])).success).toBe(true);
  });

  it.each([
    ["an unknown angle", [stretch("cy", 0, 1)], /does not have/],
    ["an empty stretch", [stretch("ana", 2, 2)], /end after/],
    ["overlapping stretches of one angle", [stretch("ana", 0, 3), stretch("ana", 2, 4)], /overlap/],
  ])("rejects %s", (_name, painted, message) => {
    const result = MulticamGroupSchema.safeParse(group(painted));
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toMatch(message);
  });
});
