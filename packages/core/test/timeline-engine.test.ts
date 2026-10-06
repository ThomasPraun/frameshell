import { ErrorCode, RpcError, parseParams } from "@frameshell/protocol";
import { type Clip, type ClipTrack, type Timeline, createTimeline, parseTimeline } from "@frameshell/schema";
import { describe, expect, it } from "vitest";
import {
  type EditContext,
  type EditPoint,
  type OperationRequest,
  NestedTimelineError,
  type SourceInfo,
  applyOperation,
} from "../src/index.js";

// Seam under test: applyOperation(timeline, request, context). The context is an
// in-memory adapter standing in for the daemon's media probe, plugin host and files.

const SOURCES: Record<string, SourceInfo> = {
  "assets/talk.mp4": { duration: 10, video: true, audio: true },
  "assets/music.wav": { duration: 30, video: false, audio: true },
  "assets/logo.png": { duration: null, video: true, audio: false },
  "assets/short.mp4": { duration: 0.99, video: true, audio: true },
};

function context(overrides: Partial<EditContext> = {}): EditContext {
  let next = 0;
  return {
    fps: 30,
    source: async (asset) => {
      const info = SOURCES[asset];
      if (!info) throw new RpcError(ErrorCode.AssetNotFound, `${asset} not found`, { path: asset });
      return info;
    },
    nestedDuration: async (source) => {
      if (source === "timelines/intro.json") return 5;
      throw new NestedTimelineError("missing", [source], "", ["intro", "main"]);
    },
    clipTypes: async () =>
      new Map([
        [
          "hyperframes",
          { validateProps: async (props: Record<string, unknown>) => (typeof props["title"] === "string" ? null : "title: expected string") },
        ],
      ]),
    newId: (prefix) => `${prefix}_${String(++next).padStart(4, "0")}`,
    ...overrides,
  };
}

/** Parse args through the method registry like the daemon does, so defaults apply. */
function op<K extends OperationRequest["op"]>(name: K, args: Record<string, unknown>): OperationRequest {
  if (name === "timeline.patch") return { op: name, args } as OperationRequest;
  const { cwd: _cwd, timeline: _timeline, ...parsed } = parseParams(name as Exclude<K, "timeline.patch">, {
    cwd: process.cwd(),
    ...args,
  }) as Record<string, unknown>;
  return { op: name, args: parsed } as OperationRequest;
}

