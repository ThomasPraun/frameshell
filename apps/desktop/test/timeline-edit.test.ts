import type { TimelineView } from "@frameshell/protocol";
import { describe, expect, it } from "vitest";
import { type Grab, commandEdits, commandOptions, dragEdits, dragPreview, grabAt, historyShortcut, snapPoints, withStarts } from "../src/renderer/src/timeline/edit.js";
import { layoutTimeline } from "../src/renderer/src/timeline/layout.js";

// Seam under test: the timeline panel's pure editing logic. Pointer and keys in, ghost and daemon edits out.

const titles = (id: string, start: number, end: number) => ({ id, type: "titles", start, end, duration: end - start });
const layout = layoutTimeline({
  timeline: "main",
  path: "timelines/main.json",
  revision: 1,
  fps: 30,
  duration: 22,
  problems: [],
  tracks: [
    { id: "v1", kind: "video", name: null, follows: null, clips: [titles("c_a", 0, 4), titles("c_b", 4, 10)] },
    { id: "v2", kind: "video", name: null, follows: null, clips: [titles("c_c", 20, 22)] },
    {
      id: "a1",
      kind: "audio",
      name: null,
      follows: null,
      clips: [{ id: "c_m", type: "media", asset: "assets/voice.wav", start: 2, end: 8, in: 1, out: 7 }],
    },
  ],
} satisfies TimelineView);
// Display order: V2 (top 22), V1 (66), A1 (110); 44 px each. Middle of each lane:
const Y = { v2: 44, v1: 88, a1: 132 };
const viewport = { pxPerSecond: 10, scrollLeft: 0, scrollTop: 0 };
const FPS = 30;

const grab = (x: number, y: number): Grab => grabAt(layout, viewport, x, y)!;
const snap = (playhead: number, exclude: string) => ({ points: snapPoints(layout, playhead, new Set([exclude])), tolerance: 0.5 });

describe("grabAt", () => {
  it("grabs a clip's body in the middle and its edges within a few px", () => {
    expect(grab(20, Y.v1)).toMatchObject({ clip: { id: "c_a" }, part: "body", row: { id: "v1" } });
    expect(grab(43, Y.v1)).toMatchObject({ clip: { id: "c_b" }, part: "head" });
    expect(grab(37, Y.v1)).toMatchObject({ clip: { id: "c_a" }, part: "tail" });
    expect(grabAt(layout, viewport, 150, Y.v1)).toBeNull();
    expect(grabAt(layout, viewport, 20, 10)).toBeNull();
  });

  it("keeps the middle of a short clip for moving it", () => {
    const zoomedOut = { ...viewport, pxPerSecond: 2 };
    expect(grabAt(layout, zoomedOut, 42, Y.v2)).toMatchObject({ clip: { id: "c_c" }, part: "body" });
  });
});

