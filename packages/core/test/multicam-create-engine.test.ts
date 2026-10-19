import { ErrorCode, RpcError } from "@frameshell/protocol";
import { type ProgramTrack, type Timeline, createTimeline } from "@frameshell/schema";
import { describe, expect, it } from "vitest";
import { type EditContext, type OperationRequest, type SourceInfo, applyOperation, applyPatch } from "../src/index.js";

// `multicam.create` and `multicam.offset` through the engine: group, program track and grid shot in one operation, and its inverse.

const SOURCES: Record<string, SourceInfo> = {
  "assets/ana.mp4": { duration: 20, video: true, audio: true },
  "assets/ben.mp4": { duration: 18, video: true, audio: true },
  "assets/Ben Two.mov": { duration: 18, video: true, audio: true },
  "assets/mic.wav": { duration: 20, video: false, audio: true },
  "assets/still.png": { duration: null, video: true, audio: false },
};

function context(): EditContext {
  let next = 0;
  return {
    fps: 30,
    source: async (asset) => {
      const info = SOURCES[asset];
      if (!info) throw new RpcError(ErrorCode.AssetNotFound, `${asset} not found`, { path: asset });
      return info;
    },
    nestedDuration: async () => 0,
    clipTypes: async () => new Map(),
    newId: (prefix) => `${prefix}_${String(++next).padStart(4, "0")}`,
  };
}

const create = (angles: { asset: string; name?: string; offset: number }[], extra: { name?: string } = {}) =>
  ({ op: "multicam.create", args: { angles, ...extra } }) as OperationRequest;

async function rejection(promise: Promise<unknown>): Promise<RpcError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof RpcError) return error;
    throw error;
  }
  throw new Error("expected a rejection");
}

const BASE = (): Timeline => ({ ...createTimeline("main"), tracks: [{ id: "t_v", kind: "video", clips: [] }] });

describe("multicam.create", () => {
  it("adds the group, a program track on top and one grid shot over the whole length, with an inverse", async () => {
    const before = BASE();
    const applied = await applyOperation(
      before,
      create([
        { asset: "assets/ana.mp4", name: "Ana", offset: 0 },
        { asset: "assets/ben.mp4", name: "Ben", offset: 2.5 },
      ]),
      context(),
    );
    expect(applied.timeline.groups).toEqual([
      {
        id: "g_0001",
        angles: [
          { id: "ana", name: "Ana", asset: "assets/ana.mp4", offset: 0 },
          { id: "ben", name: "Ben", asset: "assets/ben.mp4", offset: 2.5 },
        ],
      },
    ]);
    // Ben ends at 2.5 + 18 = 20.5 s, later than Ana (20 s).
    expect(applied.timeline.tracks.map((track) => track.id)).toEqual(["t_v", "t_0002"]);
    expect(applied.timeline.tracks[1]).toEqual({
      id: "t_0002",
      kind: "program",
      name: "Multicam",
      group: "g_0001",
      clips: [{ id: "c_0003", type: "shot", start: 0, in: 0, out: 20.5, shot: "grid", angles: ["ana", "ben"] }],
    });
    expect(applied.changes.added).toEqual(["g_0001", "t_0002"]);
    expect(applied.timeline.revision).toBe(before.revision + 1);

    const restored = applyPatch(applied.timeline, applied.inverse.args);
    expect(restored.groups).toBeUndefined();
    expect(restored.tracks).toEqual(before.tracks);
  });

  it("names angles after the files by default, keeps ids unique and names the group and track", async () => {
    const { timeline } = await applyOperation(
      BASE(),
      create([{ asset: "assets/ben.mp4", offset: 0 }, { asset: "assets/Ben Two.mov", name: "ben", offset: 0 }], { name: "Podcast" }),
      context(),
    );
    expect(timeline.groups![0]).toMatchObject({
      name: "Podcast",
      angles: [{ id: "ben", name: "ben" }, { id: "ben-2", name: "ben" }],
    });
    expect(timeline.tracks.at(-1)).toMatchObject({ name: "Podcast" });
  });

  it("makes a second group beside the first, each with its own program track", async () => {
    const files = [{ asset: "assets/ana.mp4", offset: 0 }, { asset: "assets/ben.mp4", offset: 0 }];
    const first = await applyOperation(BASE(), create(files), context());
    const ctx = context();
    ctx.newId = (prefix) => `${prefix}_x${Math.random().toString(16).slice(2, 8)}`;
    const second = await applyOperation(first.timeline, create(files), ctx);
    expect(second.timeline.groups).toHaveLength(2);
    expect(second.timeline.tracks.filter((track) => track.kind === "program")).toHaveLength(2);
  });

  it("refuses a file twice, a file without a picture and a still image, saying how to fix it", async () => {
    const twice = await rejection(applyOperation(BASE(), create([{ asset: "assets/ana.mp4", offset: 0 }, { asset: "assets/ana.mp4", offset: 0 }]), context()));
    expect(twice).toMatchObject({ code: ErrorCode.InvalidOperation, message: expect.stringContaining("listed twice") });
    for (const asset of ["assets/mic.wav", "assets/still.png"]) {
      const error = await rejection(applyOperation(BASE(), create([{ asset: "assets/ana.mp4", offset: 0 }, { asset, offset: 0 }]), context()));
      expect(error.message).toContain(`${asset} has no moving picture`);
    }
    const missing = await rejection(applyOperation(BASE(), create([{ asset: "assets/ana.mp4", offset: 0 }, { asset: "assets/nope.mp4", offset: 0 }]), context()));
    expect(missing.code).toBe(ErrorCode.AssetNotFound);
  });
});

