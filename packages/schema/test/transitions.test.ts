import { describe, expect, it } from "vitest";
import {
  type Clip,
  type ClipEdges,
  type TransitionContext,
  circleReach,
  clipHandles,
  createTimeline,
  dissolveProgress,
  dissolveWeights,
  easeFraction,
  edgeTransitions,
  fadeWeight,
  GRID_RANKS,
  gainAt,
  gridRank,
  gridRows,
  irisCentre,
  keyedValueAt,
  parseTimeline,
  placementAt,
  shapeAt,
  shapeProgress,
  slatRects,
  soundCurve,
  zoomFactor,
} from "../src/index.js";

const media = (id: string, start: number, from: number, to: number, extra: Partial<Clip> = {}): Clip =>
  ({ id, type: "media", asset: `assets/${id}.mp4`, start, in: from, out: to, ...extra }) as Clip;

const context: TransitionContext = { fps: 10, sourceDuration: () => 30 };

const edgesOf = (clips: Clip[], ctx = context): Map<string, ClipEdges> => edgeTransitions(clips, ctx);

describe("edgeTransitions", () => {
  it("plays a dissolve at full length when both clips have handles", () => {
    const edges = edgesOf([media("a", 0, 5, 15), media("b", 10, 5, 15, { dissolve: 1 })]);
    expect(edges.get("b")).toMatchObject({ mode: "dissolve", dissolve: 0.5, dissolveLength: 1, fadeIn: 0 });
    expect(edges.get("a")).toMatchObject({ mode: null, fadeOut: 0 });
  });

  it("cuts each half to the shorter handle", () => {
    const tail = edgesOf([media("a", 0, 5, 29.8), media("b", 24.8, 5, 15, { dissolve: 1 })]);
    expect(tail.get("b")!.dissolve).toBeCloseTo(0.2);
    const head = edgesOf([media("a", 0, 5, 15), media("b", 10, 0.3, 10, { dissolve: 1 })]);
    expect(head.get("b")!.dissolve).toBeCloseTo(0.3);
  });

  it("divides handles by speed", () => {
    const fast = media("a", 0, 5, 25, { speed: 2 });
    expect(clipHandles(fast, context).before).toBeCloseTo(2.5);
    expect(clipHandles(fast, context).after).toBeCloseTo(2.5);
  });

  it("falls back to a dip through black when a clip has no handle", () => {
    const edges = edgesOf([media("a", 0, 5, 30), media("b", 25, 5, 15, { dissolve: 1 })]);
    expect(edges.get("b")).toMatchObject({ mode: "dip", dissolve: 0, fadeIn: 0.5, dissolveLength: 1 });
    expect(edges.get("a")!.fadeOut).toBeCloseTo(0.5);
  });

  it("plays a shaped dissolve at full length past missing handles, the edge frames held", () => {
    const shape = { kind: "push" as const };
    const edges = edgesOf([media("a", 0, 5, 30), media("b", 25, 0, 10, { dissolve: 1, shape })]);
    expect(edges.get("b")).toMatchObject({ mode: "dissolve", dissolve: 0.5, dissolveLength: 1, fadeIn: 0 });
    expect(edges.get("a")).toMatchObject({ fadeOut: 0, mode: null });
  });

  it("plays a shape on a nested clip as on any clip: not cut to the handles", () => {
    const nested = (extra: Partial<Clip>) => ({ id: "n", type: "timeline", source: "timelines/n.json", start: 25, in: 0, duration: 10, dissolve: 1, ...extra }) as Clip;
    expect(edgesOf([media("a", 0, 5, 30), nested({})]).get("n")!.mode).toBe("dip");
    expect(edgesOf([media("a", 0, 5, 30), nested({ shape: { kind: "push" } })]).get("n")).toMatchObject({ mode: "dissolve", dissolve: 0.5 });
  });

  it("still cuts a shaped dissolve to half of each clip", () => {
    const edges = edgesOf([media("a", 0, 5, 5.4), media("b", 0.4, 0, 10, { dissolve: 2, shape: { kind: "wipe" } })]);
    expect(edges.get("b")).toMatchObject({ mode: "dissolve", dissolve: 0.2 });
  });

  it("plays an unbutted dissolve as a fade in of the same length", () => {
    const edges = edgesOf([media("a", 0, 5, 15), media("b", 12, 5, 15, { dissolve: 1 })]);
    expect(edges.get("b")).toMatchObject({ mode: "fade-in", dissolve: 0, fadeIn: 1, dissolveLength: 1 });
    expect(edges.get("a")!.fadeOut).toBe(0);
    const first = edgesOf([media("a", 0, 5, 15, { dissolve: 1 })]);
    expect(first.get("a")!.fadeIn).toBe(1);
  });

  it("takes at most half of each clip", () => {
    const shortIncoming = edgesOf([media("a", 0, 5, 15), media("b", 10, 5, 6, { dissolve: 4 })]);
    expect(shortIncoming.get("b")!.dissolve).toBeCloseTo(0.5);
    const shortOutgoing = edgesOf([media("a", 0, 5, 5.6), media("b", 0.6, 5, 15, { dissolve: 4 })]);
    expect(shortOutgoing.get("b")!.dissolve).toBeCloseTo(0.3);
    const fades = edgesOf([media("a", 0, 5, 6, { fadeIn: 3, fadeOut: 3 })]);
    expect(fades.get("a")).toMatchObject({ fadeIn: 0.5, fadeOut: 0.5 });
  });

  it("rounds to whole frames", () => {
    const edges = edgesOf([media("a", 0, 5, 15), media("b", 10, 5, 15, { dissolve: 0.5 })]);
    expect(edges.get("b")!.dissolve).toBeCloseTo(0.3);
    const capped = edgesOf([media("a", 0, 5, 15), media("b", 10, 0.37, 15, { dissolve: 2 })]);
    expect(capped.get("b")!.dissolve).toBeCloseTo(0.3);
  });

  it("gives stills and adapter clips unlimited handles", () => {
    const still = media("a", 0, 0, 5);
    const stills: TransitionContext = { fps: 10, sourceDuration: (clip) => ("asset" in clip && clip.id === "a" ? Number.POSITIVE_INFINITY : 30) };
    expect(clipHandles(still, stills)).toEqual({ before: Infinity, after: Infinity });
    const adapter = { id: "h", type: "hyperframes", start: 5, duration: 5 } as Clip;
    expect(clipHandles(adapter, context)).toEqual({ before: Infinity, after: Infinity });
    const edges = edgesOf([still, { ...adapter, start: 5, dissolve: 1 } as Clip], stills);
    expect(edges.get("h")).toMatchObject({ mode: "dissolve", dissolve: 0.5 });
  });

  it("counts nested-timeline seconds outside the window as handles", () => {
    const nested = { id: "n", type: "timeline", source: "timelines/x.json", start: 0, in: 2, duration: 5 } as Clip;
    expect(clipHandles(nested, { fps: 10, sourceDuration: () => 20 })).toEqual({ before: 2, after: 13 });
    expect(clipHandles(nested, { fps: 10 })).toEqual({ before: 2, after: 0 });
  });

  it("returns every clip and ignores input order", () => {
    const edges = edgesOf([media("b", 10, 5, 15, { dissolve: 1 }), media("a", 0, 5, 15)]);
    expect([...edges.keys()].sort()).toEqual(["a", "b"]);
    expect(edges.get("b")!.mode).toBe("dissolve");
  });
});

