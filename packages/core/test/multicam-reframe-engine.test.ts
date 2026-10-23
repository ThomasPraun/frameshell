import { ErrorCode, RpcError } from "@frameshell/protocol";
import { type Angle, type Timeline, createTimeline, parseTimeline } from "@frameshell/schema";
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

/** Two angles; the program track plays group 10..14 from timeline 2 (a cut took group 4..10 out). */
function podcast(): Timeline {
  return {
    ...createTimeline("main"),
    groups: [
      {
        id: "g_talk",
        angles: [
          { id: "ana", name: "Ana", asset: "assets/ana.mp4", offset: 0 },
          { id: "ben", name: "Ben", asset: "assets/ben.mp4", offset: 0, crop: { left: 0.2 } },
        ],
      },
    ],
    tracks: [
      {
        id: "t_p",
        kind: "program",
        group: "g_talk",
        clips: [
          { id: "c_a", type: "shot", start: 0, in: 2, out: 4, shot: "solo", angles: ["ana"] },
          { id: "c_b", type: "shot", start: 2, in: 10, out: 14, shot: "solo", angles: ["ben"] },
        ],
      },
    ],
  };
}

const reframe = (args: Record<string, unknown>) => ({ op: "multicam.reframe", args: { group: "g_talk", ...args } }) as OperationRequest;
const angleOf = (timeline: Timeline, id: string): Angle => timeline.groups![0]!.angles.find((angle) => angle.id === id)!;

describe("multicam.reframe", () => {
  it("adds keys in time order on the group clock, and the inverse restores the group", async () => {
    const before = podcast();
    const first = await applyOperation(before, reframe({ angle: "ana", at: 6, x: 0.3, y: 0.4 }), context());
    const second = await applyOperation(first.timeline, reframe({ angle: "ana", at: 1.23456, x: 0.7, y: 0.5 }), context());
    expect(angleOf(second.timeline, "ana").reframe).toEqual([
      { at: 1.235, x: 0.7, y: 0.5 },
      { at: 6, x: 0.3, y: 0.4 },
    ]);
    expect(parseTimeline(second.timeline).ok).toBe(true);
    expect(second.changes.updated).toEqual(["g_talk"]);
    expect(applyPatch(applyPatch(second.timeline, second.inverse.args), first.inverse.args).groups).toEqual(before.groups);
  });

  it("puts a key given in timeline seconds at the group second its shot plays then", async () => {
    const applied = await applyOperation(podcast(), reframe({ angle: "ben", time: 3, x: 0.6 }), context());
    // Shot c_b plays group 10 at timeline 2; ben's crop leaves x 0.2..1, so the point there was y = 0.5.
    expect(angleOf(applied.timeline, "ben").reframe).toEqual([{ at: 11, x: 0.6, y: 0.5 }]);
  });

  it("replaces the key in the same frame and keeps the omitted coordinate from the point there now", async () => {
    const one = await applyOperation(podcast(), reframe({ angle: "ana", at: 5, x: 0.3, y: 0.2 }), context());
    const replaced = await applyOperation(one.timeline, reframe({ angle: "ana", at: 5.01, x: 0.8 }), context());
    expect(angleOf(replaced.timeline, "ana").reframe).toEqual([{ at: 5, x: 0.8, y: 0.2 }]);
  });

  it("defaults the omitted coordinate to the interpolated point between keys", async () => {
    let timeline = podcast();
    for (const args of [
      { angle: "ana", at: 0, x: 0.2, y: 0.2 },
      { angle: "ana", at: 10, x: 0.6, y: 0.6 },
      { angle: "ana", at: 5, x: 0.9 },
    ]) {
      timeline = (await applyOperation(timeline, reframe(args), context())).timeline;
    }
    expect(angleOf(timeline, "ana").reframe![1]).toEqual({ at: 5, x: 0.9, y: 0.4 });
  });

  it("starts an angle without keys from the center of its crop", async () => {
    const applied = await applyOperation(podcast(), reframe({ angle: "ben", at: 0, y: 0.3 }), context());
    expect(angleOf(applied.timeline, "ben").reframe).toEqual([{ at: 0, x: 0.6, y: 0.3 }]);
  });

  it("removes the key in that frame, and the last one removes the field", async () => {
    const one = await applyOperation(podcast(), reframe({ angle: "ana", at: 5, x: 0.3 }), context());
    const removed = await applyOperation(one.timeline, reframe({ angle: "ana", at: 5.01, remove: true }), context());
    expect(angleOf(removed.timeline, "ana")).not.toHaveProperty("reframe");
  });

  it("clears every key", async () => {
    let timeline = podcast();
    for (const at of [0, 3]) timeline = (await applyOperation(timeline, reframe({ angle: "ana", at, x: 0.3 }), context())).timeline;
    const cleared = await applyOperation(timeline, reframe({ angle: "ana", clear: true }), context());
    expect(angleOf(cleared.timeline, "ana")).not.toHaveProperty("reframe");
  });

  it("replaces every key with `keys`, sorted, rounded, the last of one frame kept, and the inverse restores the old ones", async () => {
    const one = await applyOperation(podcast(), reframe({ angle: "ana", at: 2, x: 0.1 }), context());
    const keys = [
      { at: 8, x: 0.712345, y: 0.5 },
      { at: 1.0004, x: 0.3, y: 0.4 },
      { at: 8.01, x: 0.7, y: 0.45 },
    ];
    const replaced = await applyOperation(one.timeline, reframe({ angle: "ana", keys }), context());
    expect(angleOf(replaced.timeline, "ana").reframe).toEqual([
      { at: 1, x: 0.3, y: 0.4 },
      { at: 8.01, x: 0.7, y: 0.45 },
    ]);
    expect(parseTimeline(replaced.timeline).ok).toBe(true);
    expect(applyPatch(replaced.timeline, replaced.inverse.args).groups).toEqual(one.timeline.groups);
    const mixed = await rejection(applyOperation(podcast(), reframe({ angle: "ana", keys, at: 1 }), context()));
    expect(mixed).toMatchObject({ code: ErrorCode.InvalidOperation, message: expect.stringContaining("`keys` replaces every key") });
  });

  it("refuses unclear requests with what to pass", async () => {
    const neither = await rejection(applyOperation(podcast(), reframe({ angle: "ana", x: 0.3 }), context()));
    expect(neither).toMatchObject({ code: ErrorCode.InvalidOperation, message: expect.stringContaining("one of them") });
    const both = await rejection(applyOperation(podcast(), reframe({ angle: "ana", at: 1, time: 1, x: 0.3 }), context()));
    expect(both.message).toContain("one of them");
    const gap = await rejection(applyOperation(podcast(), reframe({ angle: "ana", time: 6, x: 0.3 }), context()));
    expect(gap.message).toContain("no shot of group g_talk plays at timeline second 6");
    const nothing = await rejection(applyOperation(podcast(), reframe({ angle: "ana", at: 1 }), context()));
    expect(nothing.message).toContain("nothing to set");
    const missing = await rejection(applyOperation(podcast(), reframe({ angle: "ana", at: 1, remove: true }), context()));
    expect(missing.message).toContain("has no reframe key at group second 1");
    const clearMore = await rejection(applyOperation(podcast(), reframe({ angle: "ana", clear: true, at: 1 }), context()));
    expect(clearMore.message).toContain("takes no other field");
    const unknown = await rejection(applyOperation(podcast(), reframe({ angle: "zoe", at: 1, x: 0.3 }), context()));
    expect(unknown.message).toContain("Angles: ana, ben");
  });
});