async function apply(timeline: Timeline, name: OperationRequest["op"], args: Record<string, unknown>, ctx = context()) {
  return applyOperation(timeline, op(name, args), ctx);
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

/** Timeline with video track t_v and audio track t_a (ids fixed for readable assertions). */
function base(): Timeline {
  return {
    ...createTimeline("main"),
    tracks: [
      { id: "t_v", kind: "video", clips: [] },
      { id: "t_a", kind: "audio", clips: [] },
    ],
  };
}

function clipsOf(timeline: Timeline, track: string): Clip[] {
  const found = timeline.tracks.find((t) => t.id === track);
  if (!found || found.kind === "subtitles") throw new Error(`no clip track ${track}`);
  return found.clips;
}

describe("track operations", () => {
  it("adds tracks on top by default, at an index when asked, and bumps the revision", async () => {
    const first = await apply(createTimeline("main"), "track.add", { kind: "video", name: "Camera" });
    expect(first.timeline.tracks).toEqual([{ id: "t_0001", kind: "video", name: "Camera", clips: [] }]);
    expect(first.timeline.revision).toBe(1);
    expect(first.changes).toMatchObject({ added: ["t_0001"], updated: [], removed: [], range: null });

    const second = await apply(first.timeline, "track.add", { kind: "audio", index: 0 }, context({ newId: () => "t_aud" }));
    expect(second.timeline.tracks.map((t) => t.id)).toEqual(["t_aud", "t_0001"]);
  });

  it("requires subtitle tracks to follow a clip track and refuses removing a followed track", async () => {
    const error = await rejection(apply(base(), "track.add", { kind: "subtitles" }));
    expect(error.code).toBe(ErrorCode.InvalidOperation);
    expect(error.message).toMatch(/follows.*Clip tracks here: t_v, t_a/);

    const { timeline } = await apply(base(), "track.add", { kind: "subtitles", follows: "t_v" }, context({ newId: () => "t_sub" }));
    const refused = await rejection(apply(timeline, "track.remove", { track: "t_v" }));
    expect(refused.message).toMatch(/t_sub follows t_v.*Remove t_sub first/);
  });

  it("adds a subtitle track with a style preset and position; only subtitle tracks take a style", async () => {
    const { timeline } = await apply(
      base(),
      "track.add",
      { kind: "subtitles", follows: "t_v", style: { preset: "big-keyword", position: "top" } },
      context({ newId: () => "t_sub" }),
    );
    expect(timeline.tracks.at(-1)).toEqual({ id: "t_sub", kind: "subtitles", follows: "t_v", style: { preset: "big-keyword", position: "top" } });
    const refused = await rejection(apply(base(), "track.add", { kind: "video", style: { preset: "plain" } }));
    expect(refused.message).toMatch(/only subtitle tracks take `style`/);
    // Unknown presets fail param validation, listing the valid ones.
    expect(() => op("track.add", { kind: "subtitles", follows: "t_v", style: { preset: "neon" } })).toThrow(/big-keyword.*plain/);
  });

  it("track.set changes a subtitle track's style field by field, its followed track and name; the inverse restores them", async () => {
    const { timeline } = await apply(base(), "track.add", { kind: "subtitles", follows: "t_v", style: { preset: "plain" } }, context({ newId: () => "t_sub" }));
    const styled = await apply(timeline, "track.set", { track: "t_sub", style: { position: "center" } });
    expect(styled.timeline.tracks.at(-1)).toEqual({ id: "t_sub", kind: "subtitles", follows: "t_v", style: { preset: "plain", position: "center" } });
    expect(styled.changes).toMatchObject({ added: [], updated: ["t_sub"], removed: [], range: null });
    const moved = await apply(styled.timeline, "track.set", { track: "t_sub", follows: "t_a", name: "Captions", style: { preset: "big-keyword" } });
    expect(moved.timeline.tracks.at(-1)).toEqual({
      id: "t_sub",
      kind: "subtitles",
      name: "Captions",
      follows: "t_a",
      style: { preset: "big-keyword", position: "center" },
    });
    const undone = await apply(moved.timeline, "timeline.patch", moved.inverse.args);
    expect(undone.timeline.tracks).toEqual(styled.timeline.tracks);
    const unnamed = await apply(moved.timeline, "track.set", { track: "t_sub", name: null });
    expect(unnamed.timeline.tracks.at(-1)).not.toHaveProperty("name");
  });

  it("track.set refuses a style or follows on clip tracks, a subtitle track to follow, and no change at all", async () => {
    const { timeline } = await apply(base(), "track.add", { kind: "subtitles", follows: "t_v" }, context({ newId: () => "t_sub" }));
    expect((await rejection(apply(timeline, "track.set", { track: "t_v", style: { preset: "plain" } }))).message).toMatch(/only subtitle tracks take `style`/);
    expect((await rejection(apply(timeline, "track.set", { track: "t_v", follows: "t_a" }))).message).toMatch(/only subtitle tracks take `follows`/);
    expect((await rejection(apply(timeline, "track.set", { track: "t_sub", follows: "t_sub" }))).message).toMatch(/t_sub is a subtitle track/);
    expect((await rejection(apply(timeline, "track.set", { track: "t_sub" }))).message).toMatch(/nothing to change/);
    const renamed = await apply(timeline, "track.set", { track: "t_v", name: "Camera" });
    expect(renamed.timeline.tracks[0]).toEqual({ id: "t_v", kind: "video", name: "Camera", clips: [] });
  });

  it("refuses to remove a track with clips unless forced, and names missing tracks", async () => {
    const { timeline } = await apply(base(), "clip.add", { track: "t_v", asset: "assets/talk.mp4" });
    expect((await rejection(apply(timeline, "track.remove", { track: "t_v" }))).message).toMatch(/1 clip.*force: true/);
    const forced = await apply(timeline, "track.remove", { track: "t_v", force: true });
    expect(forced.changes).toMatchObject({ removed: ["t_v"], range: { from: 0, to: 10 } });

    const missing = await rejection(apply(base(), "track.remove", { track: "t_x" }));
    expect(missing.code).toBe(ErrorCode.TrackNotFound);
    expect(missing.data).toEqual({ track: "t_x", available: ["t_v", "t_a"] });
  });
});

describe("clip.add", () => {
  it("snaps times to the 30 fps grid with 3 decimals and defaults to the whole asset", async () => {
    const { timeline, changes } = await apply(base(), "clip.add", { track: "t_v", asset: "assets/talk.mp4", start: 1.01, in: 3.21, out: 7.74 });
    expect(clipsOf(timeline, "t_v")).toEqual([
      { id: "c_0001", type: "media", asset: "assets/talk.mp4", start: 1, in: 3.2, out: 7.733 },
    ]);
    expect(changes).toEqual({ added: ["c_0001"], updated: [], removed: [], range: { from: 1, to: 5.533 } });

    const whole = await apply(base(), "clip.add", { track: "t_a", asset: "assets/music.wav" });
    expect(clipsOf(whole.timeline, "t_a")[0]).toMatchObject({ start: 0, in: 0, out: 30 });
  });

  it("appends after the track's last clip when start is omitted, counting speed", async () => {
    const one = await apply(base(), "clip.add", { track: "t_v", asset: "assets/talk.mp4", in: 0, out: 3, speed: 1.5 });
    const two = await apply(one.timeline, "clip.add", { track: "t_v", asset: "assets/talk.mp4", in: 5, out: 6 });
    expect(clipsOf(two.timeline, "t_v").map((c) => c.start)).toEqual([0, 2]);
  });

  it("rejects an out past the source with the valid range, but clamps a request for the full length", async () => {
    const error = await rejection(apply(base(), "clip.add", { track: "t_v", asset: "assets/talk.mp4", out: 12 }));
    expect(error.code).toBe(ErrorCode.InvalidOperation);
    expect(error.message).toMatch(/out 12 is past the end of assets\/talk\.mp4 \(10 s.*Valid out: 0\.033 to 10 s/);
    expect(error.data).toMatchObject({ op: "clip.add", field: "out", valid: { min: 0.033, max: 10 } });

    // 0.99 s = 29.7 frames: the grid end is frame 29 (0.967), and asking for 0.99 means "all of it".
    const full = await apply(base(), "clip.add", { track: "t_v", asset: "assets/short.mp4", out: 0.99 });
    expect(clipsOf(full.timeline, "t_v")[0]).toMatchObject({ out: 0.967 });
  });

  it("rejects overlapping clips with both ranges and a fix", async () => {
    const { timeline } = await apply(base(), "clip.add", { track: "t_v", asset: "assets/talk.mp4", start: 0, out: 4 });
    const error = await rejection(apply(timeline, "clip.add", { track: "t_v", asset: "assets/talk.mp4", start: 3.5 }));
    expect(error.message).toMatch(/c_0001 \(0–4\) and c_0002 \(3\.5–13\.5\) would overlap on track t_v.*start the later one at 4 or after/);
  });

  it("accepts clips that touch: end frame = next start frame", async () => {
    const one = await apply(base(), "clip.add", { track: "t_v", asset: "assets/talk.mp4", out: 1 / 3 });
    const end = clipsOf(one.timeline, "t_v")[0]!;
    expect(end).toMatchObject({ out: 0.333 });
    await expect(apply(one.timeline, "clip.add", { track: "t_v", asset: "assets/talk.mp4", start: 0.333 })).resolves.toBeDefined();
  });

  it("checks the track kind against the asset's streams", async () => {
    const error = await rejection(apply(base(), "clip.add", { track: "t_v", asset: "assets/music.wav" }));
    expect(error.message).toMatch(/no video stream; it belongs on an audio track/);
  });

  it("needs a duration for still images", async () => {
    expect((await rejection(apply(base(), "clip.add", { track: "t_v", asset: "assets/logo.png" }))).message).toMatch(/Pass `duration`/);
    const { timeline } = await apply(base(), "clip.add", { track: "t_v", asset: "assets/logo.png", duration: 2.5 });
    expect(clipsOf(timeline, "t_v")[0]).toMatchObject({ in: 0, out: 2.5 });
  });

  it("validates adapter clip types and their props through the registered adapter", async () => {
    const unknown = await rejection(apply(base(), "clip.add", { track: "t_v", type: "remotion", duration: 2 }));
    expect(unknown.message).toMatch(/clip type "remotion" is not registered \(available: media, timeline, hyperframes\).*plugin install/);

    const badProps = await rejection(apply(base(), "clip.add", { track: "t_v", type: "hyperframes", duration: 2, props: { title: 3 } }));
    expect(badProps.message).toMatch(/invalid props for hyperframes: title: expected string/);

    const { timeline } = await apply(base(), "clip.add", {
      track: "t_v",
      type: "hyperframes",
      source: "compositions/hyperframes/intro/index.html",
      duration: 8,
      props: { title: "Hola" },
      transform: { opacity: 0.5 },
    });
    expect(clipsOf(timeline, "t_v")[0]).toEqual({
      id: "c_0001",
      type: "hyperframes",
      source: "compositions/hyperframes/intro/index.html",
      start: 0,
      duration: 8,
      props: { title: "Hola" },
      transform: { opacity: 0.5 },
    });
  });

  it("places nested timelines, bounded by the nested duration", async () => {
    const { timeline } = await apply(base(), "clip.add", { track: "t_v", type: "timeline", source: "timelines/intro.json", start: 2 });
    const next = await apply(timeline, "clip.add", { track: "t_v", asset: "assets/talk.mp4" });
    expect(clipsOf(next.timeline, "t_v").map((c) => c.start)).toEqual([2, 7]);
    const error = await rejection(apply(base(), "clip.add", { track: "t_v", type: "timeline", source: "timelines/intro.json", in: 4, duration: 2 }));
    expect(error.data).toMatchObject({ field: "duration", valid: { max: 1 } });
  });
});

describe("clip.move, trim, split, remove, set", () => {
  async function withClip(args: Record<string, unknown> = {}) {
    return (await apply(base(), "clip.add", { track: "t_v", asset: "assets/talk.mp4", start: 10, in: 2, out: 8, ...args })).timeline;
  }

  it("moves a clip in time and to another track of the same kind only", async () => {
    const withV2 = (await apply(await withClip(), "track.add", { kind: "video" }, context({ newId: () => "t_v2" }))).timeline;
    const { timeline, changes } = await apply(withV2, "clip.move", { clip: "c_0001", start: 1, track: "t_v2" });
    expect(clipsOf(timeline, "t_v")).toEqual([]);
    expect(clipsOf(timeline, "t_v2")[0]).toMatchObject({ id: "c_0001", start: 1 });
    expect(changes).toMatchObject({ updated: ["c_0001"], range: { from: 1, to: 16 } });
    expect((await rejection(apply(withV2, "clip.move", { clip: "c_0001", track: "t_a" }))).message).toMatch(/Pick a video track: t_v, t_v2/);
  });

  it("trims the head by source time keeping kept frames in place, and the tail by timeline time", async () => {
    const head = await apply(await withClip(), "clip.trim", { clip: "c_0001", in: 3 });
    expect(clipsOf(head.timeline, "t_v")[0]).toMatchObject({ start: 11, in: 3, out: 8 });
    const tail = await apply(head.timeline, "clip.trim", { clip: "c_0001", end: 14.5 });
    expect(clipsOf(tail.timeline, "t_v")[0]).toMatchObject({ start: 11, in: 3, out: 6.5 });
  });

  it("refuses a head extension before source time 0 with the valid range", async () => {
    const error = await rejection(apply(await withClip(), "clip.trim", { clip: "c_0001", start: 5 }));
    expect(error.data).toMatchObject({ field: "start", valid: { min: 8, max: 15.967 } });
  });

  it("splits at a timeline time: left keeps the id, right continues the source", async () => {
    const { timeline, changes } = await apply(await withClip({ speed: 2 }), "clip.split", { clip: "c_0001", at: 11 });
    expect(clipsOf(timeline, "t_v")).toEqual([
      { id: "c_0001", type: "media", asset: "assets/talk.mp4", start: 10, in: 2, out: 4, speed: 2 },
      { id: "c_0002", type: "media", asset: "assets/talk.mp4", start: 11, in: 4, out: 8, speed: 2 },
    ]);
    expect(changes).toMatchObject({ added: ["c_0002"], updated: ["c_0001"] });
    const outside = await rejection(apply(timeline, "clip.split", { clip: "c_0001", at: 12 }));
    expect(outside.data).toMatchObject({ field: "at", valid: { min: 10.033, max: 10.967 } });
  });

  it("sets audio, transform, speed and scriptRef; speed moves the end and is checked for overlaps", async () => {
    const { timeline } = await apply(await withClip(), "clip.set", {
      clip: "c_0001",
      gain: -6,
      transform: { scale: 0.5 },
      scriptRef: "scripts/s.md#intro",
    });
    expect(clipsOf(timeline, "t_v")[0]).toMatchObject({ audio: { gain: -6 }, transform: { scale: 0.5 }, scriptRef: "scripts/s.md#intro" });
    const cleared = await apply(timeline, "clip.set", { clip: "c_0001", scriptRef: null, muted: true });
    expect(clipsOf(cleared.timeline, "t_v")[0]).toMatchObject({ audio: { gain: -6, muted: true } });
    expect(clipsOf(cleared.timeline, "t_v")[0]).not.toHaveProperty("scriptRef");

    const blocked = (await apply(timeline, "clip.add", { track: "t_v", asset: "assets/talk.mp4", start: 17 })).timeline;
    expect((await rejection(apply(blocked, "clip.set", { clip: "c_0001", speed: 0.5 }))).message).toMatch(/would overlap/);
  });

  it("removes a clip and reports missing clip ids with where to find ids", async () => {
    const { timeline } = await apply(await withClip(), "clip.remove", { clip: "c_0001" });
    expect(clipsOf(timeline, "t_v")).toEqual([]);
    const missing = await rejection(apply(timeline, "clip.remove", { clip: "c_0001" }));
    expect(missing.code).toBe(ErrorCode.ClipNotFound);
    expect(missing.message).toMatch(/timeline show/);
  });
});

describe("cut (ripple)", () => {
  it("removes a range on every clip track: trims, splits, drops and shifts", async () => {
    let t = base();
    t = (await apply(t, "clip.add", { track: "t_v", asset: "assets/talk.mp4", start: 0, in: 0, out: 4 })).timeline; // c_0001 0–4
    t = (await apply(t, "clip.add", { track: "t_v", asset: "assets/talk.mp4", start: 4, in: 5, out: 6 })).timeline; // c_0002 4–5, inside
    t = (await apply(t, "clip.add", { track: "t_v", asset: "assets/talk.mp4", start: 6, in: 6, out: 9 })).timeline; // c_0003 6–9, after
    t = (await apply(t, "clip.add", { track: "t_a", asset: "assets/music.wav", start: 0, in: 0, out: 20 })).timeline; // c_0004 spans
    const { timeline, changes } = await apply(t, "cut", { from: 3, to: 5.5 });
    expect(clipsOf(timeline, "t_v")).toEqual([
      { id: "c_0001", type: "media", asset: "assets/talk.mp4", start: 0, in: 0, out: 3 },
      { id: "c_0003", type: "media", asset: "assets/talk.mp4", start: 3.5, in: 6, out: 9 },
    ]);
    expect(clipsOf(timeline, "t_a")).toEqual([
      { id: "c_0004", type: "media", asset: "assets/music.wav", start: 0, in: 0, out: 3 },
      { id: "c_0005", type: "media", asset: "assets/music.wav", start: 3, in: 5.5, out: 20 },
    ]);
    expect(changes).toMatchObject({ added: ["c_0005"], removed: ["c_0002"], range: { from: 0, to: 20 } });
  });

  it("cuts only the named tracks and rejects an empty range", async () => {
    let t = base();
    t = (await apply(t, "clip.add", { track: "t_v", asset: "assets/talk.mp4", start: 0 })).timeline;
    t = (await apply(t, "clip.add", { track: "t_a", asset: "assets/music.wav", start: 0 })).timeline;
    const { timeline } = await apply(t, "cut", { from: 2, to: 3, tracks: ["t_a"] });
    expect(clipsOf(timeline, "t_v")).toEqual(clipsOf(t, "t_v"));
    expect(clipsOf(timeline, "t_a")).toHaveLength(2);
    expect((await rejection(apply(t, "cut", { from: 3, to: 3.01 }))).message).toMatch(/must be after `from`/);
  });

  it("passes cut and trim edges through the edit-point seam before frame snapping", async () => {
    const seen: EditPoint[] = [];
    const ctx = context({
      resolveEditPoint: (point) => {
        seen.push(point);
        return { time: point.edge === "end" ? point.time - 0.1 : point.time + 0.1, clean: true };
      },
    });
    let t = (await apply(base(), "clip.add", { track: "t_v", asset: "assets/talk.mp4", start: 0 })).timeline;
    t = (await apply(t, "cut", { from: 2, to: 3 }, ctx)).timeline;
    expect(clipsOf(t, "t_v").map((c) => [c.start, (c as { in: number }).in])).toEqual([
      [0, 0],
      [1.9, 3.1],
    ]);
    await apply(t, "clip.trim", { clip: "c_0001", out: 1 }, ctx);
    expect(seen.map((p) => [p.clock, p.edge, p.window])).toEqual([
      ["timeline", "end", 0.5],
      ["timeline", "start", 0.5],
      ["source", "end", 0.5],
    ]);
  });

  it("reports each snapped edge: requested, applied on the grid, clean", async () => {
    const ctx = context({ resolveEditPoint: (point) => ({ time: point.time + 0.0123, clean: point.edge === "end" }) });
    let t = (await apply(base(), "clip.add", { track: "t_v", asset: "assets/talk.mp4", start: 0 })).timeline;
    const cut = await apply(t, "cut", { from: 2, to: 3 }, ctx);
    expect(cut.snaps).toEqual([
      { field: "from", clip: null, requested: 2, applied: 2.0, clean: true, window: 0.5 },
      { field: "to", clip: null, requested: 3, applied: 3.0, clean: false, window: 0.5 },
    ]);
    t = cut.timeline;
    const trim = await apply(t, "clip.trim", { clip: "c_0001", end: 1.5 }, ctx);
    expect(trim.snaps).toEqual([{ field: "end", clip: "c_0001", requested: 1.5, applied: 1.5, clean: true, window: 0.5 }]);
    const plain = await apply(t, "clip.set", { clip: "c_0001", gain: -3 }, ctx);
    expect(plain.snaps).toEqual([]);
  });

  it("cuts and trims exactly with snap: false, and passes the window", async () => {
    const seen: EditPoint[] = [];
    const ctx = context({
      resolveEditPoint: (point) => {
        seen.push(point);
        return { time: point.time + 0.5, clean: true };
      },
    });
    const t = (await apply(base(), "clip.add", { track: "t_v", asset: "assets/talk.mp4", start: 0 })).timeline;
    const exact = await apply(t, "cut", { from: 2, to: 3, snap: false }, ctx);
    expect(seen).toEqual([]);
    expect(exact.snaps).toEqual([]);
    expect(clipsOf(exact.timeline, "t_v").map((c) => c.start)).toEqual([0, 2]);
    await apply(t, "clip.trim", { clip: "c_0001", in: 1, snapWindow: 2 }, ctx);
    expect(seen.map((p) => p.window)).toEqual([2]);
    expect((await rejection(apply(t, "cut", { from: 2, to: 3, snapWindow: 0.2 }, ctx))).message).toMatch(/snapWindow/);
  });

  it("searches the project default window unless the operation passes snapWindow, and reports the window used", async () => {
    const seen: number[] = [];
    const ctx = context({
      snapWindow: 1.5,
      resolveEditPoint: (point) => {
        seen.push(point.window);
        return { time: point.time, clean: false };
      },
    });
    const t = (await apply(base(), "clip.add", { track: "t_v", asset: "assets/talk.mp4", start: 0 })).timeline;
    const cut = await apply(t, "cut", { from: 2, to: 3 }, ctx);
    const trim = await apply(t, "clip.trim", { clip: "c_0001", out: 4 }, ctx);
    const overridden = await apply(t, "cut", { from: 2, to: 3, snapWindow: 0.5 }, ctx);
    const trimOverridden = await apply(t, "clip.trim", { clip: "c_0001", in: 1, snapWindow: 3 }, ctx);
    expect(seen).toEqual([1.5, 1.5, 1.5, 0.5, 0.5, 3]);
    expect([cut, trim, overridden, trimOverridden].map((r) => r.snaps.map((s) => s.window))).toEqual([[1.5, 1.5], [1.5], [0.5, 0.5], [3]]);
    // Without a project default the ADR 0003 minimum applies.
    expect((await apply(t, "cut", { from: 2, to: 3 }, context({ resolveEditPoint: (p) => ({ time: p.time, clean: true }) }))).snaps.map((s) => s.window)).toEqual([0.5, 0.5]);
  });

  it("gives cut edges the clips of the cut tracks, and keeps edges the resolver declines", async () => {
    const seen: EditPoint[] = [];
    const ctx = context({
      resolveEditPoint: (point) => {
        seen.push(point);
        return null;
      },
    });
    let t = (await apply(base(), "clip.add", { track: "t_v", asset: "assets/talk.mp4", start: 0 })).timeline;
    t = (await apply(t, "clip.add", { track: "t_a", asset: "assets/music.wav", start: 0 })).timeline;
    const result = await apply(t, "cut", { from: 2, to: 3, tracks: ["t_a"] }, ctx);
    expect(seen[0]!.clips!.map((c) => c.id)).toEqual(["c_0002"]);
    expect(result.snaps).toEqual([]);
    expect(clipsOf(result.timeline, "t_a").map((c) => c.start)).toEqual([0, 2]);
  });

  it("refuses a cut whose snapped edges collapse, naming snap: false", async () => {
    const ctx = context({ resolveEditPoint: () => ({ time: 2.5, clean: true }) });
    const t = (await apply(base(), "clip.add", { track: "t_v", asset: "assets/talk.mp4", start: 0 })).timeline;
    const error = await rejection(apply(t, "cut", { from: 2.4, to: 2.6 }, ctx));
    expect(error.message).toMatch(/same pause.*snap: false/s);
  });
});

describe("ripple trim and insert (restoring cut material)", () => {
  /** t_v: c_0001 0–2 (source 0–2), c_0002 2–4 (source 3–5); t_a: c_0003 0–1.5, c_0004 at 2, c_0005 1–5 spans 2. */
  async function cutTake(): Promise<Timeline> {
    let t = base();
    t.tracks.push({ id: "t_m", kind: "audio", clips: [] });
    t = (await apply(t, "clip.add", { track: "t_v", asset: "assets/talk.mp4", start: 0, in: 0, out: 2 })).timeline;
    t = (await apply(t, "clip.add", { track: "t_v", asset: "assets/talk.mp4", start: 2, in: 3, out: 5 })).timeline;
    t = (await apply(t, "clip.add", { track: "t_a", asset: "assets/music.wav", start: 0, in: 0, out: 1.5 })).timeline;
    t = (await apply(t, "clip.add", { track: "t_a", asset: "assets/music.wav", start: 2, in: 10, out: 11 })).timeline;
    t = (await apply(t, "clip.add", { track: "t_m", asset: "assets/music.wav", start: 1, in: 0, out: 4 })).timeline;
    return t;
  }

  it("a rippled tail extension opens room: clips at or after the old end move right on every clip track", async () => {
    const { timeline, changes } = await apply(await cutTake(), "clip.trim", { clip: "c_0001", out: 2.6, ripple: true });
    expect(clipsOf(timeline, "t_v")).toEqual([
      { id: "c_0001", type: "media", asset: "assets/talk.mp4", start: 0, in: 0, out: 2.6 },
      { id: "c_0002", type: "media", asset: "assets/talk.mp4", start: 2.6, in: 3, out: 5 },
    ]);
    expect(clipsOf(timeline, "t_a").map((c) => c.start)).toEqual([0, 2.6]);
    // Crossing the insertion point: stays where it is.
    expect(clipsOf(timeline, "t_m").map((c) => c.start)).toEqual([1]);
    expect(changes.updated.sort()).toEqual(["c_0001", "c_0002", "c_0004"]);
  });

  it("without ripple the same extension is refused as an overlap", async () => {
    const error = await rejection(apply(await cutTake(), "clip.trim", { clip: "c_0001", out: 2.6 }));
    expect(error.message).toMatch(/overlap/);
  });

  it("a rippled head extension keeps the clip's left edge and pushes what follows", async () => {
    const { timeline } = await apply(await cutTake(), "clip.trim", { clip: "c_0002", in: 2.4, ripple: true });
    expect(clipsOf(timeline, "t_v")).toEqual([
      { id: "c_0001", type: "media", asset: "assets/talk.mp4", start: 0, in: 0, out: 2 },
      { id: "c_0002", type: "media", asset: "assets/talk.mp4", start: 2, in: 2.4, out: 5 },
    ]);
    // c_0004 started with c_0002: it stays in sync with c_0002's old first frame.
    expect(clipsOf(timeline, "t_a").map((c) => c.start)).toEqual([0, 2.6]);
  });

  it("a rippled trim reports the snapped edge and shifts by the snapped growth", async () => {
    const ctx = context({ resolveEditPoint: (point) => ({ time: point.time + 0.1, clean: true }) });
    const { timeline, snaps } = await apply(await cutTake(), "clip.trim", { clip: "c_0001", out: 2.5, ripple: true }, ctx);
    expect(snaps).toEqual([{ field: "out", clip: "c_0001", requested: 2.5, applied: 2.6, clean: true, window: 0.5 }]);
    expect(clipsOf(timeline, "t_v").map((c) => c.start)).toEqual([0, 2.6]);
  });

  it("a rippled insert places the clip and moves clips at or after its start on every clip track", async () => {
    const { timeline, changes } = await apply(await cutTake(), "clip.add", {
      track: "t_v",
      asset: "assets/talk.mp4",
      start: 2,
      in: 2.2,
      out: 2.7,
      ripple: true,
    });
    expect(clipsOf(timeline, "t_v")).toEqual([
      { id: "c_0001", type: "media", asset: "assets/talk.mp4", start: 0, in: 0, out: 2 },
      { id: "c_0006", type: "media", asset: "assets/talk.mp4", start: 2, in: 2.2, out: 2.7 },
      { id: "c_0002", type: "media", asset: "assets/talk.mp4", start: 2.5, in: 3, out: 5 },
    ]);
    expect(clipsOf(timeline, "t_a").map((c) => c.start)).toEqual([0, 2.5]);
    expect(clipsOf(timeline, "t_m").map((c) => c.start)).toEqual([1]);
    expect(changes.added).toEqual(["c_0006"]);
  });

  it("an insert snaps its in and out into pauses only when asked, on the source clock of the new clip", async () => {
    const seen: EditPoint[] = [];
    const ctx = context({
      resolveEditPoint: (point) => {
        seen.push(point);
        return { time: point.edge === "start" ? point.time - 0.1 : point.time + 0.1, clean: point.edge === "start" };
      },
    });
    const args = { track: "t_v", asset: "assets/talk.mp4", start: 6, in: 2.2, out: 2.7 };
    const exact = await apply(await cutTake(), "clip.add", args, ctx);
    expect(seen).toEqual([]);
    expect(clipsOf(exact.timeline, "t_v").at(-1)).toMatchObject({ in: 2.2, out: 2.7 });
    const snapped = await apply(await cutTake(), "clip.add", { ...args, snap: true }, ctx);
    expect(seen.map((p) => [p.clock, p.edge, (p.clip as { asset?: string } | undefined)?.asset])).toEqual([
      ["source", "start", "assets/talk.mp4"],
      ["source", "end", "assets/talk.mp4"],
    ]);
    expect(clipsOf(snapped.timeline, "t_v").at(-1)).toMatchObject({ in: 2.1, out: 2.8 });
    const added = snapped.changes.added[0];
    expect(snapped.snaps).toEqual([
      { field: "in", clip: added, requested: 2.2, applied: 2.1, clean: true, window: 0.5 },
      { field: "out", clip: added, requested: 2.7, applied: 2.8, clean: false, window: 0.5 },
    ]);
  });

  it("snapBounds fence snapped in/out edges: the resolver sees them, and a result outside is clamped to the nearest in-range frame", async () => {
    const seen: EditPoint[] = [];
    // A resolver that jumps to a pause 0.4 s back, past the word being restored.
    const ctx = context({
      resolveEditPoint: (point) => {
        seen.push(point);
        return { time: point.time - 0.4, clean: true };
      },
    });
    const trimmed = await apply(await cutTake(), "clip.trim", { clip: "c_0001", out: 2.6, snapBounds: { out: { min: 2.5, max: 2.9 } }, ripple: true }, ctx);
    expect(seen.map((p) => [p.min, p.max])).toEqual([[2.5, 2.9]]);
    expect(clipsOf(trimmed.timeline, "t_v")[0]).toMatchObject({ out: 2.5 });
    expect(trimmed.snaps).toEqual([{ field: "out", clip: "c_0001", requested: 2.6, applied: 2.5, clean: true, window: 0.5 }]);

    seen.length = 0;
    const added = await apply(
      await cutTake(),
      "clip.add",
      { track: "t_v", asset: "assets/talk.mp4", start: 6, in: 2.2, out: 2.7, snap: true, snapBounds: { in: { min: 2.1, max: 2.25 }, out: { min: 2.65 } } },
      ctx,
    );
    expect(seen.map((p) => [p.edge, p.min, p.max])).toEqual([
      ["start", 2.1, 2.25],
      ["end", 2.65, undefined],
    ]);
    // in: 1.8 clamps up to 2.1; out: 2.3 clamps up to 2.667 (first frame at or after 2.65).
    expect(clipsOf(added.timeline, "t_v").at(-1)).toMatchObject({ in: 2.1, out: 2.667 });
  });

  it("snapBounds is refused without its edge, outside the requested time, inverted, or without snap on clip.add", async () => {
    const t = await cutTake();
    expect((await rejection(apply(t, "clip.trim", { clip: "c_0001", out: 2.6, snapBounds: { in: { max: 1 } } }))).message).toMatch(/snapBounds\.in.*needs `in`/);
    expect((await rejection(apply(t, "clip.trim", { clip: "c_0001", out: 2.6, snapBounds: { out: { min: 2.7 } } }))).message).toMatch(/outside/);
    expect((await rejection(apply(t, "clip.trim", { clip: "c_0001", out: 2.6, snapBounds: { out: { min: 2.9, max: 2.5 } } }))).message).toMatch(/past max/);
    const add = { track: "t_v", asset: "assets/talk.mp4", start: 6, in: 2.2, out: 2.7, snapBounds: { out: { min: 2.6 } } };
    expect((await rejection(apply(t, "clip.add", add))).message).toMatch(/needs `snap: true`/);
  });

  it("rippleTracks limits a rippled trim to the named tracks plus the clip's own", async () => {
    const { timeline, changes } = await apply(await cutTake(), "clip.trim", { clip: "c_0001", out: 2.6, ripple: true, rippleTracks: ["t_m"] });
    expect(clipsOf(timeline, "t_v").map((c) => c.start)).toEqual([0, 2.6]);
    // t_a is not named: c_0004 stays at 2, no gap opens after c_0003.
    expect(clipsOf(timeline, "t_a").map((c) => c.start)).toEqual([0, 2]);
    expect(changes.updated.sort()).toEqual(["c_0001", "c_0002"]);
  });

  it("rippleTracks limits a rippled insert likewise", async () => {
    const args = { track: "t_v", asset: "assets/talk.mp4", start: 2, in: 2.2, out: 2.7, ripple: true, rippleTracks: ["t_v"] };
    const { timeline } = await apply(await cutTake(), "clip.add", args);
    expect(clipsOf(timeline, "t_v").map((c) => c.start)).toEqual([0, 2, 2.5]);
    expect(clipsOf(timeline, "t_a").map((c) => c.start)).toEqual([0, 2]);
  });

  it("rippleTracks needs ripple and clip tracks", async () => {
    const t = await cutTake();
    expect((await rejection(apply(t, "clip.trim", { clip: "c_0001", out: 1.5, rippleTracks: ["t_a"] }))).message).toMatch(/needs `ripple: true`/);
    t.tracks.push({ id: "t_s", kind: "subtitles", follows: "t_v" });
    expect((await rejection(apply(t, "clip.trim", { clip: "c_0001", out: 2.6, ripple: true, rippleTracks: ["t_s"] }))).message).toMatch(/subtitle track/);
    expect((await rejection(apply(t, "clip.trim", { clip: "c_0001", out: 2.6, ripple: true, rippleTracks: ["t_x"] }))).code).toBe(ErrorCode.TrackNotFound);
  });

  it("ripple and snap on clip.add apply to media clips only", async () => {
    const error = await rejection(
      apply(await cutTake(), "clip.add", { track: "t_v", type: "hyperframes", duration: 2, props: { title: "x" }, snap: true }),
    );
    expect(error.message).toMatch(/snap/);
  });
});

// Property-style: random operation sequences from a seeded PRNG (no dependency).

function prng(seed: number) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    float: (max: number) => Math.round(next() * max * 1000) / 1000,
    int: (max: number) => Math.floor(next() * max),
    pick: <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!,
    chance: (p: number) => next() < p,
  };
}