describe("dragPreview", () => {
  it("moves a clip by the pointer's travel, on the frame grid, never before 0", () => {
    const moved = dragPreview({ layout, grab: grab(210, Y.v2), delta: 3.01, y: Y.v2, fps: FPS, snap: null });
    expect(moved).toMatchObject({ start: 23, end: 25, snapped: null, blocked: false, row: { id: "v2" } });
    const early = dragPreview({ layout, grab: grab(20, Y.v1), delta: -5, y: Y.v1, fps: FPS, snap: null });
    expect(early).toMatchObject({ start: 0, end: 4 });
  });

  it("snaps either edge of a moved clip to other clips' edges and the playhead", () => {
    const toClip = dragPreview({ layout, grab: grab(210, Y.v2), delta: -9.8, y: Y.v2, fps: FPS, snap: snap(30, "c_c") });
    expect(toClip).toMatchObject({ start: 10, end: 12, snapped: { time: 10, kind: "clip" } });
    const toPlayhead = dragPreview({ layout, grab: grab(210, Y.v2), delta: 7.8, y: Y.v2, fps: FPS, snap: snap(30, "c_c") });
    expect(toPlayhead).toMatchObject({ start: 28, end: 30, snapped: { time: 30, kind: "playhead" } });
    const far = dragPreview({ layout, grab: grab(210, Y.v2), delta: 5, y: Y.v2, fps: FPS, snap: snap(30, "c_c") });
    expect(far).toMatchObject({ start: 25, snapped: null });
  });

  it("moves to another track of the same kind under the pointer, flagging overlaps", () => {
    const free = dragPreview({ layout, grab: grab(210, Y.v2), delta: -8, y: Y.v1, fps: FPS, snap: null });
    expect(free).toMatchObject({ row: { id: "v1" }, start: 12, blocked: false });
    const onto = dragPreview({ layout, grab: grab(210, Y.v2), delta: -15, y: Y.v1, fps: FPS, snap: null });
    expect(onto).toMatchObject({ row: { id: "v1" }, start: 5, blocked: true });
    const audio = dragPreview({ layout, grab: grab(210, Y.v2), delta: 1, y: Y.a1, fps: FPS, snap: null });
    expect(audio).toMatchObject({ row: { id: "v2" } });
  });

  it("trims the head or tail, keeping a frame and the source's start", () => {
    const head = dragPreview({ layout, grab: grab(43, Y.v1), delta: 1.5, y: Y.v1, fps: FPS, snap: null });
    expect(head).toMatchObject({ part: "head", start: 5.5, end: 10 });
    const crossed = dragPreview({ layout, grab: grab(43, Y.v1), delta: 20, y: Y.v1, fps: FPS, snap: null });
    expect(crossed.start).toBeCloseTo(10 - 1 / FPS, 6);
    // c_m starts 1 s into its source: its head reaches back to 1 s at most.
    const media = dragPreview({ layout, grab: grab(22, Y.a1), delta: -5, y: Y.a1, fps: FPS, snap: null });
    expect(media).toMatchObject({ part: "head", start: 1, end: 8 });
    const tail = dragPreview({ layout, grab: grab(78, Y.a1), delta: 1.9, y: Y.a1, fps: FPS, snap: snap(10, "c_m") });
    expect(tail).toMatchObject({ part: "tail", start: 2, end: 10, snapped: { time: 10 } });
  });
});

describe("dragEdits", () => {
  const preview = (x: number, y: number, delta: number, targetY = y, playhead = 30) =>
    dragPreview({ layout, grab: grab(x, y), delta, y: targetY, fps: FPS, snap: snap(playhead, grab(x, y).clip.id) });

  it("sends nothing for a drag that changed nothing", () => {
    expect(dragEdits(preview(210, Y.v2, 0.001))).toEqual([]);
  });

  it("sends one clip.move with only what changed", () => {
    expect(dragEdits(preview(210, Y.v2, 3))).toEqual([{ op: "clip.move", args: { clip: "c_c", start: 23 } }]);
    expect(dragEdits(preview(210, Y.v2, -8, Y.v1))).toEqual([{ op: "clip.move", args: { clip: "c_c", start: 12, track: "v1" } }]);
    expect(dragEdits(preview(210, Y.v2, 0, Y.v1))).toEqual([{ op: "clip.move", args: { clip: "c_c", track: "v1" } }]);
  });

  it("trims by timeline time; energy snapping stays on unless the edge meets another clip's edge", () => {
    expect(dragEdits(preview(43, Y.v1, 1.5))).toEqual([{ op: "clip.trim", args: { clip: "c_b", start: 5.5 } }]);
    expect(dragEdits(preview(78, Y.a1, 1.9, Y.a1, 30))).toEqual([{ op: "clip.trim", args: { clip: "c_m", end: 10, snap: false } }]);
    expect(dragEdits(preview(78, Y.a1, 1.1, Y.a1, 9))).toEqual([{ op: "clip.trim", args: { clip: "c_m", end: 9 } }]);
  });
});

