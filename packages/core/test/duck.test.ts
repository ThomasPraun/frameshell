import { ErrorCode, RpcError } from "@frameshell/protocol";
import { type Clip, type ClipTrack, type Timeline, createTimeline, gainAt, parseTimeline } from "@frameshell/schema";
import { describe, expect, it } from "vitest";
import {
  type EditContext,
  type OperationRequest,
  type SourceInfo,
  applyOperation,
  applyPatch,
} from "../src/index.js";
import { dipAt, dipCurve, loudSpans, spansOnTimeline, speechStretches, voiceRuns } from "../src/media/duck.js";
import { ENERGY_HOP_S, type EnergyProfile } from "../src/media/energy.js";

const SOURCES: Record<string, SourceInfo> = {
  "assets/bed.wav": { duration: 30, video: false, audio: true },
  "assets/talk.mp4": { duration: 30, video: true, audio: true },
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

const duck = (curve: { time: number; dip: number }[], track = "t_music") => ({ op: "track.duck", args: { track, curve } }) as OperationRequest;
const apply = (timeline: Timeline, request: OperationRequest) => applyOperation(timeline, request, context());

const bed = (id: string, start: number, from: number, to: number, extra: Partial<Clip> = {}): Clip =>
  ({ id, type: "media", asset: "assets/bed.wav", start, in: from, out: to, ...extra }) as Clip;

function music(...clips: Clip[]): Timeline {
  return { ...createTimeline("main"), tracks: [{ id: "t_music", kind: "audio", clips }, { id: "t_voice", kind: "video", clips: [] }] };
}

function clipOf(timeline: Timeline, id: string): Clip {
  for (const track of timeline.tracks) {
    if (track.kind === "subtitles" || track.kind === "program") continue;
    const found = (track as ClipTrack).clips.find((c) => c.id === id);
    if (found) return found;
  }
  throw new Error(`no clip ${id}`);
}

/** Voice from 2 to 4 s: ramp down over 40 ms to 7 dB, hold, back over 450 ms. */
const CURVE = dipCurve([{ start: 2, end: 4 }], { depth: 7, attack: 0.04, release: 0.45 });

describe("speech stretches", () => {
  it("finds the runs of an envelope above the gate", () => {
    const db = new Float32Array(100).fill(-60);
    db.fill(-20, 10, 30);
    db.fill(-30, 50, 51);
    expect(loudSpans(db, -38)).toEqual([
      { start: 10 * ENERGY_HOP_S, end: 30 * ENERGY_HOP_S },
      { start: 50 * ENERGY_HOP_S, end: 51 * ENERGY_HOP_S },
    ]);
    expect(loudSpans(new Float32Array(0), -38)).toEqual([]);
  });

  it("lays source spans on the timeline through the clip window and its speed", () => {
    const spans = [{ start: 1, end: 3 }, { start: 8, end: 9 }];
    expect(spansOnTimeline(spans, { from: 2, to: 8.5, start: 10, speed: 1 })).toEqual([
      { start: 10, end: 11 },
      { start: 16, end: 16.5 },
    ]);
    expect(spansOnTimeline([{ start: 2, end: 4 }], { from: 0, to: 10, start: 5, speed: 2 })).toEqual([{ start: 6, end: 7 }]);
  });

  it("merges runs closer than the gap, and than attack + release, and drops clicks", () => {
    const runs = [
      { start: 5, end: 5.05 },
      { start: 1, end: 2 },
      { start: 2.5, end: 3 },
      { start: 3.7, end: 4 },
    ];
    expect(speechStretches(runs, { gap: 0.6, attack: 0.04, release: 0.45 })).toEqual([
      { start: 1, end: 3 },
      { start: 3.7, end: 4 },
    ]);
    // Longer attack + release than the gap: 0.7 s apart no longer leaves room for the dip.
    expect(speechStretches(runs, { gap: 0.1, attack: 0.3, release: 0.5 })).toEqual([{ start: 1, end: 4 }]);
  });
});

describe("dip curve", () => {
  it("steps down before the voice and lets go after it", () => {
    expect(CURVE).toEqual([
      { time: 1.96, dip: 0 },
      { time: 2, dip: 7 },
      { time: 4, dip: 7 },
      { time: 4.45, dip: 0 },
    ]);
    expect(dipAt(CURVE, 1)).toBe(0);
    expect(dipAt(CURVE, 1.98)).toBeCloseTo(3.5, 6);
    expect(dipAt(CURVE, 3)).toBe(7);
    expect(dipAt(CURVE, 4.225)).toBeCloseTo(3.5, 6);
    expect(dipAt(CURVE, 9)).toBe(0);
  });

  it("starts part way down when the voice is there from the start", () => {
    const curve = dipCurve([{ start: 0.01, end: 1 }], { depth: 8, attack: 0.04, release: 0.45 });
    expect(curve[0]).toEqual({ time: 0, dip: 6 });
    expect(dipAt(curve, 0)).toBe(6);
  });
});

describe("track.duck", () => {
  it("writes a full-level key at the clip start, the dip, and a key at the end", async () => {
    const { timeline } = await apply(music(bed("m", 0, 0, 8)), duck(CURVE));
    const keys = clipOf(timeline, "m").keys?.gain ?? [];
    expect(keys.map((key) => [key.at, key.value])).toEqual([
      [0, 0],
      [1.967, 0],
      [2, -7],
      [4, -7],
      [4.467, 0],
      [8, 0],
    ]);
    expect(keys.every((key) => key.auto === "duck")).toBe(true);
    expect(parseTimeline(timeline).ok).toBe(true);
    const clip = clipOf(timeline, "m");
    expect(gainAt(clip, 1)).toBe(0);
    expect(gainAt(clip, 3)).toBe(-7);
    expect(gainAt(clip, 4.233)).toBeCloseTo(-3.5, 1);
    expect(gainAt(clip, 6)).toBe(0);
  });

  it("dips from the clip's own level, and follows its source clock", async () => {
    // Plays source 10-18 at timeline 5-13 (speed 1): timeline 7 s is source 12 s.
    const clip = bed("m", 5, 10, 18, { audio: { gain: -4 } });
    const { timeline } = await apply(music(clip), duck(dipCurve([{ start: 7, end: 8 }], { depth: 6, attack: 0.04, release: 0.45 })));
    const out = clipOf(timeline, "m");
    expect(out.keys?.gain?.map((key) => [key.at, key.value])).toEqual([
      [10, -4],
      [11.967, -4],
      [12, -10],
      [13, -10],
      [13.433, -4],
      [18, -4],
    ]);
    expect(gainAt(out, 7.5)).toBe(-10);
    expect(gainAt(out, 10)).toBe(-4);
  });

  it("writes only what lies inside each clip, with the dip's value at its edges", async () => {
    // Two clips butted at 3: the first ends in the middle of the voice, the second starts in it.
    const { timeline } = await apply(music(bed("a", 0, 0, 3), bed("b", 3, 0, 3)), duck(CURVE));
    expect(clipOf(timeline, "a").keys?.gain?.map((key) => [key.at, key.value])).toEqual([
      [0, 0],
      [1.967, 0],
      [2, -7],
      [3, -7],
    ]);
    expect(clipOf(timeline, "b").keys?.gain?.map((key) => [key.at, key.value])).toEqual([
      [0, -7],
      [1, -7],
      [1.467, 0],
      [3, 0],
    ]);
  });

  it("leaves a clip the voice never reaches without keys, and keeps its static gain", async () => {
    const { timeline, warnings } = await apply(music(bed("far", 20, 0, 4, { audio: { gain: -3 } })), duck(CURVE));
    expect(clipOf(timeline, "far").keys).toBeUndefined();
    expect(clipOf(timeline, "far").audio).toEqual({ gain: -3 });
    expect(warnings.join(" ")).toMatch(/no clip of t_music lies under speech/);
  });

  it("skips a muted clip", async () => {
    const { timeline } = await apply(music(bed("m", 0, 0, 8, { audio: { muted: true } })), duck(CURVE));
    expect(clipOf(timeline, "m").keys).toBeUndefined();
  });

  it("replaces its own keys on a second run and leaves hand-set keys alone", async () => {
    const first = await apply(music(bed("m", 0, 0, 8)), duck(CURVE));
    // A person lifts the level at 7 s by hand (clip.key clears the mark of any key it sets).
    const handled = await applyOperation(first.timeline, { op: "clip.key", args: { clip: "m", prop: "gain", time: 7, value: 3 } }, context());
    const hand = clipOf(handled.timeline, "m").keys?.gain?.find((key) => key.at === 7);
    expect(hand).toEqual({ at: 7, value: 3 });

    // The voice moves to 5-6 s: the old dip goes, the new one is taken from the level the person set.
    const second = await apply(handled.timeline, duck(dipCurve([{ start: 5, end: 6 }], { depth: 7, attack: 0.04, release: 0.45 })));
    const keys = clipOf(second.timeline, "m").keys?.gain ?? [];
    expect(keys.find((key) => key.at === 7)).toEqual({ at: 7, value: 3 });
    expect(keys.filter((key) => key.auto === "duck").every((key) => key.at !== 2 && key.at !== 4)).toBe(true);
    const clip = clipOf(second.timeline, "m");
    // A hand key sets the level the dip is taken from: the lane holds its 3 dB back to the clip start.
    expect(gainAt(clip, 3)).toBe(3);
    expect(gainAt(clip, 5.5)).toBe(-4);
    expect(parseTimeline(second.timeline).ok).toBe(true);
  });

  it("removes its keys when no voice is left, keeping hand keys", async () => {
    const first = await apply(music(bed("m", 0, 0, 8)), duck(CURVE));
    const handled = await applyOperation(first.timeline, { op: "clip.key", args: { clip: "m", prop: "gain", time: 6, value: -2 } }, context());
    const none = await apply(handled.timeline, duck([{ time: 0, dip: 0 }]));
    expect(clipOf(none.timeline, "m").keys?.gain).toEqual([{ at: 6, value: -2 }]);
    const clean = await apply(first.timeline, duck([{ time: 0, dip: 0 }]));
    expect(clipOf(clean.timeline, "m").keys).toBeUndefined();
  });

  it("undoes with its inverse patch", async () => {
    const before = music(bed("m", 0, 0, 8));
    const { timeline, inverse } = await apply(before, duck(CURVE));
    expect(applyPatch(timeline, inverse.args).tracks).toEqual(before.tracks);
  });

  it("refuses a video track and a missing one", async () => {
    await expect(apply(music(bed("m", 0, 0, 8)), duck(CURVE, "t_voice"))).rejects.toMatchObject({ code: ErrorCode.InvalidOperation });
    await expect(apply(music(bed("m", 0, 0, 8)), duck(CURVE, "t_nope"))).rejects.toMatchObject({ code: ErrorCode.TrackNotFound });
  });
});

describe("voice runs", () => {
  const profile = (db: Float32Array): EnergyProfile => ({ db, threshold: -60 });
  const loud = (from: number, to: number) => {
    const db = new Float32Array(2000).fill(-70);
    db.fill(-20, from / ENERGY_HOP_S, to / ENERGY_HOP_S);
    return profile(db);
  };

  it("listens to media clips on the named tracks, not to muted ones", async () => {
    const timeline: Timeline = {
      ...createTimeline("main"),
      tracks: [
        { id: "t_a", kind: "video", clips: [{ id: "v1", type: "media", asset: "assets/talk.mp4", start: 10, in: 2, out: 6 } as Clip] },
        { id: "t_b", kind: "audio", muted: true, clips: [{ id: "v2", type: "media", asset: "assets/other.wav", start: 0, in: 0, out: 5 } as Clip] },
        {
          id: "t_c",
          kind: "audio",
          clips: [
            { id: "v3", type: "media", asset: "assets/muted.wav", start: 0, in: 0, out: 5, audio: { muted: true } } as Clip,
            { id: "v4", type: "timeline", source: "timelines/scene.json", start: 20, duration: 5 } as Clip,
          ],
        },
      ],
    };
    const asked: string[] = [];
    const { runs, warnings } = await voiceRuns(timeline, ["t_a", "t_b", "t_c"], {
      threshold: -38,
      profile: async (asset) => {
        asked.push(asset);
        return loud(3, 4);
      },
    });
    expect(asked).toEqual(["assets/talk.mp4"]);
    expect(runs).toEqual([{ start: 11, end: 12 }]);
    expect(warnings.join(" ")).toMatch(/v4 on t_c is a nested timeline/);
  });

  it("skips an asset that cannot be decoded", async () => {
    const timeline: Timeline = {
      ...createTimeline("main"),
      tracks: [{ id: "t_a", kind: "video", clips: [{ id: "v1", type: "media", asset: "assets/still.png", start: 0, in: 0, out: 5 } as Clip] }],
    };
    const { runs } = await voiceRuns(timeline, ["t_a"], { threshold: -38, profile: async () => Promise.reject(new Error("no audio")) });
    expect(runs).toEqual([]);
  });
});