function randomRequest(rand: ReturnType<typeof prng>, timeline: Timeline): { name: OperationRequest["op"]; args: Record<string, unknown> } {
  const tracks = timeline.tracks;
  const clipTracks = tracks.filter((t): t is ClipTrack => t.kind !== "subtitles");
  const clips = clipTracks.flatMap((t) => t.clips);
  const trackId = () => (tracks.length > 0 ? rand.pick(tracks).id : "t_none");
  const clipTrackId = () => (clipTracks.length > 0 ? rand.pick(clipTracks).id : "t_none");
  const clipId = () => (clips.length > 0 ? rand.pick(clips).id : "c_none");
  const time = () => rand.float(40);
  switch (rand.int(11)) {
    case 0:
      return { name: "track.add", args: { kind: rand.pick(["video", "audio", "subtitles"] as const), follows: clipTrackId(), ...(rand.chance(0.3) ? { index: rand.int(tracks.length + 1) } : {}) } };
    case 1:
      return { name: "track.remove", args: { track: trackId(), force: rand.chance(0.5) } };
    case 2:
    case 3: {
      const kind = rand.pick(["media", "media", "hyperframes", "timeline"] as const);
      const base = { track: clipTrackId(), ...(rand.chance(0.7) ? { start: time() } : {}) };
      if (kind === "hyperframes") return { name: "clip.add", args: { ...base, type: kind, duration: rand.float(5) + 0.1, props: { title: "x" } } };
      if (kind === "timeline") return { name: "clip.add", args: { ...base, type: kind, source: "timelines/intro.json", ...(rand.chance(0.5) ? { in: rand.float(2) } : {}) } };
      const asset = rand.pick(Object.keys(SOURCES));
      return {
        name: "clip.add",
        args: {
          ...base,
          asset,
          ...(rand.chance(0.6) ? { in: rand.float(5) } : {}),
          ...(rand.chance(0.5) ? { out: rand.float(12) } : { duration: rand.float(4) + 0.05 }),
          ...(rand.chance(0.3) ? { speed: rand.pick([0.5, 1.15, 2]) } : {}),
          ...(rand.chance(0.3) ? { ripple: true } : {}),
        },
      };
    }
    case 4:
      return { name: "clip.move", args: { clip: clipId(), ...(rand.chance(0.8) ? { start: time() } : {}), ...(rand.chance(0.3) ? { track: clipTrackId() } : {}) } };
    case 5: {
      const args: Record<string, unknown> = { clip: clipId() };
      if (rand.chance(0.5)) args[rand.pick(["in", "start"])] = rand.chance(0.5) ? rand.float(6) : time();
      if (rand.chance(0.6)) args[rand.pick(["out", "end"])] = rand.chance(0.5) ? rand.float(12) : time();
      if (rand.chance(0.3)) args["ripple"] = true;
      return { name: "clip.trim", args };
    }
    case 6:
      return { name: "clip.split", args: { clip: clipId(), at: time() } };
    case 7:
      return { name: "clip.remove", args: { clip: clipId() } };
    case 8:
      return { name: "clip.set", args: { clip: clipId(), ...(rand.chance(0.5) ? { speed: rand.pick([0.5, 1, 1.5, 3]) } : { gain: -rand.int(20) }), ...(rand.chance(0.3) ? { transform: { x: rand.int(100) } } : {}) } };
    case 9: {
      const from = time();
      return { name: "cut", args: { from, to: from + rand.float(5), ...(rand.chance(0.3) ? { tracks: [clipTrackId()] } : {}) } };
    }
    default:
      return { name: "track.add", args: { kind: rand.pick(["video", "audio"] as const) } };
  }
}

