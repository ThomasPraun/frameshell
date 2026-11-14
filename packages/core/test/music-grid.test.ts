import { ErrorCode, RpcError } from "@frameshell/protocol";
import { type AnyClip, type Clip, type Timeline, createTimeline, parseTimeline } from "@frameshell/schema";
import { describe, expect, it } from "vitest";
import { type EditContext, type SourceInfo, applyOperation } from "../src/index.js";
import { type GridMovesDeps, type GridMovesRequest, type GridWord, planGridMoves } from "../src/music/grid-moves.js";
import { FrameGrid } from "../src/timeline/grid.js";
import { tempoGrid } from "../src/timeline/tempo.js";
import { clipEnd } from "../src/timeline/timing.js";

// Seam under test: planGridMoves with the real engine in memory. The grid is nominal at 120 BPM riding on the music
// clip (a beat every 0.5 s from timeline 0), so cuts at x.0 and x.5 s are on it and nothing needs a beats file.

const SOURCES: Record<string, SourceInfo> = {
  "assets/shots.mp4": { duration: 20, video: true, audio: false },
  "assets/talk.mp4": { duration: 20, video: true, audio: true },
  "assets/short.mp4": { duration: 2.2, video: true, audio: false },
  "assets/music.wav": { duration: 30, video: false, audio: true },
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
    nestedDuration: async () => 5,
    clipTypes: async () => new Map(),
    newId: (prefix) => `${prefix}_${String(++next).padStart(4, "0")}`,
  };
}

const media = (id: string, asset: string, start: number, length: number, from = 0): Clip => ({ id, type: "media", asset, start, in: from, out: from + length });

/** Shots a, b, c on t_v (meeting at `cuts`), music across all of them on t_m with a 120 BPM nominal grid. */
function timeline(cuts: [number, number], extra: Timeline["tracks"] = [], asset = "assets/shots.mp4"): Timeline {
  const [first, second] = cuts;
  const parsed = parseTimeline({
    ...createTimeline("main"),
    tracks: [
      { id: "t_v", kind: "video", clips: [media("c_a1", asset, 0, first), media("c_b1", asset, first, second - first, 5), media("c_c1", asset, second, 6.5 - second, 10)] },
      { id: "t_m", kind: "audio", clips: [media("c_ma", "assets/music.wav", 0, 9)] },
      ...extra,
    ],
    tempo: { clip: "c_ma", bpm: 120 },
  });
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
}

function deps(state: Timeline, words: Record<string, readonly GridWord[]> = {}): GridMovesDeps {
  const grid = new FrameGrid(30);
  return {
    loadGrid: (horizon) => tempoGrid({ fps: 30, timeline: state, horizon, beatsOf: async () => null }),
    apply: (current, request) => applyOperation(current, request, context()),
    end: (clip) => clipEnd(clip, grid, async () => 5),
    words: async (asset) => words[asset] ?? "no-transcript",
    hasAudio: async (asset) => SOURCES[asset]?.audio ?? false,
  };
}

const request = (overrides: Partial<GridMovesRequest> = {}): GridMovesRequest => ({ to: "beat", maxShift: 0.25, ...overrides });

/** Apply the planned operations in order, as the daemon does. */
async function applied(state: Timeline, requests: Awaited<ReturnType<typeof planGridMoves>>["requests"]): Promise<Timeline> {
  let current = state;
  for (const operation of requests) current = (await applyOperation(current, operation, context())).timeline;
  return current;
}

function clip(state: Timeline, id: string): AnyClip {
  for (const track of state.tracks) {
    if (track.kind === "subtitles") continue;
    const found = (track.clips as readonly AnyClip[]).find((candidate) => candidate.id === id);
    if (found) return found;
  }
  throw new Error(`no clip ${id}`);
}

const end = (state: Timeline, id: string) => {
  const found = clip(state, id) as Extract<Clip, { type: "media" }>;
  return Math.round((found.start + (found.out - found.in)) * 1000) / 1000;
};