describe("multicam.offset", () => {
  async function grouped() {
    const { timeline } = await applyOperation(
      BASE(),
      create([{ asset: "assets/ana.mp4", name: "Ana", offset: 0 }, { asset: "assets/ben.mp4", name: "Ben", offset: 1 }]),
      context(),
    );
    return timeline;
  }
  const shotEnd = (timeline: Timeline) => (timeline.tracks.find((t) => t.kind === "program") as ProgramTrack).clips[0]!.out;

  it("sets one angle's offset (3 decimals) and the inverse restores it", async () => {
    const before = await grouped();
    expect(shotEnd(before)).toBe(20);
    const applied = await applyOperation(before, { op: "multicam.offset", args: { group: "g_0001", angle: "ben", offset: 1.4237 } }, context());
    expect(applied.timeline.groups![0]!.angles[1]!.offset).toBe(1.424);
    expect(applied.changes.updated).toContain("g_0001");
    expect(applyPatch(applied.timeline, applied.inverse.args).groups).toEqual(before.groups);
  });

  it("refuses an offset that leaves the initial shot past the group's end", async () => {
    const { timeline } = await applyOperation(
      BASE(),
      create([{ asset: "assets/ana.mp4", offset: 0 }, { asset: "assets/ben.mp4", offset: 5 }]),
      context(),
    );
    expect(shotEnd(timeline)).toBe(23);
    const error = await rejection(applyOperation(timeline, { op: "multicam.offset", args: { group: "g_0001", angle: "ben", offset: 0 } }, context()));
    expect(error).toMatchObject({ code: ErrorCode.InvalidOperation, message: expect.stringContaining("past its end (20 s)") });
  });

  it("explains an unknown group or angle", async () => {
    const before = await grouped();
    const group = await rejection(applyOperation(before, { op: "multicam.offset", args: { group: "g_nope", angle: "ben", offset: 1 } }, context()));
    expect(group.message).toContain("Groups: g_0001");
    const angle = await rejection(applyOperation(before, { op: "multicam.offset", args: { group: "g_0001", angle: "zoe", offset: 1 } }, context()));
    expect(angle.message).toContain("Angles: ana, ben");
  });
});
