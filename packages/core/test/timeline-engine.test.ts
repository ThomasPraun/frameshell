import { ErrorCode, RpcError, parseParams } from "@frameshell/protocol";
import { type Clip, type ClipTrack, type Timeline, createTimeline, parseTimeline } from "@frameshell/schema";
import { describe, expect, it } from "vitest";
import {
  type EditContext,
  type EditPoint,
  type OperationRequest,
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
      throw new RpcError(ErrorCode.TimelineNotFound, `${source} not found`, {});
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

  it("passes cut and trim edges through the edit-point seam before snapping", async () => {
    const seen: EditPoint[] = [];
    const ctx = context({
      resolveEditPoint: (point) => {
        seen.push(point);
        return point.edge === "end" ? point.time - 0.1 : point.time + 0.1;
      },
    });
    let t = (await apply(base(), "clip.add", { track: "t_v", asset: "assets/talk.mp4", start: 0 })).timeline;
    t = (await apply(t, "cut", { from: 2, to: 3 }, ctx)).timeline;
    expect(clipsOf(t, "t_v").map((c) => [c.start, (c as { in: number }).in])).toEqual([
      [0, 0],
      [1.9, 3.1],
    ]);
    await apply(t, "clip.trim", { clip: "c_0001", out: 1 }, ctx);
    expect(seen.map((p) => [p.clock, p.edge])).toEqual([
      ["timeline", "end"],
      ["timeline", "start"],
      ["source", "end"],
    ]);
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
        },
      };
    }
    case 4:
      return { name: "clip.move", args: { clip: clipId(), ...(rand.chance(0.8) ? { start: time() } : {}), ...(rand.chance(0.3) ? { track: clipTrackId() } : {}) } };
    case 5: {
      const args: Record<string, unknown> = { clip: clipId() };
      if (rand.chance(0.5)) args[rand.pick(["in", "start"])] = rand.chance(0.5) ? rand.float(6) : time();
      if (rand.chance(0.6)) args[rand.pick(["out", "end"])] = rand.chance(0.5) ? rand.float(12) : time();
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