describe("eases", () => {
  it("evaluates f, f², f(2-f) and f²(3-2f)", () => {
    expect(easeFraction(undefined, 0.5)).toBe(0.5);
    expect(easeFraction("linear", 0.25)).toBe(0.25);
    expect(easeFraction("in", 0.5)).toBe(0.25);
    expect(easeFraction("out", 0.5)).toBe(0.75);
    expect(easeFraction("in-out", 0.25)).toBeCloseTo(0.15625);
    for (const ease of ["linear", "in", "out", "in-out"] as const) {
      expect(easeFraction(ease, 0)).toBe(0);
      expect(easeFraction(ease, 1)).toBe(1);
    }
  });
});

describe("keyedValueAt", () => {
  const keys = [
    { at: 10, value: 1 },
    { at: 20, value: 3, ease: "in" as const },
    { at: 30, value: 0 },
  ];

  it("holds before the first and after the last key", () => {
    expect(keyedValueAt(keys, 0)).toBe(1);
    expect(keyedValueAt(keys, 10)).toBe(1);
    expect(keyedValueAt(keys, 30)).toBe(0);
    expect(keyedValueAt(keys, 99)).toBe(0);
  });

  it("follows the leaving key's ease", () => {
    expect(keyedValueAt(keys, 15)).toBe(2);
    expect(keyedValueAt(keys, 25)).toBeCloseTo(3 - 3 * 0.25);
    expect(keyedValueAt([{ at: 0, value: 0, ease: "in" }, { at: 2, value: 4 }], 1)).toBe(1);
    expect(keyedValueAt([{ at: 0, value: 0, ease: "out" }, { at: 2, value: 4 }], 1)).toBe(3);
  });

  it("is null without keys", () => {
    expect(keyedValueAt(undefined, 1)).toBeNull();
    expect(keyedValueAt([], 1)).toBeNull();
  });
});

