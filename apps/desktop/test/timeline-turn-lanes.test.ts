import type { TimelineView } from "@frameshell/protocol";
import { describe, expect, it } from "vitest";
import { LANE_HEIGHT, RULER_HEIGHT, type TurnLaneInput, clipAt, layoutTimeline } from "../src/renderer/src/timeline/layout.js";
import { DEFAULT_THEME, type Paint2D, paintTimeline } from "../src/renderer/src/timeline/paint.js";
import { TURN_LANE_HEIGHT, clearEdit, laneAt, laneMarks, paintEdits, shotSpans, toGroup, toTimeline, unpaintEdits, within } from "../src/renderer/src/timeline/turn-lanes.js";

// Seam under test: the program track's turn lanes (#247): group-clock turns on the timeline clock, painting back the other way.

// A cut took group 4..10 out: the program plays group 0..4 from timeline 0, then group 10..14 from timeline 4.
const shots = [
  { start: 0, end: 4, in: 0 },
  { start: 4, end: 8, in: 10 },
];

describe("toTimeline and toGroup", () => {
  it("shows only what some shot plays, on the timeline clock", () => {
    // Group 2..4 plays at timeline 2..4 and group 10..12 at 4..6: one stretch.
    expect(toTimeline(shots, [{ start: 2, end: 12 }])).toEqual([{ start: 2, end: 6 }]);
    expect(toTimeline(shots, [{ start: 5, end: 9 }])).toEqual([]);
    expect(toTimeline(shots, [{ start: 11, end: 13 }])).toEqual([{ start: 5, end: 7 }]);
  });

  it("joins stretches of consecutive shots that continue each other", () => {
    const split = [
      { start: 0, end: 2, in: 0 },
      { start: 2, end: 4, in: 2 },
    ];
    expect(toTimeline(split, [{ start: 1, end: 3 }])).toEqual([{ start: 1, end: 3 }]);
    expect(toGroup(split, 1, 3.5)).toEqual([{ start: 1, end: 3.5 }]);
  });

  it("maps a timeline stretch to one group stretch per shot it crosses, none over gaps", () => {
    expect(toGroup(shots, 3, 5)).toEqual([
      { start: 3, end: 4 },
      { start: 10, end: 11 },
    ]);
    expect(toGroup(shots, 8.5, 9)).toEqual([]);
    expect(toGroup([{ start: 2, end: 4, in: 5 }], 0, 3)).toEqual([{ start: 5, end: 6 }]);
  });
});

describe("laneMarks", () => {
  it("separates the angle's turns from what was painted, hiding what no shot shows", () => {
    const turns = [
      { angle: "ana", start: 1, end: 3 },
      { angle: "ben", start: 11, end: 12 },
      { angle: "ana", start: 5, end: 9 },
    ];
    const painted = [
      { angle: "ana", start: 2, end: 3, speaking: true },
      { angle: "ana", start: 11, end: 12, speaking: false },
      { angle: "ben", start: 0, end: 1, speaking: false },
    ];
    expect(laneMarks(shots, "ana", turns, painted)).toEqual({
      turns: [{ start: 1, end: 3 }],
      spoken: [{ start: 2, end: 3 }],
      silenced: [{ start: 5, end: 6 }],
    });
  });

  it("finds a time inside marks, start inclusive", () => {
    expect(within([{ start: 1, end: 2 }], 1)).toBe(true);
    expect(within([{ start: 1, end: 2 }], 2)).toBe(false);
  });
});

describe("paintEdits", () => {
  it("sends one multicam.paint per group stretch the stroke crosses; the mode sets the arguments, the drag direction is free", () => {
    expect(paintEdits("g_1", "ana", shots, 5, 3, "only")).toEqual([
      { op: "multicam.paint", args: { group: "g_1", angle: "ana", start: 3, end: 4, speaking: true, alone: true } },
      { op: "multicam.paint", args: { group: "g_1", angle: "ana", start: 10, end: 11, speaking: true, alone: true } },
    ]);
    expect(paintEdits("g_1", "ana", shots, 1, 2, "add")).toEqual([{ op: "multicam.paint", args: { group: "g_1", angle: "ana", start: 1, end: 2, speaking: true } }]);
    expect(paintEdits("g_1", "ana", shots, 1, 2, "silent")[0]).toMatchObject({ args: { speaking: false } });
    expect(paintEdits("g_1", "ana", shots, 1, 2, "measured")[0]).toMatchObject({ args: { speaking: null } });
  });

  it("sends nothing over a gap", () => {
    expect(paintEdits("g_1", "ana", shots, 9, 12, "only")).toEqual([]);
  });

  it("takes the painted stretch under a time back to measured, or does nothing where none is", () => {
    const painted = [{ angle: "ana", start: 10, end: 12, speaking: true }];
    expect(unpaintEdits("g_1", "ana", shots, painted, 5)).toEqual([{ op: "multicam.paint", args: { group: "g_1", angle: "ana", start: 10, end: 12, speaking: null } }]);
    expect(unpaintEdits("g_1", "ana", shots, painted, 1)).toEqual([]);
    expect(unpaintEdits("g_1", "ben", shots, painted, 5)).toEqual([]);
    expect(unpaintEdits("g_1", "ana", shots, painted, 20)).toEqual([]);
  });

  it("clears one angle or the whole group", () => {
    expect(clearEdit("g_1", "ana")).toMatchObject({ op: "multicam.paint", args: { group: "g_1", angle: "ana", speaking: null, start: 0 } });
    expect((clearEdit("g_1", null).args as Record<string, unknown>)["angle"]).toBeUndefined();
  });
});

