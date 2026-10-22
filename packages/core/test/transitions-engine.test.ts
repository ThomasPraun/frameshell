import { ErrorCode, RpcError, parseParams } from "@frameshell/protocol";
import { type Clip, type ClipTrack, type Timeline, createTimeline, parseTimeline } from "@frameshell/schema";
import { describe, expect, it } from "vitest";
import { type EditContext, type OperationRequest, type SourceInfo, applyOperation, applyPatch } from "../src/index.js";

const SOURCES: Record<string, SourceInfo> = {
  "assets/talk.mp4": { duration: 10, video: true, audio: true },
  "assets/tight.mp4": { duration: 4, video: true, audio: true },
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

function op(name: string, args: Record<string, unknown>): OperationRequest {
  const { cwd: _cwd, timeline: _timeline, ...parsed } = parseParams(name as "transition.set", { cwd: process.cwd(), ...args }) as Record<string, unknown>;
  return { op: name, args: parsed } as OperationRequest;
}

const apply = (timeline: Timeline, name: string, args: Record<string, unknown>) => applyOperation(timeline, op(name, args), context());

async function rejection(promise: Promise<unknown>): Promise<RpcError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof RpcError) return error;
    throw error;
  }
  throw new Error("expected a rejection");
}

const media = (id: string, start: number, from: number, to: number, asset = "assets/talk.mp4"): Clip => ({ id, type: "media", asset, start, in: from, out: to });

/** Video t_v and audio t_a, each with two butted 4 s clips (0-4, 4-8) that have 2 s of source before and after. */
function butted(): Timeline {
  return {
    ...createTimeline("main"),
    tracks: [
      { id: "t_v", kind: "video", clips: [media("v1", 0, 2, 6), media("v2", 4, 2, 6)] },
      { id: "t_a", kind: "audio", clips: [media("a1", 0, 2, 6), media("a2", 4, 2, 6)] },
    ],
  };
}

function clip(timeline: Timeline, id: string): Clip {
  for (const track of timeline.tracks) {
    if (track.kind === "subtitles" || track.kind === "program") continue;
    const found = (track as ClipTrack).clips.find((c) => c.id === id);
    if (found) return found;
  }
  throw new Error(`no clip ${id}`);
}