describe("placementAt and gainAt", () => {
  const clip = media("a", 100, 20, 40, {
    transform: { x: 50, scale: 2, opacity: 0.5 },
    audio: { gain: -6 },
    keys: { scale: [{ at: 20, value: 1 }, { at: 30, value: 2 }], gain: [{ at: 20, value: -10 }, { at: 30, value: 0 }] },
  });

  it("evaluates keys on the clip's own clock", () => {
    expect(placementAt(clip, 100).scale).toBe(1);
    expect(placementAt(clip, 105).scale).toBe(1.5);
    expect(placementAt(clip, 110).scale).toBe(2);
    expect(placementAt(clip, 115).scale).toBe(2);
    expect(gainAt(clip, 105)).toBe(-5);
  });

  it("counts speed in source seconds", () => {
    const fast = { ...clip, speed: 2 } as Clip;
    expect(placementAt(fast, 105).scale).toBe(2);
    expect(placementAt(fast, 102.5).scale).toBe(1.5);
  });

  it("lets keys replace the static value and keeps it for other properties", () => {
    const placed = placementAt(clip, 105);
    expect(placed).toEqual({ x: 50, y: 0, scale: 1.5, opacity: 0.5 });
    expect(gainAt(media("b", 0, 0, 5, { audio: { gain: -6 } }), 1)).toBe(-6);
    expect(gainAt(media("c", 0, 0, 5), 1)).toBe(0);
    expect(placementAt(media("d", 0, 0, 5), 1)).toEqual({ x: 0, y: 0, scale: 1, opacity: 1 });
  });

  it("uses composition seconds for clips without a source in/out", () => {
    const adapter = { id: "h", type: "hyperframes", start: 10, in: 1, duration: 4, keys: { x: [{ at: 1, value: 0 }, { at: 3, value: 100 }] } } as Clip;
    expect(placementAt(adapter, 11).x).toBe(50);
  });
});