/** Invariants every applied operation must leave (SPEC §5.3, decision 8). */
function assertInvariants(timeline: Timeline, fps: number): void {
  expect(parseTimeline(timeline).ok).toBe(true);
  const onGrid = (t: number) => {
    expect(Math.abs(t * fps - Math.round(t * fps))).toBeLessThan(0.05);
    expect(Math.round(t * 1000) / 1000).toBe(t);
  };
  for (const track of timeline.tracks) {
    if (track.kind === "subtitles") continue;
    let previousEnd = -Infinity;
    for (const clip of track.clips) {
      onGrid(clip.start);
      let duration: number;
      if (clip.type === "media") {
        const media = clip as Extract<Clip, { type: "media" }>;
        onGrid(media.in);
        onGrid(media.out);
        expect(media.in).toBeGreaterThanOrEqual(0);
        expect(media.speed ?? 1).toBeGreaterThan(0);
        const source = SOURCES[media.asset]!;
        if (source.duration !== null) expect(media.out).toBeLessThanOrEqual(source.duration);
        expect(track.kind === "video" ? source.video : source.audio).toBe(true);
        duration = (media.out - media.in) / (media.speed ?? 1);
      } else {
        const generated = clip as { in?: number; duration?: number };
        duration = generated.duration ?? 5 - (generated.in ?? 0);
        if (clip.type === "timeline") expect((generated.in ?? 0) + duration).toBeLessThanOrEqual(5.0005);
      }
      const startFrame = Math.round(clip.start * fps);
      const endFrame = Math.round((clip.start + duration) * fps);
      expect(endFrame - startFrame).toBeGreaterThanOrEqual(1);
      expect(startFrame).toBeGreaterThanOrEqual(previousEnd);
      previousEnd = endFrame;
    }
  }
}

