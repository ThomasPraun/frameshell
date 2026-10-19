import { ErrorCode, RpcError } from "@frameshell/protocol";
import { type ProgramTrack, type ShotClip, type Timeline, createTimeline } from "@frameshell/schema";
import { describe, expect, it } from "vitest";
import { DIRECTOR_TEMPLATES } from "@frameshell/schema";
import { type EditContext, type OperationRequest, type SourceInfo, applyOperation, applyPatch } from "../src/index.js";

// Screen and pip shots through the edit engine: shot.set, multicam.angle and multicam.direct.
const SOURCES: Record<string, SourceInfo> = {
  "assets/ana.mp4": { duration: 20, video: true, audio: true },
  "assets/ben.mp4": { duration: 20, video: true, audio: true },
  "assets/slides.mp4": { duration: 20, video: true, audio: false },
};

function context(): EditContext {
  let next = 100;
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

async function rejection(promise: Promise<unknown>): Promise<RpcError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof RpcError) return error;
    throw error;
  }
  throw new Error("expected a rejection");
}

function talk(screenMarked = true): Timeline {
  return {
    ...createTimeline("main"),
    groups: [
      {
        id: "g_talk",
        angles: [
          { id: "ana", name: "Ana", asset: "assets/ana.mp4", offset: 0 },
          { id: "ben", name: "Ben", asset: "assets/ben.mp4", offset: 0 },
          { id: "slides", name: "Slides", asset: "assets/slides.mp4", offset: 0, ...(screenMarked ? { screen: true } : {}) },
        ],
      },
    ],
    tracks: [
      {
        id: "t_p",
        kind: "program",
        group: "g_talk",
        clips: [
          { id: "c_a", type: "shot", start: 0, in: 0, out: 4, shot: "solo", angles: ["ana"], confidence: 0.9, reason: "ana speaks" },
          { id: "c_b", type: "shot", start: 4, in: 4, out: 8, shot: "two-up", angles: ["ana", "ben"] },
        ],
      },
    ],
  };
}

const run = (op: string, args: Record<string, unknown>, timeline = talk()) => applyOperation(timeline, { op, args } as OperationRequest, context());
const clip = (timeline: Timeline, id: string) => (timeline.tracks.find((track) => track.kind === "program") as ProgramTrack).clips.find((c) => c.id === id) as ShotClip;

describe("shot.set with screen and pip", () => {
  it("turns a solo into a pip with the screen first, then the person", async () => {
    const applied = await run("shot.set", { clip: "c_a", shot: "pip" });
    expect(clip(applied.timeline, "c_a")).toEqual({ id: "c_a", type: "shot", start: 0, in: 0, out: 4, shot: "pip", angles: ["slides", "ana"] });
    expect(applyPatch(applied.timeline, applied.inverse.args).tracks).toEqual(talk().tracks);
  });

  it("turns a solo into a screen with the marked angle", async () => {
    const applied = await run("shot.set", { clip: "c_a", shot: "screen" });
    expect(clip(applied.timeline, "c_a")).toMatchObject({ shot: "screen", angles: ["slides"] });
  });

  it("sets the corner with the layout, keeps it while the layout stays pip, and drops it with the layout", async () => {
    const pip = await run("shot.set", { clip: "c_a", shot: "pip", angles: ["slides", "ben"], corner: "top-left" });
    expect(clip(pip.timeline, "c_a")).toMatchObject({ shot: "pip", angles: ["slides", "ben"], corner: "top-left" });
    const moved = await run("shot.set", { clip: "c_a", corner: "bottom-left" }, pip.timeline);
    expect(clip(moved.timeline, "c_a")).toMatchObject({ corner: "bottom-left" });
    const swapped = await run("shot.set", { clip: "c_a", angles: ["slides", "ana"] }, moved.timeline);
    expect(clip(swapped.timeline, "c_a")).toMatchObject({ shot: "pip", corner: "bottom-left" });
    const solo = await run("shot.set", { clip: "c_a", shot: "solo", angles: ["ana"] }, swapped.timeline);
    expect(clip(solo.timeline, "c_a")).not.toHaveProperty("corner");
  });

  it("refuses a corner on a layout that has none and a wrong angle count, naming the fix", async () => {
    const corner = await rejection(run("shot.set", { clip: "c_a", corner: "top-left" }));
    expect(corner).toMatchObject({ code: ErrorCode.InvalidOperation, data: { field: "corner" } });
    expect(corner.message).toContain("no corner");
    const count = await rejection(run("shot.set", { clip: "c_a", shot: "pip", angles: ["slides"] }));
    expect(count.message).toContain("a pip shot takes exactly 2 angles; got 1");
  });
});

describe("multicam.angle screen", () => {
  it("marks and clears the screen flag, and the inverse restores the group", async () => {
    const marked = await run("multicam.angle", { group: "g_talk", angle: "ana", screen: true });
    expect(marked.timeline.groups![0]!.angles[0]).toMatchObject({ id: "ana", screen: true });
    const cleared = await run("multicam.angle", { group: "g_talk", angle: "ana", screen: false }, marked.timeline);
    expect(cleared.timeline.groups![0]!.angles[0]).not.toHaveProperty("screen");
    expect(applyPatch(marked.timeline, marked.inverse.args).groups).toEqual(talk().groups);
  });
});

describe("multicam.direct with screens", () => {
  const rules = {
    ...DIRECTOR_TEMPLATES.interview,
    minShot: 0,
    maxShot: null,
    cutLead: 0,
    wide: { silence: null, laughter: null, together: 3 },
    twoShot: { exchange: null, overlap: null },
  };
  const args = {
    group: "g_talk",
    turns: [
      { angle: "ana", start: 0, end: 6 },
      { angle: "ben", start: 6, end: 12 },
    ],
    motion: [{ angle: "slides", start: 3, end: 9 }],
    rules,
    keep: [],
  };

  it("writes pip shots with the rules' corner for the screen angle in motion", async () => {
    const applied = await run("multicam.direct", args);
    const track = applied.timeline.tracks.find((t) => t.kind === "program") as ProgramTrack;
    const rows = track.clips.map((c) => [c.in, c.out, c.shot, c.angles.join(","), c.corner ?? null]);
    expect(rows.filter((row) => row[2] === "pip")).toEqual([
      [3, 6, "pip", "slides,ana", "bottom-right"],
      [6, 8, "pip", "slides,ben", "bottom-right"],
    ]);
  });

  it("never shows an unmarked angle as a screen, and a screen as a person", async () => {
    const unmarked = await run("multicam.direct", args, talk(false));
    const track = unmarked.timeline.tracks.find((t) => t.kind === "program") as ProgramTrack;
    expect(track.clips.some((c) => c.shot === "pip")).toBe(false);
    const marked = await run("multicam.direct", { ...args, motion: [] });
    const shots = (marked.timeline.tracks.find((t) => t.kind === "program") as ProgramTrack).clips;
    expect(shots.every((c) => !c.angles.includes("slides"))).toBe(true);
  });
});
