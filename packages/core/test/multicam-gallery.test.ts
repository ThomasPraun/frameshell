import { ErrorCode, RpcError } from "@frameshell/protocol";
import { type Timeline, createTimeline, groupSounds } from "@frameshell/schema";
import { describe, expect, it } from "vitest";
import {
  type EditContext,
  type GallerySample,
  type GrayFrame,
  type OperationRequest,
  type SourceInfo,
  type TileRect,
  applyOperation,
  applyPatch,
  detectTiles,
  galleryFrameSize,
  galleryInterval,
  galleryLayouts,
  galleryReport,
  gutterLevels,
  planGallery,
  tileCrop,
} from "../src/index.js";

const GUTTER = 40;

/** A `width`×`height` frame of gutter colour with textured tiles (a pseudo-random pattern per tile, never flat). */
function frame(width: number, height: number, tiles: TileRect[], seed = 1): GrayFrame {
  const data = new Uint8Array(width * height).fill(GUTTER);
  let state = seed;
  for (const tile of tiles) {
    for (let y = tile.y0; y < tile.y1; y++) {
      for (let x = tile.x0; x < tile.x1; x++) {
        state = (state * 1103515245 + 12345) & 0x7fffffff;
        data[y * width + x] = 100 + (state % 120);
      }
    }
  }
  return { width, height, data };
}

const GRID_2X2: TileRect[] = [
  { x0: 4, y0: 4, x1: 98, y1: 56 },
  { x0: 102, y0: 4, x1: 196, y1: 56 },
  { x0: 4, y0: 60, x1: 98, y1: 112 },
  { x0: 102, y0: 60, x1: 196, y1: 112 },
];
const THREE: TileRect[] = [
  { x0: 4, y0: 4, x1: 98, y1: 56 },
  { x0: 102, y0: 4, x1: 196, y1: 56 },
  { x0: 53, y0: 60, x1: 147, y1: 112 },
];

describe("detectTiles", () => {
  it("finds a 2×2 gallery in reading order, gutters and border trimmed", () => {
    const tiles = detectTiles(frame(200, 116, GRID_2X2));
    expect(tiles).toEqual(GRID_2X2);
  });

  it("finds a centered last row, and tiles that touch the frame's edges", () => {
    expect(detectTiles(frame(200, 116, THREE))).toEqual(THREE);
    const edge: TileRect[] = [
      { x0: 0, y0: 0, x1: 98, y1: 116 },
      { x0: 102, y0: 0, x1: 200, y1: 116 },
    ];
    expect(detectTiles(frame(200, 116, edge))).toEqual(edge);
  });

  it("reads the gutter level from flat full-length lines and finds nothing without one", () => {
    expect(gutterLevels(frame(200, 116, GRID_2X2))).toEqual([GUTTER]);
    const full = frame(200, 116, [{ x0: 0, y0: 0, x1: 200, y1: 116 }]);
    expect(gutterLevels(full)).toEqual([]);
    expect(detectTiles(full)).toEqual([]);
  });

  it("keeps one letterboxed picture as one tile and drops slivers smaller than a tile", () => {
    expect(detectTiles(frame(200, 116, [{ x0: 20, y0: 0, x1: 180, y1: 116 }]))).toEqual([{ x0: 20, y0: 0, x1: 180, y1: 116 }]);
    const sliver = detectTiles(frame(200, 116, [...GRID_2X2.slice(0, 2), { x0: 4, y0: 60, x1: 8, y1: 112 }]));
    expect(sliver).toEqual(GRID_2X2.slice(0, 2));
  });
});

