import { ErrorCode, RpcError } from "@frameshell/protocol";
import { type BeatsFile, type Timeline, createTimeline, nominalBeatFrame } from "@frameshell/schema";
import { describe, expect, it } from "vitest";
import type { OperationRequest } from "../src/timeline/engine.js";
import { MARKER_SNAP_REACH_S, MAX_GRID_BEATS, nearestBeat, snapRequest, tempoGrid } from "../src/timeline/tempo.js";

// Seam under test: the timeline's beat grid on the timeline clock (ADR 0029 slice 3), pure but for the beats file
// lookup, which these tests inject.

const FPS = 30;
const HASH = `sha256:${"a".repeat(64)}`;

/** A beats file of a 120 BPM track whose first beat is 0.2 s in: beats 0.2, 0.7, … and a bar every 4 beats. */
function beatsFile(overrides: Partial<BeatsFile> = {}): BeatsFile {
  return {
    schemaVersion: 1,
    asset: "assets/music.wav",
    assetHash: HASH,
    detector: "onset-flux@1",
    bpm: 120,
    meter: 4,
    downbeat: 0,
    confidence: 0.95,
    beats: Array.from({ length: 40 }, (_, index) => Math.round((0.2 + index * 0.5) * 1000) / 1000),
    edits: {},
    ...overrides,
  };
}

/** A timeline with the music on an audio track: `start` on the timeline, source `in`..`out`, `speed`. */
function scored(clip: { start?: number; in?: number; out?: number; speed?: number } = {}, tempo?: Timeline["tempo"]): Timeline {
  return {
    ...createTimeline("main"),
    tracks: [{ id: "t_a", kind: "audio", clips: [{ id: "c_music", type: "media", asset: "assets/music.wav", start: clip.start ?? 0, in: clip.in ?? 0, out: clip.out ?? 20, ...(clip.speed ? { speed: clip.speed } : {}) }] }],
    ...(tempo ? { tempo } : {}),
  };
}

const beatsOf = (file: BeatsFile | null) => async (asset: string) => (file && asset === file.asset ? file : null);