describe("transition weights", () => {
  it("runs a dissolve across 2 * half centered on the start", () => {
    expect(dissolveProgress(10, 0.5, 9.5)).toBe(0);
    expect(dissolveProgress(10, 0.5, 10)).toBe(0.5);
    expect(dissolveProgress(10, 0.5, 11)).toBe(1);
    expect(dissolveProgress(10, 0.5, 5)).toBe(0);
  });

  it("mixes pictures exactly on the bottom track and fades the outgoing one above", () => {
    expect(dissolveWeights(0.25, "bottom")).toEqual({ incoming: 0.25, outgoing: 1 });
    expect(dissolveWeights(0.25, "upper")).toEqual({ incoming: 0.25, outgoing: 0.75 });
  });

  it("crossfades sound with a quarter sine of constant power", () => {
    const { incoming, outgoing } = dissolveWeights(0.5, "sound");
    expect(incoming).toBeCloseTo(Math.SQRT1_2);
    expect(incoming ** 2 + outgoing ** 2).toBeCloseTo(1);
    expect(soundCurve(0)).toBe(0);
    expect(soundCurve(1)).toBe(1);
    expect(soundCurve(2)).toBe(1);
  });

  it("weights fades linearly for pictures and by qsin for sound", () => {
    const edges = { fadeIn: 2, fadeOut: 1 };
    expect(fadeWeight(edges, 0, 10, 1)).toBe(0.5);
    expect(fadeWeight(edges, 0, 10, 5)).toBe(1);
    expect(fadeWeight(edges, 0, 10, 9.5)).toBe(0.5);
    expect(fadeWeight(edges, 0, 10, 1, true)).toBeCloseTo(Math.SQRT1_2);
    expect(fadeWeight({ fadeIn: 0, fadeOut: 0 }, 0, 10, 0)).toBe(1);
  });
});

describe("shapeAt", () => {
  it("eases progress in and out, clamped", () => {
    expect([-1, 0, 0.25, 0.5, 0.75, 1, 2].map(shapeProgress)).toEqual([0, 0, 0.15625, 0.5, 0.84375, 1, 1]);
  });

  it("pushes both pictures one frame in the direction", () => {
    expect(shapeAt({ kind: "push" }, 0)).toEqual({ outgoing: { dx: 0, dy: 0, clip: null }, incoming: { dx: 1, dy: 0, clip: null } });
    expect(shapeAt({ kind: "push", direction: "left" }, 0.5)).toEqual({ outgoing: { dx: -0.5, dy: 0, clip: null }, incoming: { dx: 0.5, dy: 0, clip: null } });
    expect(shapeAt({ kind: "push", direction: "right" }, 0.5)).toEqual({ outgoing: { dx: 0.5, dy: 0, clip: null }, incoming: { dx: -0.5, dy: 0, clip: null } });
    expect(shapeAt({ kind: "push", direction: "up" }, 1)).toEqual({ outgoing: { dx: 0, dy: -1, clip: null }, incoming: { dx: 0, dy: 0, clip: null } });
    expect(shapeAt({ kind: "push", direction: "down" }, 0.25).incoming.dy).toBeCloseTo(-0.84375);
  });

  it("wipes the incoming picture in from the side it enters by", () => {
    expect(shapeAt({ kind: "wipe" }, 0.5)).toEqual({ outgoing: { dx: 0, dy: 0, clip: null }, incoming: { dx: 0, dy: 0, clip: [0.5, 0, 1, 1] } });
    expect(shapeAt({ kind: "wipe", direction: "right" }, 0.25).incoming.clip).toEqual([0, 0, 0.15625, 1]);
    expect(shapeAt({ kind: "wipe", direction: "up" }, 1).incoming.clip).toEqual([0, 0, 1, 1]);
    expect(shapeAt({ kind: "wipe", direction: "down" }, 0).incoming.clip).toEqual([0, 0, 1, 0]);
  });

  it("opens an iris from the centre of its origin until it covers the frame, the outgoing picture still", () => {
    expect(shapeAt({ kind: "iris" }, 0.5)).toEqual({
      outgoing: { dx: 0, dy: 0, clip: null },
      incoming: { dx: 0, dy: 0, clip: null, circle: { cx: 0.5, cy: 0.5, r: 0.5 } },
    });
    const origin: [number, number, number, number] = [0.1, 0.2, 0.3, 0.6];
    expect(shapeAt({ kind: "iris", origin }, 0.25).incoming.circle).toEqual({ cx: 0.2, cy: 0.4, r: 0.15625 });
    expect(shapeAt({ kind: "iris", origin }, 0).incoming.circle!.r).toBe(0);
    expect(shapeAt({ kind: "iris", origin }, 1).incoming.circle!.r).toBe(1);
  });

  it("measures a circle's reach to the farthest frame corner, in pixels", () => {
    expect(circleReach({ cx: 0.5, cy: 0.5 }, 1920, 1080)).toBeCloseTo(Math.hypot(960, 540));
    expect(circleReach({ cx: 0.25, cy: 1 }, 100, 50)).toBeCloseTo(Math.hypot(75, 50));
    expect(irisCentre({ kind: "iris" })).toEqual([0.5, 0.5]);
  });
});

