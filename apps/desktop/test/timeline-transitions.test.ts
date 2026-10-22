import type { TimelineView } from "@frameshell/protocol";
import { describe, expect, it } from "vitest";
import { editLabel } from "../src/main/timeline-editor.js";
import { operationTitle } from "../src/renderer/src/history/model.js";
import { RULER_HEIGHT, layoutTimeline } from "../src/renderer/src/timeline/layout.js";
import { DEFAULT_THEME, type MediaLookup, type Paint2D, paintTimeline } from "../src/renderer/src/timeline/paint.js";
import { edgeAt, edgeState, keyAt, keyBoxes, keyTimelineTime, keyTimes, clipClock } from "../src/renderer/src/timeline/transitions.js";

// Seam under test: what the timeline shows of transitions and keys (ADR 0018 decision 12), fed `timeline.show` results.

type Track = TimelineView["tracks"][number];

const view = (tracks: Track[]): TimelineView => ({ timeline: "main", path: "timelines/main.json", revision: 1, fps: 30, duration: null, tracks, problems: [] });
const clip = (id: string, start: number, inS: number, out: number, extra: Record<string, unknown> = {}) => ({
  id,
  type: "media",
  asset: "assets/a.mp4",
  start,
  in: inS,
  out,
  end: start + (out - inS) / ((extra["speed"] as number | undefined) ?? 1),
  ...extra,
});
const video = (clips: Track["clips"]): Track => ({ id: "t_v", kind: "video", name: null, follows: null, clips });
const plenty = { sourceDuration: () => 600 };

describe("transition marks", () => {
  it("marks a dissolve straddling the cut at half its length each side", () => {
    const layout = layoutTimeline(view([video([clip("a", 0, 10, 12), clip("b", 2, 20, 23, { dissolve: 1 })])]), [], undefined, plenty);
    const [, b] = layout.rows[0]!.clips;
    expect(b!.marks).toEqual([{ kind: "dissolve", side: "in", from: 1.5, to: 2.5 }]);
  });

  it("marks fades inside their clip, a lone edge included", () => {
    const layout = layoutTimeline(view([video([clip("a", 0, 10, 14, { fadeIn: 0.5, fadeOut: 1 })])]), [], undefined, plenty);
    expect(layout.rows[0]!.clips[0]!.marks).toEqual([
      { kind: "fade", side: "in", from: 0, to: 0.5 },
      { kind: "fade", side: "out", from: 3, to: 4 },
    ]);
  });

  it("sizes a dissolve by the material the clips have: without handles it reads as a dip of two fades", () => {
    const tight = layoutTimeline(view([video([clip("a", 0, 0, 2), clip("b", 2, 0, 2, { dissolve: 1 })])]), [], undefined, { sourceDuration: () => 2 });
    const [a, b] = tight.rows[0]!.clips;
    expect(a!.marks).toEqual([{ kind: "fade", side: "out", from: 1.5, to: 2 }]);
    expect(b!.marks).toEqual([{ kind: "fade", side: "in", from: 2, to: 2.5 }]);
  });

  it("has no marks without transitions, and keeps the stored fields", () => {
    const plain = layoutTimeline(view([video([clip("a", 0, 0, 2)])]));
    expect(plain.rows[0]!.clips[0]).toMatchObject({ marks: [], keys: {}, dissolve: null, fadeIn: null, fadeOut: null });
    const set = layoutTimeline(view([video([clip("a", 0, 0, 2, { fadeIn: 0.4 })])]), [], undefined, plenty);
    expect(set.rows[0]!.clips[0]).toMatchObject({ fadeIn: 0.4, dissolve: null });
  });
});

describe("keys", () => {
  const keys = { x: [{ at: 11, value: -100 }, { at: 12, value: 100, ease: "in-out" }], opacity: [{ at: 12, value: 0 }], bogus: [{ at: 1 }] };

  it("reads stored keys per property and ignores what is not a key", () => {
    expect(keyBoxes(keys)).toEqual({
      x: [
        { at: 11, value: -100, ease: undefined },
        { at: 12, value: 100, ease: "in-out" },
      ],
      opacity: [{ at: 12, value: 0, ease: undefined }],
    });
    expect(keyBoxes(undefined)).toEqual({});
  });

  it("converts between the clip's clock and the timeline, with speed", () => {
    const sped = { start: 4, in: 10, speed: 2 };
    expect(keyTimelineTime(sped, 12)).toBe(5);
    expect(clipClock(sped, 5)).toBe(12);
    expect(clipClock(sped, keyTimelineTime(sped, 13.5))).toBeCloseTo(13.5, 9);
  });

  it("lists one diamond time per distinct moment, inside the clip", () => {
    const layout = layoutTimeline(view([video([clip("a", 5, 10, 14, { keys: { ...keys, scale: [{ at: 99, value: 2 }] } })])]));
    // x at 11 and 12 -> 6 and 7 s; opacity at 12 shares 7 s; scale at 99 is far outside the clip.
    expect(keyTimes(layout.rows[0]!.clips[0]!)).toEqual([6, 7]);
  });

  it("finds the key at the playhead within half a frame", () => {
    const layout = layoutTimeline(view([video([clip("a", 5, 10, 14, { keys })])]));
    const box = layout.rows[0]!.clips[0]!;
    expect(keyAt(box, box.keys.x, 7, 30)?.value).toBe(100);
    expect(keyAt(box, box.keys.x, 7.01, 30)?.value).toBe(100);
    expect(keyAt(box, box.keys.x, 7.1, 30)).toBeNull();
    expect(keyAt(box, undefined, 7, 30)).toBeNull();
  });
});