describe("galleryLayouts", () => {
  const size = { width: 200, height: 116 };
  const samples = (layouts: TileRect[][]): GallerySample[] => layouts.map((tiles, i) => ({ time: i * 2, tiles }));

  it("splits the file into stretches at a layout change and takes median edges", () => {
    const shifted = GRID_2X2.map((tile) => ({ ...tile, x1: tile.x1 + 1 }));
    const analysis = galleryLayouts(samples([GRID_2X2, shifted, GRID_2X2, GRID_2X2, THREE, THREE, THREE]), size, 2, 13.5);
    expect(analysis.stretches).toEqual([
      { start: 0, end: 8, layout: 0 },
      { start: 8, end: 13.5, layout: 1 },
    ]);
    expect(analysis.layouts.map((layout) => layout.duration)).toEqual([8, 5.5]);
    expect(analysis.layouts[0]!.tiles.map(({ confidence: _confidence, ...rect }) => rect)).toEqual(GRID_2X2);
    expect(analysis.layouts[0]!.tiles.every((tile) => tile.confidence === 1)).toBe(true);
    // The bottom tile of THREE is as large as the others.
    expect(analysis.layouts[1]!.tiles.map((tile) => tile.confidence)).toEqual([1, 1, 1]);
  });

  it("treats runs shorter than three samples as noise of the run before, and frames without a grid as their own stretch", () => {
    const analysis = galleryLayouts(samples([GRID_2X2, GRID_2X2, GRID_2X2, THREE, GRID_2X2, GRID_2X2, [], [], [], []]), size, 1, 10);
    expect(analysis.stretches).toEqual([
      { start: 0, end: 6, layout: 0 },
      { start: 6, end: 10, layout: null },
    ]);
    expect(analysis.layouts).toHaveLength(1);
    // The 3-tile frame found two of the four tiles: they keep full confidence, the bottom two do not.
    expect(analysis.layouts[0]!.tiles.map((tile) => tile.confidence)).toEqual([1, 1, 0.83, 0.83]);
  });

  it("finds no grid where the tiles change every sample: lines in moving pictures are not gutters", () => {
    const wobbly = [0, 10, 20, 30].map((shift): TileRect[] => [
      { x0: 0, y0: 0, x1: 90 + shift, y1: 116 },
      { x0: 94 + shift, y0: 0, x1: 200, y1: 116 },
    ]);
    const analysis = galleryLayouts(samples(wobbly), size, 1, 4);
    expect(analysis.layouts).toEqual([]);
    expect(analysis.stretches).toEqual([{ start: 0, end: 4, layout: null }]);
  });

  it("lowers the confidence of a tile whose size differs from the others", () => {
    const uneven: TileRect[] = [GRID_2X2[0]!, GRID_2X2[1]!, { x0: 4, y0: 60, x1: 196, y1: 112 }];
    const analysis = galleryLayouts(samples([uneven, uneven, uneven]), size, 1, 3);
    expect(analysis.layouts[0]!.tiles.map((tile) => tile.confidence)).toEqual([1, 1, 0.49]);
  });

  it("sizes, intervals and crops", () => {
    expect(galleryFrameSize(1920, 1080)).toEqual({ width: 960, height: 540 });
    expect(galleryFrameSize(641, 360)).toEqual({ width: 640, height: 360 });
    expect(galleryInterval(12)).toBe(1);
    expect(galleryInterval(3600)).toBe(6);
    expect(tileCrop({ x0: 0, y0: 4, x1: 98, y1: 116 }, 200, 116)).toEqual({ top: 0.0345, right: 0.51 });
  });
});

describe("planGallery and galleryReport", () => {
  const root = "/project";
  const analysis = galleryLayouts(
    [GRID_2X2, GRID_2X2, GRID_2X2, THREE, THREE, THREE, THREE].map((tiles, i) => ({ time: i, tiles })),
    { width: 200, height: 116 },
    1,
    7,
  );
  const source = {
    probe: async (_root: string, asset: string) => {
      if (asset === "assets/missing.mp4") throw new RpcError(ErrorCode.AssetNotFound, "missing", { path: asset });
      return {
        duration: asset === "assets/still.png" ? null : 7,
        format: "mp4",
        video: { codec: "h264", width: 200, height: 116, fps: 30, vfr: false, still: asset === "assets/still.png" },
        audio: null,
      };
    },
    analyse: async () => analysis,
  };

  it("takes the layout held longest, or the one at `at`, and checks the names", async () => {
    const plan = await planGallery(source, { root, cwd: root, asset: "assets/call.mp4" });
    expect(plan.layout).toBe(1);
    expect(plan.tiles).toHaveLength(3);
    expect((await planGallery(source, { root, cwd: root, asset: "assets/call.mp4", at: 1.5 })).layout).toBe(0);
    await expect(planGallery(source, { root, cwd: root, asset: "assets/call.mp4", names: ["Ana"] })).rejects.toMatchObject({
      code: ErrorCode.InvalidOperation,
      data: expect.objectContaining({ field: "names", tiles: 3 }),
    });
    await expect(planGallery(source, { root, cwd: root, asset: "assets/still.png" })).rejects.toMatchObject({ code: ErrorCode.InvalidOperation });
    await expect(planGallery(source, { root, cwd: root, asset: "assets/missing.mp4" })).rejects.toMatchObject({ code: ErrorCode.AssetNotFound });
  });

  it("refuses a file without a grid and a time without one", async () => {
    const none = galleryLayouts([[], [], []].map((tiles, i) => ({ time: i, tiles })), { width: 200, height: 116 }, 1, 3);
    await expect(planGallery({ ...source, analyse: async () => none }, { root, cwd: root, asset: "assets/call.mp4" })).rejects.toMatchObject({
      message: expect.stringContaining("found no tile grid"),
    });
    const late = galleryLayouts([GRID_2X2, GRID_2X2, GRID_2X2, [], [], []].map((tiles, i) => ({ time: i, tiles })), { width: 200, height: 116 }, 1, 6);
    await expect(planGallery({ ...source, analyse: async () => late }, { root, cwd: root, asset: "assets/call.mp4", at: 4 })).rejects.toMatchObject({
      data: expect.objectContaining({ field: "at", hint: expect.stringContaining("0–3 s: 4 tiles, 3–6 s: no tile grid") }),
    });
    await expect(planGallery(source, { root, cwd: root, asset: "assets/call.mp4", at: 9999 })).rejects.toMatchObject({
      message: expect.stringContaining("past the end"),
      data: expect.objectContaining({ field: "at", reason: "no grid", hint: expect.stringContaining("0–3 s: 4 tiles, 3–7 s: 3 tiles") }),
    });
    expect((await planGallery(source, { root, cwd: root, asset: "assets/call.mp4", at: 7 })).layout).toBe(1);
  });

  it("reports tiles, stretches and warns about the layout change", async () => {
    const plan = await planGallery(source, { root, cwd: root, asset: "assets/call.mp4" });
    const group = {
      id: "g_call",
      angles: plan.tiles.map((tile, i) => ({ id: `tile-${i + 1}`, name: `Tile ${i + 1}`, asset: plan.asset, offset: 0, crop: tile.crop, mic: "call" })),
      mics: [{ id: "call", name: "Call", asset: plan.asset, offset: 0 }],
    };
    const report = galleryReport(group, plan);
    expect(report.layouts).toEqual([
      { start: 0, end: 3, tiles: 4, used: false },
      { start: 3, end: 7, tiles: 3, used: true },
    ]);
    expect(report.tiles.map((tile) => tile.angle)).toEqual(["tile-1", "tile-2", "tile-3"]);
    expect(report.warnings[0]).toBe("the call layout changes at 3 s: 4 tiles before, 3 tiles after.");
    expect(report.warnings[1]).toContain("the tiles follow the layout of 3–7 s (3 tiles)");
    expect(report.warnings.at(-1)).toContain("frameshell transcribe --speakers assets/call.mp4 --people 3");
  });
});