describe("ripple trim drags (#119)", () => {
  const ripple = (x: number, y: number, delta: number) => dragPreview({ layout, grab: grab(x, y), delta, y, fps: FPS, snap: null, ripple: true });

  it("sends clip.trim with ripple, so later clips follow and no gap is left", () => {
    expect(ripple(43, Y.v1, 1.5)).toMatchObject({ part: "head", ripple: true, start: 5.5, end: 10 });
    expect(dragEdits(ripple(43, Y.v1, 1.5))).toEqual([{ op: "clip.trim", args: { clip: "c_b", start: 5.5, ripple: true } }]);
  });

  it("never shows an extension as blocked: the next clip moves out of the way", () => {
    const plain = dragPreview({ layout, grab: grab(37, Y.v1), delta: 1, y: Y.v1, fps: FPS, snap: null });
    expect(plain).toMatchObject({ end: 5, blocked: true, ripple: false });
    expect(ripple(37, Y.v1, 1)).toMatchObject({ end: 5, blocked: false });
    expect(dragEdits(ripple(37, Y.v1, 1))).toEqual([{ op: "clip.trim", args: { clip: "c_a", end: 5, ripple: true } }]);
  });

  it("ignores ripple for a body drag: that is a move", () => {
    expect(dragEdits(ripple(210, Y.v2, 3))).toEqual([{ op: "clip.move", args: { clip: "c_c", start: 23 } }]);
  });
});

describe("group moves of a multi-selection (#119)", () => {
  const moveGroup = (group: string[], delta: number, y = Y.v2) =>
    dragPreview({ layout, grab: grab(210, Y.v2), delta, y, fps: FPS, snap: null, group });

  it("moves every selected clip by the grabbed clip's shift, on their own tracks, the leading one first", () => {
    const preview = moveGroup(["c_b", "c_c"], 3, Y.v1);
    expect(preview).toMatchObject({ start: 23, row: { id: "v2" }, blocked: false });
    expect(preview.others).toMatchObject([{ clip: { id: "c_b" }, row: { id: "v1" }, start: 7, end: 13 }]);
    expect(dragEdits(preview)).toEqual([
      { op: "clip.move", args: { clip: "c_c", start: 23 } },
      { op: "clip.move", args: { clip: "c_b", start: 7 } },
    ]);
    expect(dragEdits(moveGroup(["c_b", "c_c"], -1)).map((edit) => ("clip" in edit.args ? edit.args.clip : null))).toEqual(["c_b", "c_c"]);
  });

  it("stops the group at timeline 0 and flags an overlap of any member", () => {
    const preview = moveGroup(["c_b", "c_c"], -6);
    expect(preview).toMatchObject({ start: 16, blocked: true });
    expect(preview.others[0]).toMatchObject({ start: 0, end: 6 });
  });

  it("is a plain move when only the grabbed clip is selected", () => {
    expect(moveGroup(["c_c"], 3).others).toEqual([]);
    expect(dragEdits(moveGroup(["c_c"], -8, Y.v1))).toEqual([{ op: "clip.move", args: { clip: "c_c", start: 12, track: "v1" } }]);
  });
});

describe("historyShortcut", () => {
  const keys = (key: string, mods: Partial<Record<"metaKey" | "ctrlKey" | "shiftKey" | "altKey", boolean>> = {}) => ({
    key,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    ...mods,
  });

  it("maps Command+Z and Command+Shift+Z on macOS", () => {
    expect(historyShortcut(keys("z", { metaKey: true }), true)).toBe("undo");
    expect(historyShortcut(keys("Z", { metaKey: true, shiftKey: true }), true)).toBe("redo");
    expect(historyShortcut(keys("z", { ctrlKey: true }), true)).toBeNull();
    expect(historyShortcut(keys("y", { metaKey: true }), true)).toBeNull();
  });

  it("maps Control+Z, Control+Shift+Z and Control+Y elsewhere", () => {
    expect(historyShortcut(keys("z", { ctrlKey: true }), false)).toBe("undo");
    expect(historyShortcut(keys("z", { ctrlKey: true, shiftKey: true }), false)).toBe("redo");
    expect(historyShortcut(keys("y", { ctrlKey: true }), false)).toBe("redo");
    expect(historyShortcut(keys("z", { ctrlKey: true, altKey: true }), false)).toBeNull();
    expect(historyShortcut(keys("z"), false)).toBeNull();
  });
});