describe("nested timeline unavailable", () => {
  /**
   * t_v: c_m media 0–3, c_n nests missing timelines/gone.json at 10 (end unknown), c_after media 20–23.
   * t_a: c_a media 0–5.
   */
  function broken(): Timeline {
    const media = (id: string, start: number): Clip => ({ id, type: "media", asset: "assets/talk.mp4", start, in: 0, out: 3 });
    return {
      ...createTimeline("main"),
      tracks: [
        {
          id: "t_v",
          kind: "video",
          clips: [media("c_m", 0), { id: "c_n", type: "timeline", source: "timelines/gone.json", start: 10 }, media("c_after", 20)],
        },
        { id: "t_a", kind: "audio", clips: [{ id: "c_a", type: "media", asset: "assets/music.wav", start: 0, in: 0, out: 5 }] },
      ],
    };
  }

  function expectNamesClip(error: RpcError, op: string) {
    expect(error.code).toBe(ErrorCode.NestedTimelineUnavailable);
    expect(error.message).toContain(`${op}: clip c_n on track t_v of timeline main nests timelines/gone.json`);
    expect(error.message).toContain("timelines/gone.json does not exist. Restore timelines/gone.json (existing timelines: intro, main)");
    expect(error.message).toContain("`frameshell clip remove c_n`");
    expect(error.data).toEqual({
      timeline: "main",
      track: "t_v",
      clip: "c_n",
      source: "timelines/gone.json",
      broken: "timelines/gone.json",
      reason: "missing",
      details: "",
    });
  }

  it("removes the clip, and its track with --force, reporting an open or bounded range", async () => {
    const removed = await apply(broken(), "clip.remove", { clip: "c_n" });
    expect(clipsOf(removed.timeline, "t_v").map((c) => c.id)).toEqual(["c_m", "c_after"]);
    // Its end is unknown, but it ended by the next clip's start before the removal.
    expect(removed.changes).toEqual({ added: [], updated: [], removed: ["c_n"], range: { from: 10, to: 20 } });
    // Undo cannot check a clip of unknown length for overlaps: refused until the file is back.
    expectNamesClip(await rejection(apply(removed.timeline, "timeline.patch", removed.inverse.args)), "timeline.patch");
    const restored = context({ nestedDuration: async () => 5 });
    const inverse = await apply(removed.timeline, "timeline.patch", removed.inverse.args, restored);
    expect(clipsOf(inverse.timeline, "t_v")).toEqual(clipsOf(broken(), "t_v"));

    const last = await apply((await apply(broken(), "clip.remove", { clip: "c_after" })).timeline, "clip.remove", { clip: "c_n" });
    expect(last.changes.range).toEqual({ from: 10, to: null });

    const track = await apply(broken(), "track.remove", { track: "t_v", force: true });
    expect(track.timeline.tracks.map((t) => t.id)).toEqual(["t_a"]);
    expect(track.changes).toMatchObject({ removed: ["t_v"], range: { from: 0, to: 23 } });
  });

  it("cuts before the clip (it only shifts) but refuses a cut that may reach into it", async () => {
    const { timeline } = await apply(broken(), "cut", { from: 7, to: 8 });
    expect(clipsOf(timeline, "t_v").map((c) => [c.id, c.start])).toEqual([["c_m", 0], ["c_n", 9], ["c_after", 19]]);
    expectNamesClip(await rejection(apply(broken(), "cut", { from: 11, to: 12 })), "cut");
  });

  it("moves other clips unless they may overlap it", async () => {
    const away = await apply(broken(), "clip.move", { clip: "c_after", start: 25 });
    expect(clipsOf(away.timeline, "t_v").map((c) => c.start)).toEqual([0, 10, 25]);
    const before = await apply(broken(), "clip.move", { clip: "c_m", start: 5 });
    expect(clipsOf(before.timeline, "t_v").map((c) => c.start)).toEqual([5, 10, 20]);
    expectNamesClip(await rejection(apply(broken(), "clip.move", { clip: "c_after", start: 15 })), "clip.move");
    expectNamesClip(await rejection(apply(broken(), "clip.move", { clip: "c_n", start: 12 })), "clip.move");
  });

  it("names the clip, its track and the fix when an edit needs its length", async () => {
    expectNamesClip(await rejection(apply(broken(), "clip.split", { clip: "c_n", at: 11 })), "clip.split");
    expectNamesClip(await rejection(apply(broken(), "clip.trim", { clip: "c_n", end: 12 })), "clip.trim");
    expectNamesClip(await rejection(apply(broken(), "clip.add", { track: "t_v", asset: "assets/talk.mp4" })), "clip.add");
  });

  it("blames the `source` arg of clip.add: missing file with the timelines that exist, or a cycle", async () => {
    const missing = await rejection(apply(base(), "clip.add", { track: "t_v", type: "timeline", source: "timelines/gone.json" }));
    expect(missing.code).toBe(ErrorCode.TimelineNotFound);
    expect(missing.message).toBe("clip.add: no timeline file timelines/gone.json; timelines: intro, main (pass the id, e.g. `intro`).");
    expect(missing.data).toEqual({ timeline: "timelines/gone.json", path: "timelines/gone.json", available: ["intro", "main"] });

    const cyclic = context({
      nestedDuration: async (source) => {
        throw new NestedTimelineError("cycle", [source, "timelines/main.json"], "timelines/main.json -> timelines/loop.json -> timelines/main.json");
      },
    });
    const cycle = await rejection(apply(base(), "clip.add", { track: "t_v", type: "timeline", source: "timelines/loop.json" }, cyclic));
    expect(cycle.code).toBe(ErrorCode.InvalidOperation);
    expect(cycle.data).toMatchObject({ field: "source" });
    expect(cycle.message).toMatch(/timelines\/main\.json would contain itself .*Nested timelines cannot form a cycle\./);
  });
});