describe("tempoGrid", () => {
  it("has no grid and no problem when the timeline has no tempo", async () => {
    expect(await tempoGrid({ fps: FPS, timeline: scored(), horizon: 10, beatsOf: beatsOf(beatsFile()) })).toEqual({ grid: null, problem: null });
  });

  it("carries a measured grid through the clip: start, in and speed", async () => {
    const found = await tempoGrid({ fps: FPS, timeline: scored({ start: 3, in: 1, out: 6 }, { clip: "c_music" }), horizon: 10, beatsOf: beatsOf(beatsFile()) });
    expect(found.problem).toBeNull();
    const grid = found.grid!;
    // Source 1.2 is the first beat inside [1, 6): 3 + (1.2 - 1) = 3.2 on the timeline; the last one before 6 is 5.7 → 7.7.
    expect(grid.beats[0]).toBe(3.2);
    expect(grid.beats.at(-1)).toBe(7.7);
    expect(grid).toMatchObject({ source: "beats", bpm: 120, meter: 4, clip: "c_music", asset: "assets/music.wav", confidence: 0.95, low: false });
    // Beat index 2 (1.2) is the first inside the clip; bars start at source beats 0, 4, 8 …: source 2.2, 4.2.
    expect(grid.bars).toEqual([4.2, 6.2]);
    expect(grid.beats).toHaveLength(10);
  });

  it("follows the clip when it moves and speeds up: the same beats, at a faster tempo", async () => {
    const moved = await tempoGrid({ fps: FPS, timeline: scored({ start: 10, in: 0, out: 4 }, { clip: "c_music" }), horizon: 10, beatsOf: beatsOf(beatsFile()) });
    expect(moved.grid!.beats.slice(0, 3)).toEqual([10.2, 10.7, 11.2]);
    const fast = await tempoGrid({ fps: FPS, timeline: scored({ start: 0, in: 0, out: 4, speed: 2 }, { clip: "c_music" }), horizon: 10, beatsOf: beatsOf(beatsFile()) });
    expect(fast.grid).toMatchObject({ bpm: 240 });
    expect(fast.grid!.beats.slice(0, 3)).toEqual([0.1, 0.367, 0.6]); // 0.35 is half a frame: the grid rounds it to frame 11
    expect(fast.grid!.beats.at(-1)).toBeLessThan(2);
  });

  it("applies the corrections of the beats file: double time, a moved downbeat", async () => {
    const found = await tempoGrid({
      fps: FPS,
      timeline: scored({ in: 0, out: 3 }, { clip: "c_music" }),
      horizon: 10,
      beatsOf: beatsOf(beatsFile({ edits: { tempo: "double", downbeat: 1 } })),
    });
    expect(found.grid).toMatchObject({ bpm: 240 });
    expect(found.grid!.beats.slice(0, 3)).toEqual([0.2, 0.467, 0.7]);
    expect(found.grid!.bars[0]).toBe(0.467);
  });

  it("marks a LOW confidence grid, unless the file has human edits vouching for it", async () => {
    const low = beatsFile({ confidence: 0.3 });
    expect((await tempoGrid({ fps: FPS, timeline: scored({}, { clip: "c_music" }), horizon: 10, beatsOf: beatsOf(low) })).grid).toMatchObject({ low: true, confidence: 0.3 });
    const vouched = beatsFile({ confidence: 0.3, edits: { tempo: "double" } });
    expect((await tempoGrid({ fps: FPS, timeline: scored({}, { clip: "c_music" }), horizon: 10, beatsOf: beatsOf(vouched) })).grid!.low).toBe(false);
  });

  it("says why there is no grid yet when the music has no beats file or the clip is gone", async () => {
    const missing = await tempoGrid({ fps: FPS, timeline: scored({}, { clip: "c_music" }), horizon: 10, beatsOf: beatsOf(null) });
    expect(missing.grid).toBeNull();
    expect(missing.problem).toMatch(/assets\/music\.wav has no beat grid yet.*beats measure/);
    const gone = await tempoGrid({ fps: FPS, timeline: scored({}, { clip: "c_gone" }), horizon: 10, beatsOf: beatsOf(beatsFile()) });
    expect(gone.problem).toMatch(/c_gone/);
  });

  it("builds a nominal grid on the timeline clock, each frame rounded once from its index", async () => {
    const { grid } = await tempoGrid({ fps: FPS, timeline: { ...createTimeline("main"), tempo: { bpm: 128, offset: 0.5 } }, horizon: 60, beatsOf: beatsOf(null) });
    expect(grid).toMatchObject({ source: "nominal", bpm: 128, meter: 4, low: false });
    expect(grid!.beats[0]).toBe(0.5);
    // Beat 32 sits where the index says (not 2 frames off, as adding a rounded step would drift).
    expect(grid!.beats[32]).toBe(Math.round((nominalBeatFrame(32, 128, FPS, 0.5) / FPS) * 1000) / 1000);
    expect(grid!.bars.slice(0, 3)).toEqual([grid!.beats[0], grid!.beats[4], grid!.beats[8]]);
    expect(grid!.beats.at(-1)!).toBeGreaterThanOrEqual(60);
    expect(grid!.beats.at(-1)!).toBeLessThan(62);
    expect(await tempoGrid({ fps: FPS, timeline: { ...createTimeline("main"), tempo: { bpm: 90, meter: 3 } }, horizon: 6, beatsOf: beatsOf(null) })).toMatchObject({
      // The grid runs a whole bar (3 beats, 2 s) past the horizon at least.
      grid: { meter: 3, bars: [0, 2, 4, 6, 8] },
    });
  });

  it("builds a nominal grid riding on a clip: source offset, inside the clip only", async () => {
    const { grid } = await tempoGrid({
      fps: FPS,
      timeline: scored({ start: 2, in: 1, out: 5 }, { clip: "c_music", bpm: 120, offset: 0.25 }),
      horizon: 60,
      beatsOf: beatsOf(null),
    });
    expect(grid).toMatchObject({ source: "nominal", clip: "c_music", bpm: 120 });
    // Source beats at 0.25 + 0.5 i; the first at or after in=1 is 1.25 → timeline 2.25 (frame 67.5, rounded to 68);
    // the last before out=5 is 4.75 → 5.75 (frame 173); bars start at beats 0, 4, 8 …: source 2.25 and 4.25 → 3.25 and 5.25 (frames 97.5 and 157.5).
    expect(grid!.beats[0]).toBe(2.267);
    expect(grid!.beats.at(-1)).toBe(5.767);
    expect(grid!.beats).toHaveLength(8);
    expect(grid!.bars).toEqual([3.267, 5.267]);
  });

  it("keeps a bar start whose beat shares a frame with the one before it", async () => {
    // Beats 0.2 and 0.21 round to frame 6; beat 1 starts the bar (downbeat 1), so the bar must survive the dedupe.
    const crowded = beatsFile({ downbeat: 1, beats: [0.2, 0.21, 0.7, 1.2, 1.7, 2.2, 2.7, 3.2, 3.7, 4.2] });
    const { grid } = await tempoGrid({ fps: FPS, timeline: scored({}, { clip: "c_music" }), horizon: 10, beatsOf: beatsOf(crowded) });
    expect(grid!.beats.slice(0, 2)).toEqual([0.2, 0.7]);
    expect(grid!.bars[0]).toBe(0.2);
    expect(grid!.bars.every((bar) => grid!.beats.includes(bar))).toBe(true);
  });

  it("stops a runaway grid", async () => {
    const { grid } = await tempoGrid({ fps: FPS, timeline: { ...createTimeline("main"), tempo: { bpm: 400 } }, horizon: 100_000, beatsOf: beatsOf(null) });
    expect(grid!.beats).toHaveLength(MAX_GRID_BEATS);
  });
});