describe("transition.set", () => {
  it("with only `at` dissolves the edge on every video and audio track, 0.5 s", async () => {
    const { timeline, warnings } = await apply(butted(), "transition.set", { at: 4 });
    expect(clip(timeline, "v2")).toMatchObject({ dissolve: 0.5 });
    expect(clip(timeline, "a2")).toMatchObject({ dissolve: 0.5 });
    expect(clip(timeline, "v1")).not.toHaveProperty("fadeOut");
    expect(warnings).toEqual([]);
    expect(parseTimeline(timeline).ok).toBe(true);
  });

  it("`tracks` limits it", async () => {
    const { timeline } = await apply(butted(), "transition.set", { at: 4, tracks: ["t_a"] });
    expect(clip(timeline, "a2")).toHaveProperty("dissolve");
    expect(clip(timeline, "v2")).not.toHaveProperty("dissolve");
  });

  it("a fade on a butted edge dips: half as fadeOut and half as fadeIn", async () => {
    const { timeline } = await apply(butted(), "transition.set", { at: 4, kind: "fade", duration: 1 });
    expect(clip(timeline, "v1")).toMatchObject({ fadeOut: 0.5 });
    expect(clip(timeline, "v2")).toMatchObject({ fadeIn: 0.5 });
    expect(clip(timeline, "v2")).not.toHaveProperty("dissolve");
  });

  it("replaces what the edge had", async () => {
    const dissolved = await apply(butted(), "transition.set", { at: 4, duration: 1 });
    const dipped = await apply(dissolved.timeline, "transition.set", { at: 4, kind: "fade" });
    expect(clip(dipped.timeline, "v2")).not.toHaveProperty("dissolve");
    expect(clip(dipped.timeline, "v2")).toMatchObject({ fadeIn: 0.267 });
  });

  it("a lone edge fades in or out of the full length for both kinds", async () => {
    const start = await apply(butted(), "transition.set", { at: 0, duration: 1 });
    expect(clip(start.timeline, "v1")).toMatchObject({ fadeIn: 1 });
    expect(clip(start.timeline, "a1")).toMatchObject({ fadeIn: 1 });
    const end = await apply(butted(), "transition.set", { at: 8, kind: "fade", duration: 1 });
    expect(clip(end.timeline, "v2")).toMatchObject({ fadeOut: 1 });
  });

  it("fails when no targeted track has an edge at `at`, listing the edges", async () => {
    const error = await rejection(apply(butted(), "transition.set", { at: 5 }));
    expect(error.code).toBe(ErrorCode.InvalidOperation);
    expect(error.message).toMatch(/no clip edge at 5 s.*Clip edges: 0, 4, 8/);
    const limited = await rejection(apply(butted(), "transition.set", { at: 4, tracks: ["t_missing"] }));
    expect(limited.code).toBe(ErrorCode.TrackNotFound);
  });

  it("skips program tracks with a warning and still changes the others", async () => {
    const timeline: Timeline = {
      ...butted(),
      groups: [{ id: "g_talk", angles: [{ id: "ana", name: "Ana", asset: "assets/talk.mp4", offset: 0 }] }],
    };
    timeline.tracks.push({ id: "t_p", kind: "program", group: "g_talk", clips: [{ id: "s1", type: "shot", start: 0, in: 0, out: 8, shot: "solo", angles: ["ana"] }] });
    const { timeline: changed, warnings } = await apply(timeline, "transition.set", { at: 4 });
    expect(clip(changed, "v2")).toHaveProperty("dissolve");
    expect(warnings.join("\n")).toMatch(/skipped multicam program track t_p/);
    const only = await rejection(apply(timeline, "transition.set", { at: 4, tracks: ["t_p"] }));
    expect(only.message).toMatch(/no clip edge at 4 s on any video or audio track/);
  });

  it("warns when short material shortens a dissolve, or turns it into a dip", async () => {
    const shortHandles: Timeline = {
      ...createTimeline("main"),
      tracks: [{ id: "t_v", kind: "video", clips: [media("v1", 0, 2, 6), media("v2", 4, 0.2, 4.2)] }],
    };
    const shortened = await apply(shortHandles, "transition.set", { at: 4, duration: 1 });
    expect(shortened.warnings.join("\n")).toMatch(/v2: dissolve shortened from 1 s to 0\.\d+ s/);

    const noHandles: Timeline = {
      ...createTimeline("main"),
      tracks: [{ id: "t_v", kind: "video", clips: [media("v1", 0, 0, 4, "assets/tight.mp4"), media("v2", 4, 0, 4, "assets/tight.mp4")] }],
    };
    const dip = await apply(noHandles, "transition.set", { at: 4 });
    expect(dip.warnings.join("\n")).toMatch(/v2: dissolve of 0\.5 s plays as a dip through black/);
  });

  it("warns when a later operation leaves a dissolve alone, and not for an issue that was already there", async () => {
    const dissolved = (await apply(butted(), "transition.set", { at: 4 })).timeline;
    const moved = await apply(dissolved, "clip.move", { clip: "v2", start: 6 });
    expect(moved.warnings.join("\n")).toMatch(/v2: dissolve plays as a fade in/);
    const again = await apply(moved.timeline, "clip.move", { clip: "v2", start: 7 });
    expect(again.warnings).toEqual([]);
  });

  it("undoes through the patch inverse, and removing is the same shape", async () => {
    const before = butted();
    const applied = await apply(before, "transition.set", { at: 4, kind: "fade" });
    expect(applyPatch(applied.timeline, applied.inverse.args).tracks).toEqual(before.tracks);
  });
});

describe("transition.remove", () => {
  it("clears dissolve, fadeIn and fadeOut at the edge, on the targeted tracks", async () => {
    const dipped = (await apply(butted(), "transition.set", { at: 4, kind: "fade" })).timeline;
    const { timeline, warnings } = await apply(dipped, "transition.remove", { at: 4, tracks: ["t_v"] });
    expect(clip(timeline, "v1")).not.toHaveProperty("fadeOut");
    expect(clip(timeline, "v2")).not.toHaveProperty("fadeIn");
    expect(clip(timeline, "a2")).toHaveProperty("fadeIn");
    expect(warnings).toEqual([]);
    const all = await apply(dipped, "transition.remove", { at: 4 });
    expect(clip(all.timeline, "a2")).not.toHaveProperty("fadeIn");
  });

  it("warns for an edge without a transition and fails without an edge", async () => {
    expect((await apply(butted(), "transition.remove", { at: 4 })).warnings.join("")).toMatch(/nothing to remove/);
    expect((await rejection(apply(butted(), "transition.remove", { at: 3 }))).code).toBe(ErrorCode.InvalidOperation);
  });
});