type Painted = NonNullable<NonNullable<TimelineView["groups"]>[number]["painted"]>;

function program(painted?: Painted): TimelineView {
  return {
    timeline: "main",
    path: "timelines/main.json",
    revision: 1,
    fps: 30,
    duration: 8,
    tracks: [
      { id: "t_v", kind: "video", name: null, follows: null, clips: [] },
      {
        id: "t_p",
        kind: "program",
        name: null,
        follows: null,
        group: "g_talk",
        clips: [
          { id: "c_a", type: "shot", start: 0, end: 4, in: 0, out: 4, shot: "solo", angles: ["ana"] },
          { id: "c_b", type: "shot", start: 4, end: 8, in: 10, out: 14, shot: "solo", angles: ["ben"] },
        ],
      },
    ],
    groups: [
      {
        id: "g_talk",
        angles: [
          { id: "ana", name: "Ana", asset: "assets/ana.mp4", offset: 0 },
          { id: "ben", name: "Ben", asset: "assets/ben.mp4", offset: 0 },
        ],
        ...(painted ? { painted } : {}),
      },
    ],
    problems: [],
  };
}

const open = (turns: TurnLaneInput["turns"] = new Map()): TurnLaneInput => ({ open: new Set(["t_p"]), turns });

describe("layoutTimeline with turn lanes", () => {
  it("has no lanes until a track's are opened, and the rows below keep their place", () => {
    const closed = layoutTimeline(program());
    expect(closed.rows[0]!.lanes).toEqual([]);
    expect(closed.rows[0]!.lanesHeight).toBe(0);
    expect(closed.rows[1]!.top).toBe(RULER_HEIGHT + LANE_HEIGHT.program);
    expect(layoutTimeline(program(), [], { open: new Set(), turns: new Map() }).rows[0]!.lanes).toEqual([]);
  });

  it("puts one lane per angle under the shots, pushing the next track down", () => {
    const layout = layoutTimeline(program(), [], open());
    const [row, below] = layout.rows;
    expect(row!.id).toBe("t_p");
    expect(row!.height).toBe(LANE_HEIGHT.program);
    expect(row!.lanes.map((lane) => [lane.angle.id, lane.top, lane.height])).toEqual([
      ["ana", RULER_HEIGHT + LANE_HEIGHT.program, TURN_LANE_HEIGHT],
      ["ben", RULER_HEIGHT + LANE_HEIGHT.program + TURN_LANE_HEIGHT, TURN_LANE_HEIGHT],
    ]);
    expect(row!.lanesHeight).toBe(2 * TURN_LANE_HEIGHT);
    expect(below!.top).toBe(row!.top + row!.height + row!.lanesHeight);
    expect(layout.height).toBe(below!.top + below!.height);
  });

  it("draws the group's turns and painted stretches on the lanes", () => {
    const turns = new Map([
      [
        "g_talk",
        [
          { angle: "ana", start: 1, end: 3 },
          { angle: "ben", start: 11, end: 13 },
        ],
      ],
    ]);
    const layout = layoutTimeline(program([{ angle: "ben", start: 12, end: 13, speaking: false }]), [], open(turns));
    const [ana, ben] = layout.rows[0]!.lanes;
    expect(ana!.marks.turns).toEqual([{ start: 1, end: 3 }]);
    expect(ben!.marks).toEqual({ turns: [{ start: 5, end: 7 }], spoken: [], silenced: [{ start: 6, end: 7 }] });
    expect(ben!.painted).toEqual([{ angle: "ben", start: 12, end: 13, speaking: false }]);
  });

  it("finds the lane under a point and keeps clip hits to the shots' band", () => {
    const layout = layoutTimeline(program(), [], open());
    const viewport = { pxPerSecond: 10, scrollLeft: 0, scrollTop: 0 };
    const y = RULER_HEIGHT + LANE_HEIGHT.program + TURN_LANE_HEIGHT * 1.5;
    expect(laneAt(layout, viewport, 25, y)).toMatchObject({ row: { id: "t_p" }, lane: { angle: { id: "ben" } }, time: 2.5 });
    expect(laneAt(layout, viewport, 25, RULER_HEIGHT + 5)).toBeNull();
    expect(laneAt(layout, { ...viewport, scrollTop: 10 }, 25, y - 10)).toMatchObject({ lane: { angle: { id: "ben" } } });
    expect(clipAt(layout, viewport, 25, RULER_HEIGHT + 5)?.clip.id).toBe("c_a");
    expect(clipAt(layout, viewport, 25, y)).toBeNull();
    expect(shotSpans(layout.rows[0]!.clips)).toEqual([
      { start: 0, end: 4, in: 0 },
      { start: 4, end: 8, in: 10 },
    ]);
  });
});