describe("nearestBeat", () => {
  const grid = {
    source: "nominal" as const,
    bpm: 120,
    meter: 4,
    low: false,
    beats: [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4],
    bars: [0, 2, 4],
  };

  it("lands on the nearest beat or bar start, the earlier one on a tie", () => {
    expect(nearestBeat(grid, 1.3, "beat")).toBe(1.5);
    expect(nearestBeat(grid, 1.74, "beat")).toBe(1.5);
    expect(nearestBeat(grid, 1.75, "beat")).toBe(1.5);
    expect(nearestBeat(grid, 2.9, "bar")).toBe(2);
    expect(nearestBeat(grid, 3.1, "bar")).toBe(4);
    expect(nearestBeat(grid, 0, "bar")).toBe(0);
  });

  it("refuses a time well outside the grid", () => {
    expect(() => nearestBeat(grid, 9, "beat")).toThrow(/outside the grid.*0 s to 4 s/);
  });
});

describe("snapRequest", () => {
  const timeline: Timeline = { ...createTimeline("main"), tempo: { bpm: 120 }, markers: [{ id: "m_a", at: 2.3, label: "hook" }] };
  const context = { timeline, fps: FPS, snapTo: "beat" as const, beatsOf: beatsOf(null) };
  const request = (op: string, args: Record<string, unknown>) => ({ op, args }) as unknown as OperationRequest;
  const failure = async (promise: Promise<unknown>) => {
    try {
      await promise;
    } catch (error) {
      if (error instanceof RpcError) return error;
      throw error;
    }
    throw new Error("expected a refusal");
  };

  it("moves each time argument to the nearest beat or bar, resolving marker names first", async () => {
    const moved = await snapRequest(request("clip.move", { clip: "c_1", start: 2.62 }), context);
    expect(moved.args).toEqual({ clip: "c_1", start: 2.5 });
    const named = await snapRequest(request("marker.add", { at: "hook+0.1", label: "x" }), context);
    expect(named.args).toEqual({ at: 2.5, label: "x" });
    const bars = await snapRequest(request("clip.split", { clip: "c_1", at: 2.9 }), { ...context, snapTo: "bar" });
    expect(bars.args).toEqual({ clip: "c_1", at: 2 });
    const range = await snapRequest(request("cut", { from: 1.1, to: 3.4 }), context);
    expect(range.args).toMatchObject({ from: 1, to: 3.5 });
  });

  it("finds the next bar of a long meter even when it is more than two beats past the time", async () => {
    // 120 BPM, 8 beats to the bar: bars at 0 s and 4 s. 2.5 s is 5 beats into the bar, so the bar at 4 s (3 beats) beats the one at 0 s.
    const long = { ...context, timeline: { ...createTimeline("main"), tempo: { bpm: 120, meter: 8 } }, snapTo: "bar" as const };
    expect((await snapRequest(request("clip.split", { clip: "c_1", at: 2.5 }), long)).args).toEqual({ clip: "c_1", at: 4 });
    const six = { ...long, timeline: { ...createTimeline("main"), tempo: { bpm: 120, meter: 6 } } };
    expect((await snapRequest(request("clip.split", { clip: "c_1", at: 1.8 }), six)).args).toEqual({ clip: "c_1", at: 3 });
  });

  it("snaps to the nearest marker within reach, with no tempo, never to the marker it moves", async () => {
    const marked: Timeline = {
      ...createTimeline("main"),
      markers: [
        { id: "m_a", at: 2.3, label: "hook" },
        { id: "m_b", at: 5, label: "drop" },
      ],
    };
    const near = { ...context, timeline: marked, snapTo: "marker" as const };
    expect((await snapRequest(request("clip.move", { clip: "c_1", start: 2.9 }), near)).args).toEqual({ clip: "c_1", start: 2.3 });
    expect((await snapRequest(request("cut", { from: 2.5, to: 4.4 }), near)).args).toEqual({ from: 2.3, to: 5, snap: false });
    // The marker being moved is not a target: hook, moved to 2.5, does not snap to itself but finds nothing within reach.
    const moving = await failure(snapRequest(request("marker.set", { marker: "hook", at: 2.5 }), near));
    expect(moving.message).toMatch(/marker.set: snapTo: at: 2.5 s is more than 1 s from the nearest marker \(at 5 s\)/);
    expect((await snapRequest(request("marker.set", { marker: "hook", at: 4.4 }), near)).args).toEqual({ marker: "hook", at: 5 });
    const far = await failure(snapRequest(request("clip.move", { clip: "c_1", start: 8 }), near));
    expect(far.data).toMatchObject({ reason: "snap", field: "snapTo" });
    expect(far.message).toContain(`more than ${MARKER_SNAP_REACH_S} s`);
    const none = await failure(snapRequest(request("clip.move", { clip: "c_1", start: 1 }), { ...near, timeline: createTimeline("main") }));
    expect(none.message).toMatch(/no marker to snap to/);
  });

  it("puts a snapped cut or trim exactly there: pause snapping off unless asked for", async () => {
    expect((await snapRequest(request("cut", { from: 1.1, to: 3.4 }), context)).args).toMatchObject({ snap: false });
    expect((await snapRequest(request("clip.trim", { clip: "c_1", end: 3.4 }), context)).args).toEqual({ clip: "c_1", end: 3.5, snap: false });
    expect((await snapRequest(request("clip.trim", { clip: "c_1", end: 3.4, snap: true }), context)).args).toEqual({ clip: "c_1", end: 3.5, snap: true });
    expect((await snapRequest(request("clip.move", { clip: "c_1", start: 3.4 }), context)).args).not.toHaveProperty("snap");
  });

  it("only touches the time arguments that were given", async () => {
    expect((await snapRequest(request("clip.trim", { clip: "c_1", start: 1.1 }), context)).args).toEqual({ clip: "c_1", start: 1, snap: false });
  });

  it("refuses an operation with nothing to snap, or a name it cannot read", async () => {
    expect((await failure(snapRequest(request("clip.move", { clip: "c_1", track: "t_2" }), context))).message).toMatch(/no time argument to snap/);
    expect((await failure(snapRequest(request("clip.move", { clip: "c_1", start: "outro" }), context))).message).toMatch(/neither seconds nor a marker/);
  });

  it("refuses without a tempo, with a clip that has no beats file yet, and on a LOW confidence grid", async () => {
    const bare = { ...context, timeline: createTimeline("main") };
    const none = await failure(snapRequest(request("clip.move", { clip: "c_1", start: 2 }), bare));
    expect(none.code).toBe(ErrorCode.InvalidOperation);
    expect(none.message).toMatch(/snapTo: the timeline has no tempo/);
    expect(none.data).toMatchObject({ reason: "snap", field: "snapTo" });
    const unmeasured = { ...context, timeline: scored({}, { clip: "c_music" }) };
    expect((await failure(snapRequest(request("clip.move", { clip: "c_1", start: 2 }), unmeasured))).message).toMatch(/has no beat grid yet/);
    const low = { ...unmeasured, beatsOf: beatsOf(beatsFile({ confidence: 0.3 })) };
    expect((await failure(snapRequest(request("clip.move", { clip: "c_1", start: 2 }), low))).message).toMatch(/LOW confidence.*double time or a bar off/);
  });

  it("snaps through a measured grid and refuses a time far outside the music", async () => {
    const measured = { ...context, timeline: scored({ start: 10, in: 0, out: 4 }, { clip: "c_music" }), beatsOf: beatsOf(beatsFile()) };
    expect((await snapRequest(request("clip.move", { clip: "c_1", start: 10.8 }), measured)).args).toEqual({ clip: "c_1", start: 10.7 });
    expect((await failure(snapRequest(request("clip.move", { clip: "c_1", start: 40 }), measured))).message).toMatch(/outside the grid/);
  });
});