describe("planGridMoves", () => {
  it("lands each cut within reach on its nearest beat; the music and its beats stay", async () => {
    const state = timeline([2.1, 4.4]);
    const plan = await planGridMoves(state, 30, request(), deps(state));
    expect(plan.cuts.map(({ id, at, beat, ref, shiftMs, status, landsAt }) => ({ id, at, beat, ref, shiftMs, status, landsAt }))).toEqual([
      { id: "g1", at: 2.1, beat: 2, ref: "beat:5", shiftMs: -100, status: "move", landsAt: 2 },
      { id: "g2", at: 4.4, beat: 4.5, ref: "beat:10", shiftMs: 100, status: "move", landsAt: 4.5 },
    ]);
    expect(plan.moved).toBe(2);
    expect(plan.ripple).toEqual(["t_v"]);
    expect(plan.grid).toEqual({ source: "nominal", bpm: 120, meter: 4, clip: "c_ma", confidence: null });
    // The last cut moved 0.1 s later and nothing after it puts it back.
    expect(plan.durationChange).toBe(0.1);
    expect(plan.requests).toEqual([
      { op: "clip.trim", args: { clip: "c_a1", end: 2, snap: false, ripple: true, rippleTracks: ["t_v"] } },
      { op: "clip.trim", args: { clip: "c_b1", end: 4.5, snap: false, ripple: true, rippleTracks: ["t_v"] } },
    ]);
    const after = await applied(state, plan.requests);
    expect([end(after, "c_a1"), clip(after, "c_b1").start, end(after, "c_b1"), clip(after, "c_c1").start]).toEqual([2, 2, 4.5, 4.5]);
    expect(clip(after, "c_ma")).toEqual(clip(state, "c_ma"));
  });

  it("puts a cut that does not move back where it was, so only the shots between change length", async () => {
    const state = timeline([2.1, 4]);
    const plan = await planGridMoves(state, 30, request(), deps(state));
    expect(plan.cuts.map(({ status, landsAt }) => [status, landsAt])).toEqual([
      ["move", 2],
      ["on-grid", 4],
    ]);
    expect(plan.durationChange).toBe(0);
    const after = await applied(state, plan.requests);
    expect([end(after, "c_a1"), clip(after, "c_b1").start, end(after, "c_b1"), clip(after, "c_c1").start, end(after, "c_c1")]).toEqual([2, 2, 4, 4, 6.5]);
  });

  it("lists cuts farther than maxShift as far and skips ids, and moves them when asked", async () => {
    const state = timeline([2.2, 4.4]);
    const plan = await planGridMoves(state, 30, request({ maxShift: 0.15, skip: ["g1"] }), deps(state));
    expect(plan.cuts.map(({ id, status, reason }) => [id, status, reason])).toEqual([
      [null, "far", "200 ms from beat:5, more than maxShift 0.15 s."],
      ["g1", "skipped", null],
    ]);
    expect(plan.requests).toEqual([]);
    expect(plan.moved).toBe(0);
    await expect(planGridMoves(state, 30, request({ skip: ["g9"] }), deps(state))).rejects.toMatchObject({
      code: ErrorCode.InvalidOperation,
      data: { reason: "skip", valid: ["g1", "g2", "duck"] },
    });
  });

  it("lands cuts on bar starts with to: bar", async () => {
    const state = timeline([1.9, 4.4]);
    const plan = await planGridMoves(state, 30, request({ to: "bar", maxShift: 0.5 }), deps(state));
    expect(plan.cuts.map(({ beat, ref, status }) => [beat, ref, status])).toEqual([
      [2, "bar:2", "move"],
      [4, "bar:3", "move"],
    ]);
  });

  it("leaves a cut the music does not run across", async () => {
    const state = timeline([2.1, 4.4]);
    const short = structuredClone(state);
    const music = clip(short, "c_ma") as Extract<Clip, { type: "media" }>;
    music.out = 3;
    const plan = await planGridMoves(short, 30, request(), deps(short));
    expect(plan.cuts.map(({ status }) => status)).toEqual(["move", "outside"]);
    expect(plan.cuts[1]!.reason).toMatch(/does not run across it/);
  });

  it("trims the sound that ends with the cut on a rippled track, and keeps a voice line across a cut where it was", async () => {
    const state = timeline([2.1, 4.4], [
      { id: "t_d", kind: "audio", clips: [media("c_d1", "assets/talk.mp4", 0, 2.1), media("c_d2", "assets/talk.mp4", 2.1, 2.3, 5)] },
      { id: "t_o", kind: "audio", clips: [media("c_o1", "assets/music.wav", 3, 3)] },
    ]);
    const plan = await planGridMoves(state, 30, request(), deps(state, { "assets/talk.mp4": [] }));
    // t_o's line runs across 4.4 s: that track keeps its timing, like the music.
    expect(plan.ripple).toEqual(["t_v", "t_d"]);
    expect(plan.requests.slice(0, 2)).toEqual([
      { op: "clip.trim", args: { clip: "c_d1", end: 2, snap: false } },
      { op: "clip.trim", args: { clip: "c_a1", end: 2, snap: false, ripple: true, rippleTracks: ["t_v", "t_d"] } },
    ]);
    const after = await applied(state, plan.requests);
    expect([end(after, "c_d1"), clip(after, "c_d2").start]).toEqual([2, 2]);
    expect(clip(after, "c_o1").start).toBe(3);
  });

  it("blocks a move that would cut a word, and one with no material left in the file", async () => {
    const state = timeline([2.1, 4.4], [{ id: "t_d", kind: "audio", clips: [media("c_d1", "assets/talk.mp4", 0, 2.1), media("c_d2", "assets/talk.mp4", 2.1, 2.3, 5)] }]);
    const plan = await planGridMoves(state, 30, request(), deps(state, { "assets/talk.mp4": [{ text: "okay", start: 1.95, end: 2.05 }] }));
    expect(plan.cuts[0]).toMatchObject({ id: "g1", status: "blocked", landsAt: 2.1 });
    expect(plan.cuts[0]!.reason).toMatch(/would cut "okay" from the end of c_d1/);
    expect(plan.cuts[1]).toMatchObject({ id: "g2", status: "move", landsAt: 4.5 });

    const short = timeline([2.1, 4.4], [], "assets/short.mp4");
    const shortPlan = await planGridMoves(short, 30, request(), deps(short));
    expect(shortPlan.cuts[1]).toMatchObject({ status: "blocked" });
    expect(shortPlan.cuts[1]!.reason).toMatch(/past the end of assets\/short\.mp4/);
  });

  it("blocks a move that would put a shot out of sync with its own J-cut sound on a track that keeps its timing", async () => {
    // c_s is c_b1's own sound (same file, same source second at the same timeline second), starting 0.3 s before its picture.
    const state = timeline([2.1, 4.4], [{ id: "t_d", kind: "audio", clips: [media("c_s", "assets/talk.mp4", 1.8, 2.6, 4.7)] }], "assets/talk.mp4");
    const plan = await planGridMoves(state, 30, request(), deps(state, { "assets/talk.mp4": [] }));
    expect(plan.ripple).toEqual(["t_v"]);
    expect(plan.cuts[0]).toMatchObject({ id: "g1", status: "blocked", landsAt: 2.1 });
    expect(plan.cuts[0]!.reason).toBe(
      "after the move c_b1 on t_v plays 100 ms early against c_s on t_d, its own sound from assets/talk.mp4 on a track that keeps its timing (a clip on it runs across a cut).",
    );
    // c_c1 is not c_s's picture: the cut moves, and the sound ending on it is named with what that does to the next shot.
    expect(plan.cuts[1]).toMatchObject({ id: "g2", status: "move", landsAt: 4.5 });
    expect(plan.cuts[1]!.warnings).toContainEqual(
      "c_s on t_d ends on the cut, but its track keeps its timing (a clip on it runs across a cut): it stays where it is, so c_c1, the shot after the cut, starts 100 ms after it ends and plays that much out of sync with it.",
    );
    const after = await applied(state, plan.requests);
    expect(clip(after, "c_b1").start).toBe(2.1);
  });

  it("warns when a cut cannot be put back after an earlier move, naming a shot that slips against its sound", async () => {
    // g1 moves 2.4 -> 2.5; putting 4 back would cut "now" from the end of c_b1, so c_c1 stays 100 ms late against c_s.
    const state = timeline([2.4, 4], [{ id: "t_d", kind: "audio", clips: [media("c_s", "assets/talk.mp4", 3.8, 2, 9.8)] }], "assets/talk.mp4");
    const plan = await planGridMoves(state, 30, request(), deps(state, { "assets/talk.mp4": [{ text: "now", start: 6.52, end: 6.58 }] }));
    expect(plan.cuts.map(({ id, status, landsAt }) => [id, status, landsAt])).toEqual([
      ["g1", "move", 2.5],
      [null, "on-grid", 4.1],
    ]);
    expect(plan.cuts[1]!.warnings).toEqual([
      expect.stringMatching(/^It moved 100 ms with the cuts before it and cannot be put back: would cut "now" from the end of c_b1/),
      "So c_c1 on t_v plays 100 ms late against c_s on t_d, its own sound from assets/talk.mp4 on a track that keeps its timing (a clip on it runs across a cut), up to the next cut.",
    ]);
    expect(plan.durationChange).toBe(0.1);
  });

  it("runs the duck again after the moves when the music carries duck keys, unless skipped", async () => {
    const state = timeline([2.1, 4.4]);
    const music = clip(state, "c_ma") as Extract<Clip, { type: "media" }>;
    music.keys = { gain: [{ at: 0, value: 0, auto: "duck" }, { at: 3, value: -7, auto: "duck" }] };
    const plan = await planGridMoves(state, 30, request({ dryRun: true }), deps(state));
    expect(plan.duck).toEqual({ under: ["t_v"], rerun: true, parameters: "defaults" });
    expect(plan.duckAgain).toEqual({ track: "t_m", under: ["t_v"], settings: null });
    expect(plan.warnings).toContainEqual(expect.stringMatching(/^c_ma carries duck keys: duck would run again on t_m over t_v/));

    const skipped = await planGridMoves(state, 30, request({ skip: ["duck"] }), deps(state));
    expect(skipped.duck).toEqual({ under: ["t_v"], rerun: false, parameters: "defaults" });
    expect(skipped.duckAgain).toBeNull();
    expect(skipped.warnings).toContainEqual(expect.stringMatching(/no longer line up with the voice that moved with the cuts \(skipped\)/));
    expect(skipped.requests.length).toBeGreaterThan(0);
  });

  it("warns when a clip with sound has no transcript to check", async () => {
    const state = timeline([2.1, 4.4], [], "assets/talk.mp4");
    const plan = await planGridMoves(state, 30, request(), deps(state));
    expect(plan.cuts[0]!.warnings).toEqual([expect.stringMatching(/c_a1 \(assets\/talk\.mp4\) has sound but no transcript/)]);
  });

  it("refuses a timeline without a tempo, naming how to set one", async () => {
    const state = timeline([2.1, 4.4]);
    delete state.tempo;
    await expect(planGridMoves(state, 30, request(), deps(state))).rejects.toMatchObject({ code: ErrorCode.InvalidOperation, data: { reason: "grid" } });
  });

  it("warns about a marker on a cut that moved", async () => {
    const state = { ...timeline([2.1, 4.4]), markers: [{ id: "m_1a", at: 2.1, label: "slam" }] };
    const plan = await planGridMoves(state, 30, request(), deps(state));
    expect(plan.warnings).toEqual([expect.stringMatching(/Marker "slam" stays at 2\.1 s; the cut it was on moved to 2 s/)]);
  });
});
