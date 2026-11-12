import type { TimelineView } from "@frameshell/protocol";
import { describe, expect, it } from "vitest";
import { type Grab, dragEdits, dragPreview, grabAt, snapPoints } from "../src/renderer/src/timeline/edit.js";
import { LANE_HEIGHT, layoutTimeline } from "../src/renderer/src/timeline/layout.js";
import { DEFAULT_THEME, type Paint2D, paintTimeline } from "../src/renderer/src/timeline/paint.js";

// Seam under test: the beat grid (ADR 0029 slice 3) in the panel's pure geometry, drag snapping and painter.

const titles = (id: string, start: number, end: number) => ({ id, type: "titles", start, end, duration: end - start });

/** 120 BPM from 0.5 s: a beat every 0.5 s, a bar (4 beats) every 2 s, over 12 s. */
const beats = Array.from({ length: 24 }, (_, index) => 0.5 + index * 0.5);
const bars = beats.filter((_, index) => index % 4 === 0);

function view(overrides: Partial<TimelineView> = {}): TimelineView {
  return {
    timeline: "main",
    path: "timelines/main.json",
    revision: 1,
    fps: 30,
    duration: 12,
    problems: [],
    tracks: [{ id: "v1", kind: "video", name: null, follows: null, clips: [titles("c_a", 0, 3), titles("c_b", 3, 8.25)] }],
    tempo: { bpm: 120, offset: 0.5 },
    grid: { source: "nominal", bpm: 120, meter: 4, low: false, beats, bars, beatBase: 0, barBase: 0 },
    ...overrides,
  };
}

const viewport = { pxPerSecond: 40, scrollLeft: 0, scrollTop: 0 };

describe("grid layout", () => {
  it("carries the beats and bars of the view's grid, and none without a grid or with an empty one", () => {
    expect(layoutTimeline(view()).grid).toEqual({ beats, bars, bpm: 120, meter: 4, low: false });
    expect(layoutTimeline(view({ grid: undefined })).grid).toBeNull();
    expect(layoutTimeline(view({ grid: { source: "nominal", bpm: 120, meter: 4, low: false, beats: [], bars: [], beatBase: 0, barBase: 0 } })).grid).toBeNull();
  });

  it("does not move the lanes: the grid has no lane of its own", () => {
    expect(layoutTimeline(view()).head).toBe(layoutTimeline(view({ grid: undefined })).head);
  });
});

describe("snapping to beats and bars", () => {
  const layout = layoutTimeline(view());
  const Y = layout.rows[0]!.top + LANE_HEIGHT.video / 2;
  const grab = (x: number): Grab => grabAt(layout, viewport, x, Y)!;

  it("lists every beat as a snap target and every bar start as a bar, once", () => {
    const points = snapPoints(layout, 30, new Set(["c_b"]));
    expect(points.filter((point) => point.kind === "bar").map((point) => point.time)).toEqual(bars);
    expect(points.filter((point) => point.kind === "beat").map((point) => point.time)).toEqual(beats.filter((time) => !bars.includes(time)));
    expect(new Set(points.filter((point) => point.kind === "bar" || point.kind === "beat").map((point) => point.time)).size).toBe(beats.length);
  });

  it("offers no beat to snap to while the grid is LOW confidence", () => {
    const low = layoutTimeline(view({ grid: { source: "beats", bpm: 120, meter: 4, low: true, confidence: 0.3, beats, bars, beatBase: 0, barBase: 0 } }));
    expect(snapPoints(low, 30, new Set()).some((point) => point.kind === "beat" || point.kind === "bar")).toBe(false);
  });

  it("leaves out a grid that rides on a dragged clip: its beats move with it", () => {
    const riding = layoutTimeline(view({ grid: { source: "beats", clip: "c_b", bpm: 120, meter: 4, low: false, beats, bars, beatBase: 0, barBase: 0 } }));
    expect(snapPoints(riding, 30, new Set(["c_b"])).some((point) => point.kind === "beat" || point.kind === "bar")).toBe(false);
    expect(snapPoints(riding, 30, new Set(["c_a"])).some((point) => point.kind === "beat")).toBe(true);
  });

  it("moves a dragged clip's start onto the nearest beat, and puts a trimmed edge on a bar exactly", () => {
    const snap = { points: snapPoints(layout, 30, new Set(["c_b"])), tolerance: 0.2 };
    // c_b plays 3–8.25: a start dragged to 3.9 lands on the beat at 4; the end (9.15) is farther from a beat (9).
    const moved = dragPreview({ layout, grab: grab(200), delta: 0.9, y: Y, fps: 30, snap });
    expect(moved).toMatchObject({ start: 4, snapped: { kind: "beat", time: 4 } });
    expect(dragEdits(moved)).toEqual([{ op: "clip.move", args: { clip: "c_b", start: 4 } }]);
    // The tail at 8.25 dragged to 8.4 → the bar start at 8.5 (bar 0.5 + 2k).
    const trimmed = dragPreview({ layout, grab: grab(329), delta: 0.15, y: Y, fps: 30, snap });
    expect(trimmed).toMatchObject({ part: "tail", end: 8.5, snapped: { kind: "bar" } });
    expect(dragEdits(trimmed)).toEqual([{ op: "clip.trim", args: { clip: "c_b", end: 8.5, snap: false } }]);
  });

  it("prefers a clip edge, marker or the playhead in reach over a beat", () => {
    // The playhead at 4.55 is 0.05 from the dragged start (4.6) while the beat at 4.5 is 0.1 away: the playhead wins.
    const snap = { points: snapPoints(layout, 4.55, new Set(["c_b"])), tolerance: 0.2 };
    const moved = dragPreview({ layout, grab: grab(200), delta: 1.6, y: Y, fps: 30, snap });
    expect(moved.snapped).toEqual({ time: 4.55, kind: "playhead" });
    // Even when the beat is closer: the edge in reach still wins.
    const marked = layoutTimeline(view({ markers: [{ id: "m_a", at: 4.64, label: "hook" }] }));
    const near = { points: snapPoints(marked, 30, new Set(["c_b"])), tolerance: 0.2 };
    const markedY = marked.rows[0]!.top + LANE_HEIGHT.video / 2;
    const toMarker = dragPreview({ layout: marked, grab: grabAt(marked, viewport, 200, markedY)!, delta: 1.6, y: markedY, fps: 30, snap: near });
    expect(toMarker.snapped).toMatchObject({ kind: "marker", label: "hook" });
  });
});

