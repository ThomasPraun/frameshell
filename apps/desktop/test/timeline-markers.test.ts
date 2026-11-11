import type { TimelineView } from "@frameshell/protocol";
import { describe, expect, it } from "vitest";
import { type Grab, dragEdits, dragPreview, grabAt, snapPoints } from "../src/renderer/src/timeline/edit.js";
import {
  LANE_HEIGHT,
  MARKER_LANE_HEIGHT,
  RULER_HEIGHT,
  SCENE_BAND_HEIGHT,
  clipAt,
  layoutTimeline,
  markerAt,
  onMarkerLane,
  sceneAt,
} from "../src/renderer/src/timeline/layout.js";
import { DEFAULT_THEME, type Paint2D, paintTimeline } from "../src/renderer/src/timeline/paint.js";

// Seam under test: the marker lane (ADR 0029) in the panel's pure geometry, drag snapping and painter.

const titles = (id: string, start: number, end: number) => ({ id, type: "titles", start, end, duration: end - start });
const markers = [
  { id: "m_b", at: 12, label: "hook", color: "red" as const },
  { id: "m_a", at: 3, label: "intro" },
];

function view(overrides: Partial<TimelineView> = {}): TimelineView {
  return {
    timeline: "main",
    path: "timelines/main.json",
    revision: 1,
    fps: 30,
    duration: 22,
    problems: [],
    tracks: [{ id: "v1", kind: "video", name: null, follows: null, clips: [titles("c_a", 0, 4), titles("c_b", 4, 10)] }],
    markers,
    ...overrides,
  };
}

const viewport = { pxPerSecond: 10, scrollLeft: 0, scrollTop: 0 };
const scenes = [{ script: "scripts/plan.md", slug: "intro", title: "Intro", start: 1, end: 4, clips: [] }];

describe("marker lane layout", () => {
  it("adds the lane under the ruler only while there are markers, then the scene band under it", () => {
    expect(layoutTimeline(view({ markers: undefined }))).toMatchObject({ markers: [], sceneTop: RULER_HEIGHT, head: RULER_HEIGHT });
    const marked = layoutTimeline(view());
    expect(marked.markers).toEqual([
      { id: "m_b", at: 12, label: "hook", color: "red" },
      { id: "m_a", at: 3, label: "intro", color: null },
    ]);
    expect(marked.sceneTop).toBe(RULER_HEIGHT + MARKER_LANE_HEIGHT);
    expect(marked.rows[0]!.top).toBe(RULER_HEIGHT + MARKER_LANE_HEIGHT);
    const both = layoutTimeline(view(), scenes);
    expect(both.head).toBe(RULER_HEIGHT + MARKER_LANE_HEIGHT + SCENE_BAND_HEIGHT);
    expect(both.height).toBe(both.head + LANE_HEIGHT.video);
  });

  it("finds the marker within a few px on the ruler and the lane, and keeps the scene band and lanes below it", () => {
    const layout = layoutTimeline(view(), scenes);
    const onLane = RULER_HEIGHT + 4;
    expect(onMarkerLane(layout, onLane)).toBe(true);
    expect(onMarkerLane(layout, RULER_HEIGHT - 1)).toBe(false);
    expect(onMarkerLane(layout, layout.sceneTop)).toBe(false);
    expect(markerAt(layout, viewport, 124, onLane)?.id).toBe("m_b");
    expect(markerAt(layout, viewport, 28, 5)?.id).toBe("m_a");
    expect(markerAt(layout, viewport, 40, onLane)).toBeNull();
    expect(markerAt(layout, { ...viewport, scrollLeft: 100 }, 20, onLane)?.id).toBe("m_b");
    expect(markerAt(layout, viewport, 30, layout.sceneTop)).toBeNull();
    // The scene band starts under the marker lane.
    expect(sceneAt(layout, viewport, 25, onLane)).toBeNull();
    expect(sceneAt(layout, viewport, 25, layout.sceneTop + 2)?.slug).toBe("intro");
    expect(clipAt(layout, viewport, 25, onLane)).toBeNull();
  });
});

describe("snapping to markers", () => {
  const layout = layoutTimeline(view());
  const Y = layout.rows[0]!.top + LANE_HEIGHT.video / 2;
  const grab = (x: number): Grab => grabAt(layout, viewport, x, Y)!;
  const snap = { points: snapPoints(layout, 30, new Set(["c_b"])), tolerance: 0.5 };

  it("lists every marker as a snap target with its label", () => {
    expect(snap.points.filter((point) => point.kind === "marker")).toEqual([
      { time: 3, kind: "marker", label: "intro" },
      { time: 12, kind: "marker", label: "hook" },
    ]);
  });

  it("moves a dragged clip's edge onto a marker, and puts a trimmed edge on it exactly", () => {
    const moved = dragPreview({ layout, grab: grab(70), delta: 1.8, y: Y, fps: 30, snap });
    expect(moved).toMatchObject({ start: 6, end: 12, snapped: { kind: "marker", label: "hook" } });
    expect(dragEdits(moved)).toEqual([{ op: "clip.move", args: { clip: "c_b", start: 6 } }]);
    const trimmed = dragPreview({ layout, grab: grab(99), delta: 2.2, y: Y, fps: 30, snap });
    expect(trimmed).toMatchObject({ part: "tail", end: 12, snapped: { kind: "marker" } });
    expect(dragEdits(trimmed)).toEqual([{ op: "clip.trim", args: { clip: "c_b", end: 12, snap: false } }]);
  });
});

describe("marker lane paint", () => {
  it("draws each marker's label, in a frame the canvas can fit", () => {
    const texts: string[] = [];
    const ctx = new Proxy({} as Paint2D<unknown>, {
      get: (_target, key) => (key === "fillText" ? (text: string) => texts.push(text) : key === "measureText" ? () => ({ width: 10 }) : () => {}),
      set: () => true,
    });
    const layout = layoutTimeline(view());
    paintTimeline(ctx, {
      layout,
      viewport: { ...viewport, width: 400, height: 120 },
      fps: 30,
      playhead: 0,
      theme: DEFAULT_THEME,
      media: { waveform: () => null, thumbnails: () => null },
    });
    expect(texts).toEqual(expect.arrayContaining(["intro", "hook"]));
  });
});
