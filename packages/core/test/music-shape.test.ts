import { ErrorCode, RpcError } from "@frameshell/protocol";
import { type Clip, type ClipTrack, type Timeline, createTimeline, gainAt, parseTimeline } from "@frameshell/schema";
import { describe, expect, it } from "vitest";
import { type EditContext, type OperationRequest, type SourceInfo, applyOperation } from "../src/index.js";
import { dipCurve } from "../src/media/duck.js";
import { SHAPE_DEFAULTS, SHAPE_FLOOR_DB, shapeCurve } from "../src/music/shape.js";

// `music.shape`: the pure curve, and the `music.shape` operation on gain keys marked `auto: "music"` next to hand keys
// and the keys of `track.duck`.
const SOURCES: Record<string, SourceInfo> = { "assets/bed.wav": { duration: 60, video: false, audio: true } };

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

const apply = (timeline: Timeline, request: OperationRequest) => applyOperation(timeline, request, context());
const shape = (curve: { time: number; dip: number }[], settings?: object) =>
  ({ op: "music.shape", args: { clip: "m", curve, ...(settings ? { settings } : {}) } }) as OperationRequest;
const duck = (curve: { time: number; dip: number }[]) => ({ op: "track.duck", args: { track: "t_music", curve } }) as OperationRequest;

const bed = (start: number, from: number, to: number, extra: Partial<Clip> = {}): Clip => ({ id: "m", type: "media", asset: "assets/bed.wav", start, in: from, out: to, ...extra }) as Clip;
const music = (clip: Clip, trackKind: "audio" | "video" = "audio"): Timeline => ({ ...createTimeline("main"), tracks: [{ id: "t_music", kind: trackKind, clips: [clip] }] });
const clipOf = (timeline: Timeline): Clip => (timeline.tracks[0] as ClipTrack).clips[0]!;
const VALUES = { ...SHAPE_DEFAULTS, drops: [10], ending: 20 };

describe("shapeCurve", () => {
  it("steps down before a hit, holds past it and comes back", () => {
    expect(shapeCurve({ lead: 0.4, depth: 9, hold: 0.3, release: 0.6, fade: 2.5, drops: [10] }, 30)).toEqual([
      { time: 9.54, dip: 0 },
      { time: 9.6, dip: 9 },
      { time: 10.3, dip: 9 },
      { time: 10.9, dip: 0 },
    ]);
  });

  it("fades from the ending to the floor and stays there to the end of the clip", () => {
    const curve = shapeCurve({ lead: 0.4, depth: 9, hold: 0.3, release: 0.6, fade: 2, ending: 20 }, 30);
    expect(curve).toEqual([
      { time: 20, dip: 0 },
      { time: 22, dip: SHAPE_FLOOR_DB },
      { time: 31, dip: SHAPE_FLOOR_DB },
    ]);
  });

  it("keeps the deeper dip where two hits overlap, and starts part way down when a hit is near 0", () => {
    const overlap = shapeCurve({ lead: 0.4, depth: 9, hold: 0.3, release: 0.6, fade: 2.5, drops: [10, 10.5] }, 30);
    expect(Math.max(...overlap.map((point) => point.dip))).toBe(9);
    expect(overlap.map((point) => point.time)).toEqual([...overlap.map((point) => point.time)].sort((a, b) => a - b));
    const early = shapeCurve({ lead: 0.4, depth: 9, hold: 0.3, release: 0.6, fade: 2.5, drops: [0.2] }, 30);
    // The step down was due before the start: the curve begins at 0, already down.
    expect(early[0]).toEqual({ time: 0, dip: 9 });
  });
});