describe("zoom, slats and grid shapes (ADR 0030 slice 4)", () => {
  it("zooms the outgoing picture about the centre of its origin and grows the incoming one out of it", () => {
    const origin: [number, number, number, number] = [0.6, 0.2, 0.8, 0.4];
    expect(zoomFactor({ kind: "zoom", origin })).toBe(4);
    const start = shapeAt({ kind: "zoom", origin }, 0);
    expect(start.outgoing.zoom).toEqual({ s: 1, tx: 0, ty: 0 });
    expect(start.incoming.zoom).toEqual({ s: 0, tx: expect.closeTo(0.7), ty: expect.closeTo(0.3) });
    const half = shapeAt({ kind: "zoom", origin }, 0.5);
    expect(half.outgoing.zoom!.s).toBeCloseTo(2.5);
    expect(half.incoming.zoom!.s).toBeCloseTo(0.5);
    // The pivot stays where it is.
    for (const part of [half.outgoing, half.incoming]) {
      const { s, tx, ty } = part.zoom!;
      expect([s * 0.7 + tx, s * 0.3 + ty]).toEqual([expect.closeTo(0.7), expect.closeTo(0.3)]);
    }
    const end = shapeAt({ kind: "zoom", origin }, 1);
    expect(end.outgoing.zoom!.s).toBeCloseTo(4);
    expect(end.incoming.zoom).toEqual({ s: 1, tx: 0, ty: 0 });
  });

  it("sizes a zoom by the larger side of its origin, from 1 to 4, the middle half by default", () => {
    expect(zoomFactor({ kind: "zoom" })).toBe(2);
    expect(zoomFactor({ kind: "zoom", origin: [0, 0, 0.5, 0.25] })).toBe(2);
    expect(zoomFactor({ kind: "zoom", origin: [0.5, 0.5, 0.5, 0.5] })).toBe(4);
    expect(zoomFactor({ kind: "zoom", origin: [0, 0, 1, 1] })).toBe(1);
    expect(shapeAt({ kind: "zoom" }, 1).outgoing.zoom!.s).toBe(2);
  });

  it("opens slats in each strip from the edge the incoming picture enters by", () => {
    expect(shapeAt({ kind: "slats" }, 0.5).incoming.slats).toEqual({ count: 8, axis: "x", from: "end", r: 0.5 });
    expect(shapeAt({ kind: "slats", direction: "right", count: 4 }, 1).incoming.slats).toEqual({ count: 4, axis: "x", from: "start", r: 1 });
    expect(shapeAt({ kind: "slats", direction: "up" }, 0).incoming.slats).toMatchObject({ axis: "y", from: "end", r: 0 });
    expect(shapeAt({ kind: "slats", direction: "down" }, 0).incoming.slats).toMatchObject({ axis: "y", from: "start" });
    expect(slatRects({ count: 2, axis: "x", from: "end", r: 0.5 })).toEqual([[0.25, 0, 0.5, 1], [0.75, 0, 1, 1]]);
    expect(slatRects({ count: 2, axis: "y", from: "start", r: 0.5 })).toEqual([[0, 0, 1, 0.25], [0, 0.5, 1, 0.75]]);
  });

  it("switches grid cells on in a fixed scattered order, none at the start and all at the end", () => {
    expect(shapeAt({ kind: "grid" }, 0.5).incoming.grid).toEqual({ count: 12, r: 0.5 });
    expect(shapeAt({ kind: "grid", count: 20 }, 0).incoming.grid).toEqual({ count: 20, r: 0 });
    expect(gridRows(16, 1920, 1080)).toBe(9);
    expect(gridRows(12, 1080, 1920)).toBe(21);
    const ranks = new Set<number>();
    for (let row = 0; row < 9; row++) for (let column = 0; column < 16; column++) ranks.add(gridRank(column, row));
    expect(ranks.size).toBeGreaterThan(100);
    expect([...ranks].every((rank) => Number.isInteger(rank) && rank >= 0 && rank < GRID_RANKS)).toBe(true);
    expect(gridRank(3, 2)).toBe(gridRank(3, 2));
  });

  it("takes the fields each new kind has and refuses the others", () => {
    const base = { id: "c_1", type: "media", asset: "assets/a.mp4", start: 0, in: 0, out: 5, dissolve: 0.5 };
    const shaped = (shape: unknown) => parseTimeline({ ...createTimeline("main"), tracks: [{ id: "t_1", kind: "video", clips: [{ ...base, shape }] }] });
    for (const shape of [{ kind: "zoom" }, { kind: "zoom", origin: [0.2, 0.2, 0.4, 0.4] }, { kind: "slats", direction: "down", count: 5 }, { kind: "grid", count: 24 }, { kind: "grid" }]) {
      expect(shaped(shape).ok, JSON.stringify(shape)).toBe(true);
    }
    for (const shape of [
      { kind: "zoom", direction: "left" },
      { kind: "slats", origin: [0, 0, 1, 1] },
      { kind: "grid", direction: "up" },
      { kind: "wipe", count: 4 },
      { kind: "slats", count: 1 },
      { kind: "slats", count: 65 },
      { kind: "grid", count: 2.5 },
      { kind: "zoom", origin: [0.6, 0, 0.4, 1] },
    ]) {
      expect(shaped(shape).ok, JSON.stringify(shape)).toBe(false);
    }
  });
});