describe("operation properties", () => {
  it.each([1, 2, 3, 4, 5, 6, 7, 8])("seed %i: every applied op keeps the invariants and apply∘inverse = identity", async (seed) => {
    const rand = prng(seed);
    const ctx = context();
    let timeline = base();
    const applied = new Set<string>();
    for (let step = 0; step < 250; step++) {
      const { name, args } = randomRequest(rand, timeline);
      let request: OperationRequest;
      try {
        request = op(name, args);
      } catch {
        continue; // Params the registry rejects never reach the engine.
      }
      let result;
      try {
        result = await applyOperation(timeline, request, ctx);
      } catch (error) {
        // Rejections must be actionable RpcErrors, never crashes.
        expect(error, `${name} ${JSON.stringify(args)}`).toBeInstanceOf(RpcError);
        expect([ErrorCode.InvalidOperation, ErrorCode.TrackNotFound, ErrorCode.ClipNotFound]).toContain((error as RpcError).code);
        continue;
      }
      applied.add(name);
      expect(result.timeline.revision).toBe(timeline.revision + 1);
      assertInvariants(result.timeline, 30);

      const undone = await applyOperation(result.timeline, result.inverse, ctx);
      expect(undone.timeline.tracks, `inverse of ${name} ${JSON.stringify(args)}`).toEqual(timeline.tracks);
      const redone = await applyOperation(undone.timeline, undone.inverse, ctx);
      expect(redone.timeline.tracks).toEqual(result.timeline.tracks);
      timeline = result.timeline;
    }
    expect(applied.size).toBeGreaterThanOrEqual(8);
  });
});