describe("grid paint", () => {
  /** What a frame draws: the fillRect calls with their alpha, and the order they come in. */
  function paint(layout: ReturnType<typeof layoutTimeline>, pxPerSecond: number) {
    const rects: { x: number; y: number; w: number; h: number; alpha: number; fill: unknown }[] = [];
    let alpha = 1;
    let fill: unknown = "";
    const ctx = new Proxy({} as Paint2D<unknown>, {
      get: (_target, key) => {
        if (key === "fillRect") return (x: number, y: number, w: number, h: number) => rects.push({ x, y, w, h, alpha, fill });
        if (key === "measureText") return () => ({ width: 10 });
        if (key === "globalAlpha") return alpha;
        return () => {};
      },
      set: (_target, key, value) => {
        if (key === "globalAlpha") alpha = value as number;
        if (key === "fillStyle") fill = value;
        return true;
      },
    });
    paintTimeline(ctx, {
      layout,
      viewport: { pxPerSecond, scrollLeft: 0, scrollTop: 0, width: 600, height: 160 },
      fps: 30,
      playhead: 0,
      theme: DEFAULT_THEME,
      media: { waveform: () => null, thumbnails: () => null },
    });
    return rects;
  }

  it("draws a faint line per beat and a stronger one per bar down the lanes, and ticks on the ruler", () => {
    const layout = layoutTimeline(view());
    const rects = paint(layout, 40);
    const lines = rects.filter((rect) => rect.fill === DEFAULT_THEME.textMuted && rect.w === 1 && rect.h > 50);
    const beatLines = lines.filter((rect) => rect.alpha < 0.1);
    const barLines = lines.filter((rect) => rect.alpha >= 0.1);
    // 600 px at 40 px/s shows 15 s: every beat of the 12 s grid, the bar starts among them.
    expect(barLines.map((rect) => rect.x / 40)).toEqual(bars);
    expect(beatLines.map((rect) => rect.x / 40)).toEqual(beats.filter((time) => !bars.includes(time)));
    expect(Math.max(...barLines.map((rect) => rect.alpha))).toBeGreaterThan(Math.max(...beatLines.map((rect) => rect.alpha)));
    const ticks = rects.filter((rect) => rect.fill === DEFAULT_THEME.accent && rect.y > 10 && rect.y < 22 && rect.w === 1);
    expect(ticks.filter((rect) => rect.h === 8)).toHaveLength(bars.length);
    expect(ticks.filter((rect) => rect.h === 3)).toHaveLength(beats.length - bars.length);
    expect(Math.min(...lines.map((rect) => rect.y))).toBe(layout.head);
  });

  it("leaves out the level that is too dense to read: bars only when the beats crowd, nothing when the bars do", () => {
    const layout = layoutTimeline(view());
    // 8 px/s: a beat is 4 px apart (too dense), a bar 16 px.
    const crowded = paint(layout, 8).filter((rect) => rect.fill === DEFAULT_THEME.textMuted && rect.w === 1 && rect.h > 50);
    expect(crowded.map((rect) => rect.x / 8)).toEqual(bars);
    // 2 px/s: even a bar (4 px) is too dense.
    expect(paint(layout, 2).filter((rect) => rect.fill === DEFAULT_THEME.textMuted && rect.w === 1 && rect.h > 50)).toEqual([]);
  });

  it("draws nothing for a timeline without a grid", () => {
    const rects = paint(layoutTimeline(view({ grid: undefined })), 40);
    expect(rects.filter((rect) => rect.fill === DEFAULT_THEME.textMuted && rect.w === 1 && rect.h > 50)).toEqual([]);
  });
});