describe("music.shape operation", () => {
  const curve = shapeCurve(VALUES, 40);

  it("writes music keys: level before, down before the hit, faded after the ending", async () => {
    const { timeline } = await apply(music(bed(0, 0, 40)), shape(curve, VALUES));
    const clip = clipOf(timeline);
    expect(clip.keys?.gain?.every((key) => key.auto === "music")).toBe(true);
    expect(parseTimeline(timeline).ok).toBe(true);
    expect(gainAt(clip, 5)).toBe(0);
    expect(gainAt(clip, 9.7)).toBe(-9);
    expect(gainAt(clip, 10.1)).toBe(-9);
    expect(gainAt(clip, 12)).toBe(0);
    expect(gainAt(clip, 21)).toBeCloseTo(-SHAPE_FLOOR_DB / 2.5, 0);
    expect(gainAt(clip, 30)).toBe(-SHAPE_FLOOR_DB);
    expect(gainAt(clip, 40)).toBe(-SHAPE_FLOOR_DB);
    expect(clip.audio?.shape).toEqual(VALUES);
  });

  it("dips from the clip's own level and follows its source clock", async () => {
    const { timeline } = await apply(music(bed(5, 10, 50, { audio: { gain: -4 } })), shape(curve, VALUES));
    const clip = clipOf(timeline);
    // The hit is at timeline 10 s, source 15 s.
    expect(gainAt(clip, 6)).toBe(-4);
    expect(gainAt(clip, 10.1)).toBeCloseTo(-13, 5);
    expect(clip.audio?.gain).toBe(-4);
  });

  it("replaces its own keys when it runs again and leaves hand keys alone", async () => {
    let timeline = music(bed(0, 0, 40));
    timeline = (await apply(timeline, { op: "clip.key", args: { clip: "m", prop: "gain", time: 3, value: -2 } } as OperationRequest)).timeline;
    timeline = (await apply(timeline, shape(curve, VALUES))).timeline;
    const first = clipOf(timeline).keys!.gain!;
    expect(first.find((key) => key.at === 3)).toEqual({ at: 3, value: -2 });
    const again = shapeCurve({ ...VALUES, drops: [25], ending: undefined as unknown as number }, 40);
    timeline = (await apply(timeline, shape(again, { ...VALUES, drops: [25], ending: undefined }))).timeline;
    const keys = clipOf(timeline).keys!.gain!;
    expect(keys.find((key) => key.at === 3)).toEqual({ at: 3, value: -2 });
    // The first shaping's keys at 10 s are gone; what is left is the clip's ends and the new hit.
    expect(keys.filter((key) => key.auto === "music").every((key) => key.at === 0 || key.at === 40 || key.at >= 24)).toBe(true);
    expect(gainAt(clipOf(timeline), 10)).toBeCloseTo(-2, 5);
  });

  it("leaves a hand key inside a dip as set and says so", async () => {
    let timeline = music(bed(0, 0, 40));
    timeline = (await apply(timeline, { op: "clip.key", args: { clip: "m", prop: "gain", time: 10, value: -2 } } as OperationRequest)).timeline;
    const result = await apply(timeline, shape(curve, VALUES));
    expect(clipOf(result.timeline).keys!.gain!.find((key) => key.at === 10)).toEqual({ at: 10, value: -2 });
    expect(result.warnings.join(" ")).toMatch(/inside the shaped dips/);
  });

  it("clears its keys and the stored settings with an empty curve", async () => {
    const shaped = (await apply(music(bed(0, 0, 40)), shape(curve, VALUES))).timeline;
    const { timeline } = await apply(shaped, shape([]));
    expect(clipOf(timeline).keys).toBeUndefined();
    expect(clipOf(timeline).audio).toBeUndefined();
  });

  it("refuses a clip that is not a media clip of an audio track", async () => {
    await expect(apply(music(bed(0, 0, 40), "video"), shape(curve, VALUES))).rejects.toMatchObject({ code: ErrorCode.InvalidOperation });
  });

});

describe("music keys under a duck", () => {
  const speech = dipCurve([{ start: 12, end: 14 }], { depth: 7, attack: 0.04, release: 0.45 });
  const shaped = async () => (await apply(music(bed(0, 0, 40)), shape(shapeCurve({ ...SHAPE_DEFAULTS, drops: [13] }, 40), { ...SHAPE_DEFAULTS, drops: [13] }))).timeline;

  it("dips a music key as it dips a hand key, and gives it its mark back when duck runs again", async () => {
    const before = await shaped();
    const musicKeys = clipOf(before).keys!.gain!.filter((key) => key.auto === "music");
    const ducked = (await apply(before, duck(speech))).timeline;
    const keys = clipOf(ducked).keys!.gain!;
    // The music keys inside the dip are duck keys over a music key.
    const over = keys.filter((key) => key.baseAuto === "music");
    expect(over.length).toBeGreaterThan(0);
    expect(over.every((key) => key.auto === "duck" && key.base !== undefined)).toBe(true);
    expect(parseTimeline(ducked).ok).toBe(true);
    const again = (await apply(ducked, duck([{ time: 0, dip: 0 }]))).timeline;
    expect(clipOf(again).keys!.gain!.filter((key) => key.auto === "music")).toEqual(musicKeys);
    expect(clipOf(again).keys!.gain!.some((key) => key.auto === "duck")).toBe(false);
  });

  it("drops the duck keys when it runs again, so the duck can be written over the new keys", async () => {
    const ducked = (await apply(await shaped(), duck(speech))).timeline;
    const { timeline } = await apply(ducked, shape(shapeCurve({ ...SHAPE_DEFAULTS, drops: [30] }, 40), { ...SHAPE_DEFAULTS, drops: [30] }));
    const keys = clipOf(timeline).keys!.gain!;
    expect(keys.every((key) => key.auto === "music")).toBe(true);
    expect(keys.every((key) => key.at > 28 || key.at === 0 || key.at === 40)).toBe(true);
    const reducked = (await apply(timeline, duck(speech))).timeline;
    expect(gainAt(clipOf(reducked), 13)).toBe(-7);
    expect(gainAt(clipOf(reducked), 29.8)).toBe(-9);
  });
});