describe("clip.key", () => {
  it("adds keys sorted on the clip clock, defaults the value to what plays there and undoes", async () => {
    const before = butted();
    // v2: in 2, so timeline 5 is clip second 3.
    const first = await apply(before, "clip.key", { clip: "v2", prop: "scale", time: 6, value: 1.2 });
    expect(clip(first.timeline, "v2").keys).toEqual({ scale: [{ at: 4, value: 1.2 }] });
    const second = await apply(first.timeline, "clip.key", { clip: "v2", prop: "scale", time: 4, ease: "in-out" });
    expect(clip(second.timeline, "v2").keys?.scale).toEqual([
      { at: 2, value: 1.2, ease: "in-out" },
      { at: 4, value: 1.2 },
    ]);
    const mid = await apply(second.timeline, "clip.key", { clip: "v2", prop: "scale", time: 5, value: 1 });
    expect(clip(mid.timeline, "v2").keys?.scale?.map((k) => k.at)).toEqual([2, 3, 4]);
    expect(applyPatch(first.timeline, first.inverse.args).tracks).toEqual(before.tracks);
  });

  it("replaces the key in the same frame and keeps its ease unless one is given", async () => {
    const eased = (await apply(butted(), "clip.key", { clip: "v2", prop: "opacity", time: 4, value: 0, ease: "out" })).timeline;
    const replaced = await apply(eased, "clip.key", { clip: "v2", prop: "opacity", time: 4.01, value: 0.5 });
    expect(clip(replaced.timeline, "v2").keys?.opacity).toEqual([{ at: 2, value: 0.5, ease: "out" }]);
    const linear = await apply(replaced.timeline, "clip.key", { clip: "v2", prop: "opacity", time: 4, ease: "linear" });
    expect(clip(linear.timeline, "v2").keys?.opacity).toEqual([{ at: 2, value: 0.5 }]);
  });

  it("takes the default value from the static value", async () => {
    const set = (await apply(butted(), "clip.set", { clip: "v2", transform: { opacity: 0.4 } })).timeline;
    const keyed = await apply(set, "clip.key", { clip: "v2", prop: "opacity", time: 5 });
    expect(clip(keyed.timeline, "v2").keys?.opacity).toEqual([{ at: 3, value: 0.4 }]);
  });

  it("removes a key, clears a property and drops an empty keys object", async () => {
    let timeline = (await apply(butted(), "clip.key", { clip: "v2", prop: "x", time: 4, value: 10 })).timeline;
    timeline = (await apply(timeline, "clip.key", { clip: "v2", prop: "x", time: 6, value: 50 })).timeline;
    timeline = (await apply(timeline, "clip.key", { clip: "v2", prop: "gain", time: 4, value: -6 })).timeline;
    const removed = await apply(timeline, "clip.key", { clip: "v2", prop: "x", time: 4, remove: true });
    expect(clip(removed.timeline, "v2").keys?.x).toEqual([{ at: 4, value: 50 }]);
    const missing = await rejection(apply(timeline, "clip.key", { clip: "v2", prop: "x", time: 5, remove: true }));
    expect(missing.message).toMatch(/no `x` key at 5 s.*Keys at: 4, 6/);
    const cleared = await apply(timeline, "clip.key", { clip: "v2", prop: "x", clear: true });
    expect(clip(cleared.timeline, "v2").keys).toEqual({ gain: [{ at: 2, value: -6 }] });
    const none = await apply(cleared.timeline, "clip.key", { clip: "v2", prop: "gain", clear: true });
    expect(clip(none.timeline, "v2")).not.toHaveProperty("keys");
  });

  it("accounts for speed when placing keys on the clip clock", async () => {
    const timeline: Timeline = { ...createTimeline("main"), tracks: [{ id: "t_v", kind: "video", clips: [{ id: "v1", type: "media", asset: "assets/talk.mp4", start: 10, in: 2, out: 6, speed: 2 }] }] };
    const keyed = await apply(timeline, "clip.key", { clip: "v1", prop: "x", time: 11, value: 5 });
    expect(clip(keyed.timeline, "v1").keys?.x).toEqual([{ at: 4, value: 5 }]);
  });

  it("refuses picture properties on audio tracks, times outside the clip, bad values and clear with other fields", async () => {
    expect((await rejection(apply(butted(), "clip.key", { clip: "a1", prop: "x", time: 1, value: 1 }))).message).toMatch(/audio tracks take only `gain`/);
    expect((await apply(butted(), "clip.key", { clip: "a1", prop: "gain", time: 1, value: -3 })).timeline).toBeDefined();
    expect((await rejection(apply(butted(), "clip.key", { clip: "v1", prop: "x", time: 9, value: 1 }))).message).toMatch(/outside v1 \(0–4\)/);
    expect((await rejection(apply(butted(), "clip.key", { clip: "v1", prop: "opacity", time: 1, value: 2 }))).code).toBe(ErrorCode.InvalidOperation);
    expect((await rejection(apply(butted(), "clip.key", { clip: "v1", prop: "x", clear: true, time: 1 }))).message).toMatch(/`clear`/);
    expect((await rejection(apply(butted(), "clip.key", { clip: "v1", prop: "x" }))).message).toMatch(/give the key `time`/);
  });
});

