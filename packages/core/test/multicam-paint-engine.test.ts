import { ErrorCode, RpcError } from "@frameshell/protocol";
import { type MulticamGroup, type Timeline, createTimeline, parseTimeline } from "@frameshell/schema";
import { describe, expect, it } from "vitest";
import { type EditContext, type OperationRequest, applyOperation, applyPatch } from "../src/index.js";

function context(): EditContext {
  let next = 100;
  return {
    fps: 30,
    source: async () => ({ duration: 60, video: true, audio: true }),
    nestedDuration: async () => 0,
    clipTypes: async () => new Map(),
    newId: (prefix) => `${prefix}_${String(++next).padStart(4, "0")}`,
  };
}

async function rejection(promise: Promise<unknown>): Promise<RpcError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof RpcError) return error;
    throw error;
  }
  throw new Error("expected a rejection");
}

/** Two people, a screen and a wide camera without sound. */
function panel(): Timeline {
  return {
    ...createTimeline("main"),
    groups: [
      {
        id: "g_talk",
        angles: [
          { id: "ana", name: "Ana", asset: "assets/ana.mp4", offset: 0 },
          { id: "ben", name: "Ben", asset: "assets/ben.mp4", offset: 0 },
          { id: "deck", name: "Deck", asset: "assets/deck.mp4", offset: 0, screen: true },
          { id: "wide", name: "Wide", asset: "assets/wide.mp4", offset: 0, mic: null },
        ],
      },
    ],
    tracks: [{ id: "t_p", kind: "program", group: "g_talk", clips: [{ id: "c_a", type: "shot", start: 0, in: 0, out: 10, shot: "solo", angles: ["ana"] }] }],
  };
}

const paint = (args: Record<string, unknown>) => ({ op: "multicam.paint", args: { group: "g_talk", ...args } }) as OperationRequest;
const painted = (timeline: Timeline) => (timeline.groups as MulticamGroup[])[0]!.painted;

describe("multicam.paint", () => {
  it("stores a painted turn in the group and the inverse removes it", async () => {
    const before = panel();
    const applied = await applyOperation(before, paint({ angle: "ana", start: 2, end: 5.5, speaking: true }), context());
    expect(painted(applied.timeline)).toEqual([{ angle: "ana", start: 2, end: 5.5, speaking: true }]);
    expect(parseTimeline(applied.timeline).ok).toBe(true);
    expect(applied.changes.updated).toEqual(["g_talk"]);
    expect(applyPatch(applied.timeline, applied.inverse.args).groups).toEqual(before.groups);
  });

  it("replaces where it overlaps, splits a longer stretch and merges touching ones", async () => {
    let timeline = panel();
    for (const args of [
      { angle: "ana", start: 0, end: 10, speaking: true },
      { angle: "ana", start: 4, end: 6, speaking: false },
      { angle: "ana", start: 6, end: 8, speaking: false },
    ]) {
      timeline = (await applyOperation(timeline, paint(args), context())).timeline;
    }
    expect(painted(timeline)).toEqual([
      { angle: "ana", start: 0, end: 4, speaking: true },
      { angle: "ana", start: 4, end: 8, speaking: false },
      { angle: "ana", start: 8, end: 10, speaking: true },
    ]);
  });

  it("alone silences the other angles that can speak, not screens or soundless ones", async () => {
    const applied = await applyOperation(panel(), paint({ angle: "ana", start: 1, end: 3, speaking: true, alone: true }), context());
    expect(painted(applied.timeline)).toEqual([
      { angle: "ana", start: 1, end: 3, speaking: true },
      { angle: "ben", start: 1, end: 3, speaking: false },
    ]);
  });

  it("null takes a range back to measured, for one angle or for all", async () => {
    let timeline = (await applyOperation(panel(), paint({ angle: "ana", start: 1, end: 3, speaking: true, alone: true }), context())).timeline;
    timeline = (await applyOperation(timeline, paint({ angle: "ana", start: 2, end: 3, speaking: null }), context())).timeline;
    expect(painted(timeline)).toEqual([
      { angle: "ana", start: 1, end: 2, speaking: true },
      { angle: "ben", start: 1, end: 3, speaking: false },
    ]);
    timeline = (await applyOperation(timeline, paint({ start: 0, end: 10, speaking: null }), context())).timeline;
    expect("painted" in timeline.groups![0]!).toBe(false);
  });

  it("refuses what cannot be painted, naming the field", async () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ angle: "ana", start: 3, end: 3, speaking: true }, "end"],
      [{ angle: "nobody", start: 1, end: 2, speaking: true }, "angle"],
      [{ angle: "deck", start: 1, end: 2, speaking: true }, "angle"],
      [{ start: 1, end: 2, speaking: true }, "angle"],
      [{ angle: "ana", start: 1, end: 2, speaking: false, alone: true }, "alone"],
    ];
    for (const [args, field] of cases) {
      const error = await rejection(applyOperation(panel(), paint(args), context()));
      expect(error.code).toBe(ErrorCode.InvalidOperation);
      expect((error.data as { field?: string }).field).toBe(field);
    }
  });

  it("lets a screen be marked silent", async () => {
    const applied = await applyOperation(panel(), paint({ angle: "deck", start: 1, end: 2, speaking: false }), context());
    expect(painted(applied.timeline)).toEqual([{ angle: "deck", start: 1, end: 2, speaking: false }]);
  });
});