describe("paintTimeline with turn lanes", () => {
  /** Every fillRect with the fill it used. */
  function recording() {
    const rects: { x: number; y: number; w: number; h: number; fill: string }[] = [];
    const noop = () => {};
    const ctx = {
      fillStyle: "" as string | object,
      strokeStyle: "" as string | object,
      lineWidth: 1,
      globalAlpha: 1,
      font: "",
      textBaseline: "",
      textAlign: "",
      save: noop,
      restore: noop,
      beginPath: noop,
      closePath: noop,
      moveTo: noop,
      lineTo: noop,
      rect: noop,
      clip: noop,
      fill: noop,
      stroke: noop,
      setLineDash: noop,
      clearRect: noop,
      strokeRect: noop,
      fillText: noop,
      measureText: (text: string) => ({ width: text.length * 6 }),
      drawImage: noop,
      fillRect: (x: number, y: number, w: number, h: number) => void rects.push({ x, y, w, h, fill: String(ctx.fillStyle) }),
    } satisfies Paint2D<string>;
    return { ctx, rects };
  }
  const viewport = { pxPerSecond: 10, scrollLeft: 0, scrollTop: 0, width: 600, height: 200 };
  const input = (layout: ReturnType<typeof layoutTimeline>, extra = {}) => ({
    layout,
    viewport,
    fps: 30,
    playhead: 0,
    theme: DEFAULT_THEME,
    media: { waveform: () => null, thumbnails: () => null },
    ...extra,
  });

  it("draws each turn in its angle's colour inside that angle's lane, and nothing below a closed track", () => {
    const turns = new Map([
      [
        "g_talk",
        [
          { angle: "ana", start: 1, end: 3 },
          { angle: "ben", start: 11, end: 13 },
        ],
      ],
    ]);
    const layout = layoutTimeline(program(), [], open(turns));
    const { ctx, rects } = recording();
    paintTimeline(ctx, input(layout));
    const [ana, ben] = layout.rows[0]!.lanes;
    const bars = (lane: NonNullable<typeof ana>, color: string) => rects.filter((rect) => rect.fill === color && rect.y > lane.top && rect.y < lane.top + lane.height && rect.h > 4);
    expect(bars(ana!, DEFAULT_THEME.angles[0]!)).toEqual([expect.objectContaining({ x: 10, w: 20 })]);
    expect(bars(ben!, DEFAULT_THEME.angles[1]!)).toEqual([expect.objectContaining({ x: 50, w: 20 })]);

    const closed = recording();
    paintTimeline(closed.ctx, input(layoutTimeline(program(), [], { open: new Set(), turns })));
    const lanesTop = layout.rows[0]!.lanes[0]!.top;
    expect(closed.rects.some((rect) => rect.fill === DEFAULT_THEME.angles[1] && rect.y >= lanesTop && rect.y < lanesTop + 2 * TURN_LANE_HEIGHT && rect.h > 4)).toBe(false);
  });

  it("tints the stroke being painted on its own lane only", () => {
    const layout = layoutTimeline(program(), [], open());
    const { ctx, rects } = recording();
    paintTimeline(ctx, input(layout, { stroke: { row: "t_p", angle: "ben", from: 5, to: 2, mode: "only" } }));
    const [ana, ben] = layout.rows[0]!.lanes;
    const tinted = (lane: NonNullable<typeof ana>) => rects.filter((rect) => rect.fill === DEFAULT_THEME.accent && rect.y === lane.top + 1);
    expect(tinted(ben!)).toEqual([expect.objectContaining({ x: 20, w: 30 })]);
    expect(tinted(ana!)).toEqual([]);
  });
});
