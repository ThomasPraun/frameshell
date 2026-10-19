import { ErrorCode, RpcError } from "@frameshell/protocol";
import { type ProgramTrack, type ShotClip, type Timeline, createTimeline } from "@frameshell/schema";
import { describe, expect, it } from "vitest";
import { type EditContext, type OperationRequest, type SourceInfo, applyOperation, applyPatch } from "../src/index.js";

const SOURCES: Record<string, SourceInfo> = {
  "assets/ana.mp4": { duration: 20, video: true, audio: true },
  "assets/ben.mp4": { duration: 20, video: true, audio: true },
  "assets/cleo.mp4": { duration: 20, video: true, audio: true },
  "assets/mic.wav": { duration: 20, video: false, audio: true },
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

/** Three angles (one audio-only, never shown), a director's two-up shot and a solo one. */
function podcast(): Timeline {
  return {
    ...createTimeline("main"),
    groups: [
      {
        id: "g_talk",
        angles: [
          { id: "ana", name: "Ana", asset: "assets/ana.mp4", offset: 0 },
          { id: "ben", name: "Ben", asset: "assets/ben.mp4", offset: 0, crop: { left: 0.1 }, audio: { gain: -2 } },
          { id: "cleo", name: "Cleo", asset: "assets/cleo.mp4", offset: 0 },
        ],
      },
      { id: "g_mic", angles: [{ id: "mic", name: "Mic", asset: "assets/mic.wav", offset: 0 }] },
    ],
    tracks: [
      { id: "t_v", kind: "video", clips: [{ id: "c_media", type: "media", asset: "assets/ana.mp4", start: 0, in: 0, out: 2 }] },
      {
        id: "t_p",
        kind: "program",
        group: "g_talk",
        clips: [
          { id: "c_a", type: "shot", start: 0, in: 0, out: 4, shot: "two-up", angles: ["ana", "ben"], confidence: 0.4, reason: "quick exchange" },
          { id: "c_b", type: "shot", start: 4, in: 4, out: 8, shot: "solo", angles: ["cleo"] },
        ],
      },
    ],
  };
}

const shotSet = (args: Record<string, unknown>) => ({ op: "shot.set", args }) as OperationRequest;
const angleSet = (args: Record<string, unknown>) => ({ op: "multicam.angle", args: { group: "g_talk", ...args } }) as OperationRequest;
const shot = (timeline: Timeline, id: string) =>
  (timeline.tracks.find((track) => track.kind === "program") as ProgramTrack).clips.find((clip) => clip.id === id) as ShotClip;

describe("shot.set", () => {
  it("sets layout and angles, drops the director's confidence and reason, and the inverse restores the shot", async () => {
    const before = podcast();
    const applied = await applyOperation(before, shotSet({ clip: "c_a", shot: "solo", angles: ["ben"] }), context());
    expect(shot(applied.timeline, "c_a")).toEqual({ id: "c_a", type: "shot", start: 0, in: 0, out: 4, shot: "solo", angles: ["ben"] });
    expect(applied.changes).toMatchObject({ updated: ["c_a"], range: { from: 0, to: 4 } });
    expect(applyPatch(applied.timeline, applied.inverse.args).tracks).toEqual(before.tracks);
  });

  it("with only a layout keeps the angles, cut to the count or filled from the group in group order", async () => {
    const solo = await applyOperation(podcast(), shotSet({ clip: "c_a", shot: "solo" }), context());
    expect(shot(solo.timeline, "c_a")).toMatchObject({ shot: "solo", angles: ["ana"] });
    const twoUp = await applyOperation(podcast(), shotSet({ clip: "c_b", shot: "two-up" }), context());
    expect(shot(twoUp.timeline, "c_b")).toMatchObject({ shot: "two-up", angles: ["cleo", "ana"] });
    const grid = await applyOperation(podcast(), shotSet({ clip: "c_a", shot: "grid" }), context());
    expect(shot(grid.timeline, "c_a")).toMatchObject({ shot: "grid", angles: ["ana", "ben"] });
  });

  it("with only angles keeps a layout that fits, else follows the count", async () => {
    const swap = await applyOperation(podcast(), shotSet({ clip: "c_a", angles: ["ben", "ana"] }), context());
    expect(shot(swap.timeline, "c_a")).toMatchObject({ shot: "two-up", angles: ["ben", "ana"] });
    const one = await applyOperation(podcast(), shotSet({ clip: "c_a", angles: ["cleo"] }), context());
    expect(shot(one.timeline, "c_a")).toMatchObject({ shot: "solo", angles: ["cleo"] });
    const two = await applyOperation(podcast(), shotSet({ clip: "c_b", angles: ["cleo", "ana"] }), context());
    expect(shot(two.timeline, "c_b")).toMatchObject({ shot: "two-up", angles: ["cleo", "ana"] });
    const three = await applyOperation(podcast(), shotSet({ clip: "c_a", angles: ["ana", "ben", "cleo"] }), context());
    expect(shot(three.timeline, "c_a")).toMatchObject({ shot: "grid", angles: ["ana", "ben", "cleo"] });
  });

  it("refuses a count the layout does not take, unknown or repeated angles, and clips that are not shots", async () => {
    const solo = await rejection(applyOperation(podcast(), shotSet({ clip: "c_a", shot: "solo", angles: ["ana", "ben"] }), context()));
    expect(solo).toMatchObject({ code: ErrorCode.InvalidOperation, message: expect.stringContaining("a solo shot takes exactly 1 angle; got 2") });
    const twoUp = await rejection(applyOperation(podcast(), shotSet({ clip: "c_a", shot: "two-up", angles: ["ana", "ben", "cleo"] }), context()));
    expect(twoUp.message).toContain("a two-up shot takes exactly 2 angles; got 3");
    const grid = await rejection(applyOperation(podcast(), shotSet({ clip: "c_a", shot: "grid", angles: ["ana"] }), context()));
    expect(grid.message).toContain("a grid shot takes 2 or more angles; got 1");
    const unknown = await rejection(applyOperation(podcast(), shotSet({ clip: "c_a", angles: ["zoe"] }), context()));
    expect(unknown.message).toContain("Angles: ana, ben, cleo");
    const twice = await rejection(applyOperation(podcast(), shotSet({ clip: "c_a", angles: ["ana", "ana"] }), context()));
    expect(twice.message).toContain('angle "ana" is listed twice');
    const media = await rejection(applyOperation(podcast(), shotSet({ clip: "c_media", shot: "solo" }), context()));
    expect(media.message).toContain("c_media is a media clip");
    const nothing = await rejection(applyOperation(podcast(), shotSet({ clip: "c_a" }), context()));
    expect(nothing.message).toContain("nothing to set");
  });

  it("refuses a layout the group has too few angles for, and an angle without a picture", async () => {
    const few = podcast();
    few.groups![0]!.angles.splice(0, 2);
    (few.tracks[1] as ProgramTrack).clips.splice(0, 1);
    const error = await rejection(applyOperation(few, shotSet({ clip: "c_b", shot: "two-up" }), context()));
    expect(error.message).toContain("group g_talk has 1");

    const blind = podcast();
    blind.groups![0]!.angles.push({ id: "mic", name: "Mic", asset: "assets/mic.wav", offset: 0 });
    const noPicture = await rejection(applyOperation(blind, shotSet({ clip: "c_b", angles: ["mic"] }), context()));
    expect(noPicture.message).toContain("has no video stream");
  });
});

describe("multicam.angle", () => {
  it("renames an angle, keeping its id, and the inverse restores the group", async () => {
    const before = podcast();
    const applied = await applyOperation(before, angleSet({ angle: "ana", name: "Ana María" }), context());
    expect(applied.timeline.groups![0]!.angles[0]).toEqual({ id: "ana", name: "Ana María", asset: "assets/ana.mp4", offset: 0 });
    expect(applied.changes.updated).toEqual(["g_talk"]);
    expect(applied.changes.range).toEqual({ from: 0, to: 8 });
    expect(applyPatch(applied.timeline, applied.inverse.args).groups).toEqual(before.groups);
  });

  it("merges crop sides, drops zero sides and clears with null", async () => {
    const merged = await applyOperation(podcast(), angleSet({ angle: "ben", crop: { right: 0.15, top: 0.05 } }), context());
    expect(merged.timeline.groups![0]!.angles[1]!.crop).toEqual({ left: 0.1, right: 0.15, top: 0.05 });
    const zero = await applyOperation(podcast(), angleSet({ angle: "ben", crop: { left: 0 } }), context());
    expect(zero.timeline.groups![0]!.angles[1]!.crop).toBeUndefined();
    const cleared = await applyOperation(podcast(), angleSet({ angle: "ben", crop: null }), context());
    expect(cleared.timeline.groups![0]!.angles[1]).not.toHaveProperty("crop");
  });

  it("refuses a crop that leaves no picture", async () => {
    const error = await rejection(applyOperation(podcast(), angleSet({ angle: "ben", crop: { right: 0.9 } }), context()));
    expect(error).toMatchObject({ code: ErrorCode.InvalidOperation, message: expect.stringContaining("left + right = 1") });
  });

  it("sets gain and mute of the angle's sound, storing no defaults", async () => {
    const muted = await applyOperation(podcast(), angleSet({ angle: "ana", gain: -6, muted: true }), context());
    expect(muted.timeline.groups![0]!.angles[0]!.audio).toEqual({ gain: -6, muted: true });
    const reset = await applyOperation(podcast(), angleSet({ angle: "ben", gain: 0, muted: false }), context());
    expect(reset.timeline.groups![0]!.angles[1]).not.toHaveProperty("audio");
  });

  it("names the transcript speaker whose words are the angle's turns, clears it with null, and undoes it", async () => {
    const before = podcast();
    const set = await applyOperation(before, angleSet({ angle: "ana", speaker: "s2" }), context());
    expect(set.timeline.groups![0]!.angles[0]).toMatchObject({ id: "ana", speaker: "s2" });
    expect(applyPatch(set.timeline, set.inverse.args).groups).toEqual(before.groups);
    const cleared = await applyOperation(set.timeline, angleSet({ angle: "ana", speaker: null }), context());
    expect(cleared.timeline.groups![0]!.angles[0]).not.toHaveProperty("speaker");
  });

  it("explains an unknown group or angle, and an empty change", async () => {
    const group = await rejection(applyOperation(podcast(), { op: "multicam.angle", args: { group: "g_no", angle: "ana", name: "A" } }, context()));
    expect(group.message).toContain("Groups: g_talk, g_mic");
    const angle = await rejection(applyOperation(podcast(), angleSet({ angle: "zoe", name: "Zoe" }), context()));
    expect(angle.message).toContain("Angles: ana, ben, cleo");
    const nothing = await rejection(applyOperation(podcast(), angleSet({ angle: "ana" }), context()));
    expect(nothing.message).toContain("nothing to set");
  });
});

describe("separate mics", () => {
  const micSet = (args: Record<string, unknown>) => ({ op: "multicam.mic", args: { group: "g_talk", ...args } }) as OperationRequest;

  /** The podcast with Ana on a recorder file and Ben's own sound removed (a wide camera). */
  function miked(): Timeline {
    const timeline = podcast();
    const group = timeline.groups![0]!;
    group.mics = [{ id: "ana-lav", name: "Ana lav", asset: "assets/mic.wav", offset: 1.5, audio: { gain: -3 } }];
    group.angles[0]!.mic = "ana-lav";
    return timeline;
  }

  it("points an angle at a mic, at no sound, or back at its own file, dropping the angle's level when it leaves its file", async () => {
    const missing = await rejection(applyOperation(podcast(), angleSet({ angle: "ben", mic: "ana-lav" }), context()));
    expect(missing).toMatchObject({ message: expect.stringContaining('has no mic "ana-lav"') });

    const added = await applyOperation(miked(), angleSet({ angle: "ben", mic: "ana-lav" }), context());
    const ben = added.timeline.groups![0]!.angles[1]!;
    expect(ben.mic).toBe("ana-lav");
    expect(ben).not.toHaveProperty("audio");

    const none = await applyOperation(added.timeline, angleSet({ angle: "ben", mic: "none" }), context());
    expect(none.timeline.groups![0]!.angles[1]!.mic).toBeNull();
    const own = await applyOperation(none.timeline, angleSet({ angle: "ben", mic: "camera" }), context());
    expect(own.timeline.groups![0]!.angles[1]).not.toHaveProperty("mic");
    expect(applyPatch(added.timeline, added.inverse.args).groups).toEqual(miked().groups);
  });

  it("refuses gain and mute on an angle that takes its sound from a mic, pointing at the mic", async () => {
    const error = await rejection(applyOperation(miked(), angleSet({ angle: "ana", gain: -1 }), context()));
    expect(error).toMatchObject({ code: ErrorCode.InvalidOperation, message: expect.stringContaining("takes its sound from mic ana-lav") });
    expect(error.data).toMatchObject({ hint: "Use multicam.mic on ana-lav." });
    const wide = await rejection(applyOperation(miked(), angleSet({ angle: "ana", mic: "none", muted: true }), context()));
    expect(wide.message).toContain("takes its sound from no one");
  });

  it("fixes a mic's offset, name and level, storing no defaults, and journals the inverse", async () => {
    const applied = await applyOperation(miked(), micSet({ mic: "ana-lav", offset: 0.84321, name: "Lav", gain: 0, muted: true }), context());
    expect(applied.timeline.groups![0]!.mics).toEqual([{ id: "ana-lav", name: "Lav", asset: "assets/mic.wav", offset: 0.843, audio: { muted: true } }]);
    expect(applied.changes.updated).toEqual(["g_talk"]);
    expect(applyPatch(applied.timeline, applied.inverse.args).groups).toEqual(miked().groups);
  });

  it("explains an unknown mic, an angle id given as a mic, and an empty change", async () => {
    const unknown = await rejection(applyOperation(miked(), micSet({ mic: "zoe", offset: 1 }), context()));
    expect(unknown.message).toContain('has no mic "zoe"');
    expect(unknown.data).toMatchObject({ hint: "Mics: ana-lav." });
    const nothing = await rejection(applyOperation(miked(), micSet({ mic: "ana-lav" }), context()));
    expect(nothing.message).toContain("nothing to set");
    const noMics = await rejection(applyOperation(podcast(), micSet({ mic: "x", offset: 1 }), context()));
    expect(noMics.data).toMatchObject({ hint: expect.stringContaining("The group has no mics") });
    const offset = await rejection(applyOperation(miked(), { op: "multicam.offset", args: { group: "g_talk", angle: "ana-lav", offset: 1 } } as OperationRequest, context()));
    expect(offset.data).toMatchObject({ hint: "ana-lav is a mic: use multicam.mic." });
  });
});