describe("split and cut keep edge fields on the right side", () => {
  const decorated = async () => {
    let timeline = (await apply(butted(), "transition.set", { at: 0, duration: 1 })).timeline;
    timeline = (await apply(timeline, "transition.set", { at: 8, duration: 1 })).timeline;
    return (await apply(timeline, "clip.key", { clip: "v2", prop: "scale", time: 5, value: 1.5 })).timeline;
  };

  it("clip.split: left keeps dissolve and fadeIn, right keeps fadeOut, the new cut has none, both keep the keys", async () => {
    const withDissolve = (await apply(await decorated(), "transition.set", { at: 4, tracks: ["t_v"] })).timeline;
    const split = await apply(withDissolve, "clip.split", { clip: "v2", at: 6 });
    const right = split.changes.added[0]!;
    expect(clip(split.timeline, "v2")).toMatchObject({ dissolve: 0.5, keys: { scale: [{ at: 3, value: 1.5 }] } });
    expect(clip(split.timeline, "v2")).not.toHaveProperty("fadeOut");
    expect(clip(split.timeline, right)).toMatchObject({ fadeOut: 1, keys: { scale: [{ at: 3, value: 1.5 }] } });
    expect(clip(split.timeline, right)).not.toHaveProperty("dissolve");
    expect(clip(split.timeline, right)).not.toHaveProperty("fadeIn");
    const first = await apply(await decorated(), "clip.split", { clip: "v1", at: 2 });
    expect(clip(first.timeline, "v1")).toMatchObject({ fadeIn: 1 });
    expect(applyPatch(split.timeline, split.inverse.args).tracks).toEqual(withDissolve.tracks);
  });

  it("cut: a clip split by the range follows the split rule; a trimmed tail loses fadeOut, a trimmed head dissolve and fadeIn", async () => {
    const timeline = await decorated();
    const across = await apply(timeline, "cut", { from: 5, to: 7, snap: false, tracks: ["t_v"] });
    const right = across.changes.added[0]!;
    expect(clip(across.timeline, "v2")).not.toHaveProperty("fadeOut");
    expect(clip(across.timeline, right)).toMatchObject({ fadeOut: 1 });
    expect(clip(across.timeline, "v2").keys).toBeDefined();
    expect(clip(across.timeline, right).keys).toBeDefined();

    const tail = await apply(timeline, "cut", { from: 6, to: 8, snap: false, tracks: ["t_v"] });
    expect(clip(tail.timeline, "v2")).not.toHaveProperty("fadeOut");

    const withDissolve = (await apply(timeline, "transition.set", { at: 4, tracks: ["t_v"] })).timeline;
    const head = await apply(withDissolve, "cut", { from: 3, to: 5, snap: false, tracks: ["t_v"] });
    expect(clip(head.timeline, "v2")).not.toHaveProperty("dissolve");
    expect(clip(head.timeline, "v2")).toMatchObject({ fadeOut: 1 });
  });
});