describe("withStarts", () => {
  it("builds a second nudge on the first before the daemon's new revision arrives", () => {
    const first = commandEdits({ kind: "nudge", frames: 1 }, { layout, selected: ["c_c"], playhead: 0, fps: FPS });
    // On the frame grid, as the daemon stores it: 3-decimal seconds would drift a frame over many presses.
    const sent = new Map([["c_c", Math.round((first[0]!.args as { start: number }).start * FPS) / FPS]]);
    expect(commandEdits({ kind: "nudge", frames: 1 }, { layout: withStarts(layout, sent), selected: ["c_c"], playhead: 0, fps: FPS })).toEqual([
      { op: "clip.move", args: { clip: "c_c", start: 20.067 } },
    ]);
    expect(withStarts(layout, new Map())).toBe(layout);
  });
});

describe("commandOptions", () => {
  it("makes repeated nudges of the same clips one burst, labelled", () => {
    expect(commandOptions({ kind: "nudge", frames: 1 }, ["c_b", "c_a"])).toEqual({ label: "Nudge 2 clips", burst: "nudge:c_a c_b" });
    expect(commandOptions({ kind: "nudge", frames: -10 }, ["c_c"])).toEqual({ label: "Nudge clip", burst: "nudge:c_c" });
  });

  it("leaves other commands to main's default label, one transaction each", () => {
    expect(commandOptions({ kind: "split" }, ["c_a"])).toEqual({});
    expect(commandOptions({ kind: "delete", ripple: true }, ["c_a"])).toEqual({});
  });
});

describe("commandEdits", () => {
  const context = (selected: string[], playhead: number) => ({ layout, selected, playhead, fps: FPS });

  it("splits the selected clips under the playhead, or every clip under it when none is selected", () => {
    const split = (clip: string, at: number) => ({ op: "clip.split", args: { clip, at } });
    expect(commandEdits({ kind: "split" }, context([], 5))).toEqual([split("c_b", 5), split("c_m", 5)]);
    expect(commandEdits({ kind: "split" }, context(["c_m"], 5))).toEqual([split("c_m", 5)]);
    expect(commandEdits({ kind: "split" }, context(["c_c"], 5))).toEqual([]);
    // On an edit point: nothing to split there.
    expect(commandEdits({ kind: "split" }, context(["c_a", "c_b"], 4))).toEqual([]);
  });

  it("trims the head or tail of clips under the playhead to it", () => {
    expect(commandEdits({ kind: "trim", side: "head" }, context(["c_b"], 6))).toEqual([
      { op: "clip.trim", args: { clip: "c_b", start: 6 } },
    ]);
    expect(commandEdits({ kind: "trim", side: "tail" }, context([], 3))).toEqual([
      { op: "clip.trim", args: { clip: "c_a", end: 3 } },
      { op: "clip.trim", args: { clip: "c_m", end: 3 } },
    ]);
  });

  it("nudges selected clips by frames, the leading clip first so neighbours never collide", () => {
    expect(commandEdits({ kind: "nudge", frames: 1 }, context(["c_c"], 0))).toEqual([
      { op: "clip.move", args: { clip: "c_c", start: 20.033 } },
    ]);
    expect(commandEdits({ kind: "nudge", frames: 3 }, context(["c_a", "c_b"], 0)).map((edit) => ("clip" in edit.args ? edit.args.clip : null))).toEqual(["c_b", "c_a"]);
    expect(commandEdits({ kind: "nudge", frames: -3 }, context(["c_b", "c_c"], 0)).map((edit) => ("clip" in edit.args ? edit.args.clip : null))).toEqual(["c_b", "c_c"]);
    expect(commandEdits({ kind: "nudge", frames: -3 }, context(["c_a"], 0))).toEqual([]);
  });

  it("deletes selected clips leaving a gap, or ripple deletes them on their own track, latest first and exact", () => {
    expect(commandEdits({ kind: "delete", ripple: false }, context(["c_a"], 0))).toEqual([{ op: "clip.remove", args: { clip: "c_a" } }]);
    expect(commandEdits({ kind: "delete", ripple: true }, context(["c_a", "c_b"], 0))).toEqual([
      { op: "cut", args: { from: 4, to: 10, tracks: ["v1"], snap: false } },
      { op: "cut", args: { from: 0, to: 4, tracks: ["v1"], snap: false } },
    ]);
  });
});