describe("clip transition fields (timeline model)", () => {
  const timeline = (clips: unknown[], kind = "video") => ({ ...createTimeline("main"), tracks: [{ id: "t_1", kind, clips }] });
  const base = { id: "c_1", type: "media", asset: "assets/a.mp4", start: 0, in: 0, out: 5 };

  it("accepts the new fields", () => {
    const keys = { scale: [{ at: 0, value: 1 }, { at: 2, value: 1.2, ease: "in-out" }], gain: [{ at: 0, value: -3 }] };
    expect(parseTimeline(timeline([{ ...base, dissolve: 0.5, fadeIn: 1, fadeOut: 1, keys }])).ok).toBe(true);
  });

  it("validates timelines without them unchanged", () => {
    const result = parseTimeline(timeline([{ ...base, transform: { scale: 2 }, audio: { gain: -3 } }]));
    expect(result).toEqual({ ok: true, value: expect.objectContaining({ tracks: [expect.objectContaining({ clips: [{ ...base, transform: { scale: 2 }, audio: { gain: -3 } }] })] }) });
  });

  it("refuses non-positive lengths and unknown eases", () => {
    expect(parseTimeline(timeline([{ ...base, dissolve: 0 }])).ok).toBe(false);
    expect(parseTimeline(timeline([{ ...base, fadeIn: -1 }])).ok).toBe(false);
    expect(parseTimeline(timeline([{ ...base, keys: { x: [{ at: 0, value: 1, ease: "bounce" }] } }])).ok).toBe(false);
  });

  it("refuses keys that are not strictly increasing", () => {
    for (const x of [[{ at: 2, value: 0 }, { at: 1, value: 0 }], [{ at: 1, value: 0 }, { at: 1, value: 5 }]]) {
      const result = parseTimeline(timeline([{ ...base, keys: { x } }]));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("sorted by `at`");
    }
  });

  it("lets audio tracks key only gain", () => {
    expect(parseTimeline(timeline([{ ...base, keys: { gain: [{ at: 0, value: -3 }] } }], "audio")).ok).toBe(true);
    const result = parseTimeline(timeline([{ ...base, keys: { opacity: [{ at: 0, value: 1 }] } }], "audio"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("only `gain` keys");
  });

  it("accepts a shape on a dissolve and refuses one without it or on an audio track", () => {
    expect(parseTimeline(timeline([{ ...base, dissolve: 0.5, shape: { kind: "push", direction: "up" } }])).ok).toBe(true);
    expect(parseTimeline(timeline([{ ...base, dissolve: 0.5, shape: { kind: "wipe" } }])).ok).toBe(true);
    const bare = parseTimeline(timeline([{ ...base, shape: { kind: "wipe" } }]));
    expect(bare.ok).toBe(false);
    if (!bare.ok) expect(bare.error).toContain("give the clip a `dissolve` too");
    const audio = parseTimeline(timeline([{ ...base, dissolve: 0.5, shape: { kind: "wipe" } }], "audio"));
    expect(audio.ok).toBe(false);
    if (!audio.ok) expect(audio.error).toContain("no picture to shape");
    expect(parseTimeline(timeline([{ ...base, dissolve: 0.5, shape: { kind: "spiral" } }])).ok).toBe(false);
    expect(parseTimeline(timeline([{ ...base, dissolve: 0.5, shape: { kind: "push", direction: "diagonal" } }])).ok).toBe(false);
  });

  it("takes an iris with an ordered origin in frame fractions, and no direction", () => {
    const shaped = (shape: unknown) => parseTimeline(timeline([{ ...base, dissolve: 0.5, shape }]));
    expect(shaped({ kind: "iris" }).ok).toBe(true);
    expect(shaped({ kind: "iris", origin: [0.1, 0.2, 0.3, 0.4] }).ok).toBe(true);
    expect(shaped({ kind: "iris", origin: [0.5, 0.5, 0.5, 0.5] }).ok).toBe(true);
    const refused = (shape: unknown, message: string) => {
      const result = shaped(shape);
      expect(result.ok, JSON.stringify(shape)).toBe(false);
      if (!result.ok) expect(result.error).toContain(message);
    };
    refused({ kind: "iris", direction: "left" }, "`direction` is for wipe, push, slats; `iris` does not take it");
    refused({ kind: "wipe", origin: [0, 0, 1, 1] }, "`origin` is for iris, zoom; `wipe` does not take it");
    refused({ kind: "iris", origin: [0.6, 0, 0.4, 1] }, "x0 <= x1");
    expect(shaped({ kind: "iris", origin: [0, 0, 1.2, 1] }).ok).toBe(false);
    expect(shaped({ kind: "iris", origin: [0, 0, 1] }).ok).toBe(false);
  });

  it("gives shots no transition fields", () => {
    const shot = { id: "c_1", type: "shot", start: 0, in: 0, out: 5, shot: "solo", angles: ["ana"], dissolve: 1 };
    const result = parseTimeline({
      ...createTimeline("main"),
      groups: [{ id: "g_1", angles: [{ id: "ana", name: "Ana", asset: "assets/ana.mp4", offset: 0 }] }],
      tracks: [{ id: "t_p", kind: "program", group: "g_1", clips: [shot] }],
    });
    expect(result.ok).toBe(false);
  });
});