describe("edges", () => {
  const layout = layoutTimeline(view([video([clip("a", 0, 10, 12, { fadeOut: 0.5 }), clip("b", 2, 20, 23, { dissolve: 1 }), clip("c", 6, 0, 2)])]), [], undefined, plenty);
  const [a, b, c] = layout.rows[0]!.clips;
  const row = layout.rows[0]!;

  it("reads the stored transition of a clip's start and end edge, a cut's dissolve from the clip coming in", () => {
    expect(edgeState(row, b!, "in")).toEqual({ at: 2, kind: "dissolve", length: 1, butted: true });
    expect(edgeState(row, a!, "out")).toEqual({ at: 2, kind: "dissolve", length: 1, butted: true });
    expect(edgeState(row, a!, "in")).toEqual({ at: 0, kind: null, length: 0, butted: false });
    expect(edgeState(row, b!, "out")).toEqual({ at: 5, kind: null, length: 0, butted: false });
    expect(edgeState(row, c!, "in")).toMatchObject({ kind: null, butted: false });
  });

  it("counts a fade at a cut as both halves", () => {
    const cut = layoutTimeline(view([video([clip("a", 0, 0, 2, { fadeOut: 0.25 }), clip("b", 2, 0, 2, { fadeIn: 0.25 })])]), [], undefined, plenty);
    const [first, second] = cut.rows[0]!.clips;
    expect(edgeState(cut.rows[0]!, first!, "out")).toMatchObject({ kind: "fade", length: 0.5 });
    expect(edgeState(cut.rows[0]!, second!, "in")).toMatchObject({ kind: "fade", length: 0.5 });
  });

  it("finds the edge near a point of a video lane and says whether it holds a transition", () => {
    const viewport = { pxPerSecond: 100, scrollLeft: 0, scrollTop: 0 };
    const y = row.top + 10;
    // The cut at 2 s is at 200 px.
    expect(edgeAt(layout, viewport, 203, y)).toMatchObject({ at: 2, hasTransition: true });
    expect(edgeAt(layout, viewport, 150, y)).toBeNull();
    // c starts at 6 s with nothing there.
    expect(edgeAt(layout, viewport, 600, y)).toMatchObject({ at: 6, hasTransition: false });
    expect(edgeAt(layout, viewport, 203, RULER_HEIGHT - 5)).toBeNull();
  });

  it("offers no edge on subtitle or program lanes", () => {
    const program: Track = { id: "t_p", kind: "program", name: null, follows: null, group: "g", clips: [{ id: "s", type: "shot", start: 0, end: 2, in: 0, out: 2, shot: "solo", angles: ["x"] }] as Track["clips"] };
    const lanes = layoutTimeline(view([program]));
    expect(edgeAt(lanes, { pxPerSecond: 100, scrollLeft: 0, scrollTop: 0 }, 1, lanes.rows[0]!.top + 5)).toBeNull();
  });
});

describe("painting", () => {
  const noMedia: MediaLookup<string> = { waveform: () => null, thumbnails: () => null };

  /** Counts path fills: a diamond is one, a fade wedge one, a dissolve band one. */
  function fills(layoutView: TimelineView): number {
    let count = 0;
    const noop = () => {};
    const ctx = {
      fillStyle: "",
      strokeStyle: "",
      lineWidth: 1,
      globalAlpha: 1,
      font: "",
      textBaseline: "alphabetic",
      textAlign: "start",
      save: noop,
      restore: noop,
      beginPath: noop,
      closePath: noop,
      moveTo: noop,
      lineTo: noop,
      rect: noop,
      clip: noop,
      fill: () => void count++,
      stroke: noop,
      setLineDash: noop,
      clearRect: noop,
      strokeRect: noop,
      fillRect: noop,
      fillText: noop,
      measureText: (text: string) => ({ width: text.length * 6 }),
      drawImage: noop,
    } as unknown as Paint2D<string>;
    const layout = layoutTimeline(layoutView, [], undefined, plenty);
    paintTimeline(ctx, { layout, viewport: { pxPerSecond: 60, scrollLeft: 0, scrollTop: 0, width: 600, height: 200 }, fps: 30, playhead: 0, theme: DEFAULT_THEME, media: noMedia });
    return count;
  }

  it("draws diamonds, a dissolve band and fade wedges only where the file has them", () => {
    const plain = fills(view([video([clip("a", 0, 10, 12), clip("b", 2, 20, 23)])]));
    const keyed = fills(view([video([clip("a", 0, 10, 12, { keys: { x: [{ at: 11, value: 1 }, { at: 12, value: 2 }] } }), clip("b", 2, 20, 23)])]));
    expect(keyed - plain).toBe(2);
    const dissolved = fills(view([video([clip("a", 0, 10, 12), clip("b", 2, 20, 23, { dissolve: 1 })])]));
    expect(dissolved - plain).toBe(1);
    const faded = fills(view([video([clip("a", 0, 10, 12, { fadeOut: 0.5 }), clip("b", 2, 20, 23, { fadeIn: 0.5 })])]));
    expect(faded - plain).toBe(2);
  });
});

describe("the app's edit labels", () => {
  it("names transition and keyframe operations", () => {
    expect(editLabel([{ op: "transition.set", args: { at: 2 } }])).toBe("Add transition");
    expect(editLabel([{ op: "transition.remove", args: { at: 2 } }])).toBe("Remove transition");
    expect(editLabel([{ op: "clip.key", args: { clip: "c_a", prop: "x", time: 1 } }])).toBe("Edit keyframe");
  });

  it("shows the history panel friendly verbs", () => {
    expect(operationTitle({ op: "transition.set", args: {} })).toBe("Set transition");
    expect(operationTitle({ op: "transition.remove", args: {} })).toBe("Remove transition");
    expect(operationTitle({ op: "clip.key", args: {} })).toBe("Keyframe");
  });
});