const SOURCES: Record<string, SourceInfo> = {
  "assets/call.mp4": { duration: 12, video: true, audio: true },
  "assets/silent.mp4": { duration: 12, video: true, audio: false },
  "assets/voice.wav": { duration: 12, video: false, audio: true },
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

const gallery = (asset: string, tiles: { name?: string; crop: Record<string, number> }[], name?: string) =>
  ({ op: "multicam.gallery", args: { asset, tiles, ...(name ? { name } : {}) } }) as OperationRequest;

const BASE = (): Timeline => ({ ...createTimeline("main"), tracks: [{ id: "t_v", kind: "video", clips: [] }] });

describe("multicam.gallery operation", () => {
  it("adds one cropped angle per tile of the same file, one mic for its sound, a program track and a grid shot", async () => {
    const before = BASE();
    const applied = await applyOperation(
      before,
      gallery("assets/call.mp4", [{ name: "Ana", crop: { right: 0.5, bottom: 0.5 } }, { crop: { left: 0.5, bottom: 0.5 } }, { crop: { top: 0.5, left: 0.25, right: 0.25 } }], "Standup"),
      context(),
    );
    const group = applied.timeline.groups![0]!;
    expect(group).toEqual({
      id: "g_0001",
      name: "Standup",
      angles: [
        { id: "ana", name: "Ana", asset: "assets/call.mp4", offset: 0, crop: { right: 0.5, bottom: 0.5 }, mic: "call" },
        { id: "tile-2", name: "Tile 2", asset: "assets/call.mp4", offset: 0, crop: { left: 0.5, bottom: 0.5 }, mic: "call" },
        { id: "tile-3", name: "Tile 3", asset: "assets/call.mp4", offset: 0, crop: { top: 0.5, left: 0.25, right: 0.25 }, mic: "call" },
      ],
      mics: [{ id: "call", name: "Call", asset: "assets/call.mp4", offset: 0 }],
    });
    // The call's sound plays once, not once per tile.
    expect(groupSounds(group).map((sound) => sound.id)).toEqual(["call"]);
    expect(applied.timeline.tracks[1]).toEqual({
      id: "t_0002",
      kind: "program",
      name: "Standup",
      group: "g_0001",
      clips: [{ id: "c_0003", type: "shot", start: 0, in: 0, out: 12, shot: "grid", angles: ["ana", "tile-2", "tile-3"] }],
    });
    const restored = applyPatch(applied.timeline, applied.inverse.args);
    expect(restored.groups).toBeUndefined();
    expect(restored.tracks).toEqual(before.tracks);
  });

  it("gives silent angles and no mic for a file without sound", async () => {
    const applied = await applyOperation(BASE(), gallery("assets/silent.mp4", [{ crop: { right: 0.5 } }, { crop: { left: 0.5 } }]), context());
    expect(applied.timeline.groups![0]!.mics).toBeUndefined();
    expect(applied.timeline.groups![0]!.angles.map((angle) => angle.mic)).toEqual([null, null]);
  });

  it("refuses a file without a picture and a crop that leaves nothing", async () => {
    await expect(applyOperation(BASE(), gallery("assets/voice.wav", [{ crop: {} }, { crop: {} }]), context())).rejects.toMatchObject({
      code: ErrorCode.InvalidOperation,
      message: expect.stringContaining("no moving picture"),
    });
    await expect(applyOperation(BASE(), gallery("assets/call.mp4", [{ crop: { left: 0.6, right: 0.4 } }, { crop: {} }]), context())).rejects.toMatchObject({
      message: expect.stringContaining("the crop of tile 1 would cut its whole picture"),
    });
  });
});
