import { spawn } from "node:child_process";
import type { AngleCrop } from "@frameshell/schema";

// Tiles of a gallery-view call recording (Zoom, Meet, Teams; ADR 0016 decision 1). Gutters are lines of one flat
// colour between tiles. Per sampled frame: find the gutter level from flat full-length lines, then a recursive XY
// cut (trim the flat border, split at flat interior rows, else at flat interior columns, recurse into each piece).
// Frames with the same tiles form a layout; a layout held for fewer than MIN_LAYOUT_SAMPLES samples is noise.
// Deterministic: the same file gives the same tiles.

/** Widest frame analysed, pixels; wider pictures are scaled down (area average) to it. */
export const GALLERY_MAX_WIDTH = 960;
/** Most frames sampled from one file; a long call is sampled more sparsely. */
export const GALLERY_MAX_SAMPLES = 600;
/** Shortest time between two samples, seconds. */
export const GALLERY_MIN_INTERVAL_S = 1;
/** Brightness difference (0 to 255) a gutter pixel may have from the gutter level. */
export const GUTTER_TOLERANCE = 10;
/** Share of a line's pixels allowed off the gutter level (compression noise, a mouse pointer). */
const GUTTER_OUTLIERS = 0.02;
/** Smallest tile, as a fraction of the frame's width and of its height: a 7×7 gallery still fits. */
export const MIN_TILE_FRACTION = 0.06;
/** Two tiles are the same when every edge is within this fraction of the frame's width (x) or height (y). */
export const TILE_MATCH_FRACTION = 0.02;
/** Samples in a row a layout must hold to count as a stretch of the call. */
export const MIN_LAYOUT_SAMPLES = 3;
/** Gutter levels tried per frame (see {@link gutterLevels}). */
const GUTTER_CANDIDATES = 3;
/** Nesting of cuts per frame: bands, tiles in a band, and one more level for uneven layouts. */
const MAX_DEPTH = 4;

/** A tile in analysis pixels; `x1` and `y1` are exclusive. */
export interface TileRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** One gray frame, row by row, one byte per pixel. */
export interface GrayFrame {
  width: number;
  height: number;
  data: Uint8Array;
}

/** Tiles found in one sampled frame; fewer than two means no grid there. */
export interface GallerySample {
  /** File seconds. */
  time: number;
  /** In reading order, analysis pixels. */
  tiles: TileRect[];
}

/** A tile of a layout: its median rectangle and how sure the detection is of it. */
export interface GalleryTile extends TileRect {
  /** 0 to 1: share of the layout's samples that found this tile, lowered when its size differs from the other tiles'. */
  confidence: number;
}

/** A distinct tile grid seen in the file. */
export interface GalleryLayout {
  tiles: GalleryTile[];
  /** Seconds of the file the layout holds, summed over its stretches. */
  duration: number;
}

/** A stretch of the file with one layout. */
export interface GalleryStretch {
  /** File seconds. */
  start: number;
  end: number;
  /** Index into {@link GalleryAnalysis.layouts}; null where no tile grid was found. */
  layout: number | null;
}

/** Tile grids of a whole file. */
export interface GalleryAnalysis {
  /** Analysis frame size, pixels; tiles are in it. */
  width: number;
  height: number;
  /** Seconds between samples. */
  interval: number;
  samples: number;
  layouts: GalleryLayout[];
  /** Cover the file from 0 to its end, in order; neighbours differ in layout. */
  stretches: GalleryStretch[];
}

/** Analysis size for a `width`×`height` picture: at most {@link GALLERY_MAX_WIDTH} wide, aspect kept, even sides. */
export function galleryFrameSize(width: number, height: number): { width: number; height: number } {
  const w = Math.max(2, Math.min(GALLERY_MAX_WIDTH, width) & ~1);
  return { width: w, height: Math.max(2, Math.round((w * height) / width / 2) * 2) };
}

/** Seconds between samples for a file of `duration` s: at most {@link GALLERY_MAX_SAMPLES}, 0.1 s steps. */
export function galleryInterval(duration: number): number {
  return Math.max(GALLERY_MIN_INTERVAL_S, Math.ceil((duration / GALLERY_MAX_SAMPLES) * 10) / 10);
}

const pixel = (frame: GrayFrame, axis: "row" | "column", line: number, at: number) =>
  axis === "row" ? frame.data[line * frame.width + at]! : frame.data[at * frame.width + line]!;

/** Mean of a line and whether it is flat: almost every pixel within the tolerance of that mean. */
function lineLevel(frame: GrayFrame, axis: "row" | "column", line: number, from: number, to: number): number | null {
  let sum = 0;
  for (let at = from; at < to; at++) sum += pixel(frame, axis, line, at);
  const mean = sum / (to - from);
  return offLevel(frame, axis, line, from, to, mean) <= (to - from) * GUTTER_OUTLIERS ? mean : null;
}

function offLevel(frame: GrayFrame, axis: "row" | "column", line: number, from: number, to: number, level: number): number {
  let off = 0;
  for (let at = from; at < to; at++) if (Math.abs(pixel(frame, axis, line, at) - level) > GUTTER_TOLERANCE) off++;
  return off;
}

/** Whether the line from `from` to `to` (exclusive) is gutter: almost every pixel at the gutter `level`. */
function isGutter(frame: GrayFrame, axis: "row" | "column", line: number, from: number, to: number, level: number): boolean {
  return offLevel(frame, axis, line, from, to, level) <= (to - from) * GUTTER_OUTLIERS;
}

/**
 * Candidate brightness levels of the gutters, most lines first: the levels
 * that flat full-width rows and full-height columns share (within the
 * tolerance), each averaged, at most {@link GUTTER_CANDIDATES}. Empty when
 * the frame has no flat full-length line, so no gutter.
 */
export function gutterLevels(frame: GrayFrame): number[] {
  let levels: number[] = [];
  for (let y = 0; y < frame.height; y++) {
    const level = lineLevel(frame, "row", y, 0, frame.width);
    if (level !== null) levels.push(level);
  }
  for (let x = 0; x < frame.width; x++) {
    const level = lineLevel(frame, "column", x, 0, frame.height);
    if (level !== null) levels.push(level);
  }
  const out: number[] = [];
  while (levels.length > 0 && out.length < GUTTER_CANDIDATES) {
    let best = 0;
    let bestCount = -1;
    for (let v = 0; v <= 255; v++) {
      let count = 0;
      for (const level of levels) if (Math.abs(level - v) <= GUTTER_TOLERANCE / 2) count++;
      if (count > bestCount) {
        best = v;
        bestCount = count;
      }
    }
    const near = levels.filter((level) => Math.abs(level - best) <= GUTTER_TOLERANCE / 2);
    out.push(near.reduce((sum, level) => sum + level, 0) / near.length);
    levels = levels.filter((level) => Math.abs(level - best) > GUTTER_TOLERANCE / 2);
  }
  return out;
}

/** `rect` without its gutter-coloured border lines; null when nothing else is left. */
function trim(frame: GrayFrame, rect: TileRect, level: number): TileRect | null {
  let { x0, y0, x1, y1 } = rect;
  for (let changed = true; changed && x0 < x1 && y0 < y1; ) {
    const before = [x0, y0, x1, y1].join();
    while (y0 < y1 && isGutter(frame, "row", y0, x0, x1, level)) y0++;
    while (y1 > y0 && isGutter(frame, "row", y1 - 1, x0, x1, level)) y1--;
    while (x0 < x1 && y0 < y1 && isGutter(frame, "column", x0, y0, y1, level)) x0++;
    while (x1 > x0 && y0 < y1 && isGutter(frame, "column", x1 - 1, y0, y1, level)) x1--;
    changed = [x0, y0, x1, y1].join() !== before;
  }
  return x0 < x1 && y0 < y1 ? { x0, y0, x1, y1 } : null;
}

/** Pieces of a trimmed `rect` between its interior gutter lines along `axis`; one piece when there are none. */
function pieces(frame: GrayFrame, rect: TileRect, axis: "row" | "column", level: number): TileRect[] {
  const [from, to] = axis === "row" ? [rect.y0, rect.y1] : [rect.x0, rect.x1];
  const [across0, across1] = axis === "row" ? [rect.x0, rect.x1] : [rect.y0, rect.y1];
  const out: TileRect[] = [];
  let start = from;
  for (let line = from; line <= to; line++) {
    const gutter = line < to && isGutter(frame, axis, line, across0, across1, level);
    if (!gutter && line < to) continue;
    if (line > start) out.push(axis === "row" ? { ...rect, y0: start, y1: line } : { ...rect, x0: start, x1: line });
    start = line + 1;
  }
  return out;
}

/**
 * Tiles of one gallery frame in reading order (rows top to bottom, each left
 * to right), in frame pixels: the cut at whichever candidate gutter level
 * ({@link gutterLevels}) gives the most tiles; flat bands inside the pictures
 * can outnumber thin gutters. Pieces smaller than {@link MIN_TILE_FRACTION}
 * of the frame are dropped. Empty when the frame has no gutter.
 */
export function detectTiles(frame: GrayFrame): TileRect[] {
  let best: TileRect[] = [];
  for (const level of gutterLevels(frame)) {
    const tiles = cutTiles(frame, level);
    if (tiles.length > best.length) best = tiles;
  }
  return readingOrder(best, frame.height);
}

/** Recursive XY cut of `frame` at gutters of brightness `level`. */
function cutTiles(frame: GrayFrame, level: number): TileRect[] {
  const minWidth = Math.max(2, Math.round(frame.width * MIN_TILE_FRACTION));
  const minHeight = Math.max(2, Math.round(frame.height * MIN_TILE_FRACTION));
  const tiles: TileRect[] = [];
  const visit = (rect: TileRect, depth: number): void => {
    const trimmed = trim(frame, rect, level);
    if (!trimmed || trimmed.x1 - trimmed.x0 < minWidth || trimmed.y1 - trimmed.y0 < minHeight) return;
    if (depth < MAX_DEPTH) {
      for (const axis of ["row", "column"] as const) {
        const parts = pieces(frame, trimmed, axis, level);
        if (parts.length > 1) {
          for (const part of parts) visit(part, depth + 1);
          return;
        }
      }
    }
    tiles.push(trimmed);
  };
  visit({ x0: 0, y0: 0, x1: frame.width, y1: frame.height }, 0);
  return tiles;
}

/** Tiles sorted into rows (tops within the match tolerance), each row left to right. */
function readingOrder(tiles: TileRect[], height: number): TileRect[] {
  const tolerance = height * TILE_MATCH_FRACTION;
  const byTop = [...tiles].sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
  const rows: TileRect[][] = [];
  for (const tile of byTop) {
    const row = rows.at(-1);
    if (row && tile.y0 - row[0]!.y0 <= tolerance) row.push(tile);
    else rows.push([tile]);
  }
  return rows.flatMap((row) => row.sort((a, b) => a.x0 - b.x0));
}

function sameTile(a: TileRect, b: TileRect, width: number, height: number): boolean {
  const tx = width * TILE_MATCH_FRACTION;
  const ty = height * TILE_MATCH_FRACTION;
  return Math.abs(a.x0 - b.x0) <= tx && Math.abs(a.x1 - b.x1) <= tx && Math.abs(a.y0 - b.y0) <= ty && Math.abs(a.y1 - b.y1) <= ty;
}

function sameLayout(a: readonly TileRect[], b: readonly TileRect[], width: number, height: number): boolean {
  return a.length === b.length && a.every((tile, i) => sameTile(tile, b[i]!, width, height));
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}

const seconds = (value: number) => Math.round(value * 1000) / 1000;

/**
 * Group per-sample tiles into layouts and stretches of the file. A sample
 * joins the first layout whose first sample had the same tiles (every edge
 * within {@link TILE_MATCH_FRACTION}); a layout found in fewer than
 * {@link MIN_LAYOUT_SAMPLES} samples is no grid, and runs shorter than that
 * join the run before them (the run after, at the start). A layout's tiles are the median edges of its samples; a
 * tile's confidence is the share of the samples in the layout's stretches
 * that found it, times how close its area is to the median tile area.
 */
export function galleryLayouts(
  samples: readonly GallerySample[],
  size: { width: number; height: number },
  interval: number,
  duration: number,
): GalleryAnalysis {
  const { width, height } = size;
  const refs: TileRect[][] = [];
  const ids = samples.map(({ tiles }) => {
    if (tiles.length < 2) return -1;
    const found = refs.findIndex((ref) => sameLayout(ref, tiles, width, height));
    if (found >= 0) return found;
    refs.push(tiles);
    return refs.length - 1;
  });
  // Gutters stay put: tiles seen in fewer samples than that are lines in the pictures, not a grid.
  const seen = new Map<number, number>();
  for (const id of ids) seen.set(id, (seen.get(id) ?? 0) + 1);
  const need = Math.min(MIN_LAYOUT_SAMPLES, samples.length);
  ids.forEach((id, i) => {
    if (id >= 0 && seen.get(id)! < need) ids[i] = -1;
  });

  let runs: { id: number; from: number; to: number }[] = [];
  ids.forEach((id, i) => {
    const last = runs.at(-1);
    if (last && last.id === id) last.to = i + 1;
    else runs.push({ id, from: i, to: i + 1 });
  });
  for (;;) {
    if (runs.length < 2) break;
    let shortest = -1;
    runs.forEach((run, i) => {
      const length = run.to - run.from;
      if (length < MIN_LAYOUT_SAMPLES && (shortest < 0 || length < runs[shortest]!.to - runs[shortest]!.from)) shortest = i;
    });
    if (shortest < 0) break;
    const into = shortest > 0 ? shortest - 1 : 1;
    runs[shortest]!.id = runs[into]!.id;
    const merged: typeof runs = [];
    for (const run of runs) {
      const last = merged.at(-1);
      if (last && last.id === run.id) last.to = run.to;
      else merged.push({ ...run });
    }
    runs = merged;
  }

  // Layouts that survived, renumbered in order of first appearance.
  const index = new Map<number, number>();
  for (const run of runs) if (run.id >= 0 && !index.has(run.id)) index.set(run.id, index.size);
  const stretches: GalleryStretch[] = runs.map((run, i) => {
    const start = run.from * interval;
    const next = runs[i + 1];
    return { start: seconds(start), end: seconds(next ? next.from * interval : Math.max(duration, start)), layout: run.id >= 0 ? index.get(run.id)! : null };
  });
  const layouts: GalleryLayout[] = [...index.keys()].map((id) => {
    const own = runs.filter((run) => run.id === id);
    const inside = own.flatMap((run) => samples.slice(run.from, run.to));
    const members = own.flatMap((run) => ids.slice(run.from, run.to).flatMap((sampleId, k) => (sampleId === id ? [samples[run.from + k]!] : [])));
    const rects = refs[id]!.map((_, t) => ({
      x0: median(members.map((sample) => sample.tiles[t]!.x0)),
      y0: median(members.map((sample) => sample.tiles[t]!.y0)),
      x1: median(members.map((sample) => sample.tiles[t]!.x1)),
      y1: median(members.map((sample) => sample.tiles[t]!.y1)),
    }));
    const areas = rects.map((rect) => (rect.x1 - rect.x0) * (rect.y1 - rect.y0));
    const typical = median(areas);
    const tiles = rects.map((rect, t) => {
      const found = inside.filter((sample) => sample.tiles.some((tile) => sameTile(tile, rect, width, height))).length;
      const sizeFit = Math.min(areas[t]! / typical, typical / areas[t]!);
      return { ...rect, confidence: Math.round((found / inside.length) * sizeFit * 100) / 100 };
    });
    const held = stretches.filter((stretch) => stretch.layout === index.get(id)).reduce((sum, stretch) => sum + stretch.end - stretch.start, 0);
    return { tiles, duration: seconds(held) };
  });
  return { width, height, interval, samples: samples.length, layouts, stretches };
}

/**
 * Tiles of every sampled frame of absolute `path` (first video stream, one
 * frame every `interval` s, scaled to `size` and gray). Throws when ffmpeg
 * cannot decode it.
 */
export async function sampleGallery(
  ffmpeg: string,
  path: string,
  size: { width: number; height: number },
  interval: number,
): Promise<GallerySample[]> {
  const frameBytes = size.width * size.height;
  const tenths = Math.round(interval * 10);
  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-nostdin",
    "-i",
    path,
    "-map",
    "0:v:0",
    "-an",
    "-vf",
    `fps=10/${tenths},scale=${size.width}:${size.height}:flags=area,format=gray`,
    "-f",
    "rawvideo",
    "-",
  ];
  return new Promise<GallerySample[]>((resolve, reject) => {
    const child = spawn(ffmpeg, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const samples: GallerySample[] = [];
    let pending: Buffer = Buffer.alloc(0);
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => (stderr = (stderr + chunk).slice(-4000)));
    child.stdout.on("data", (chunk: Buffer) => {
      pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
      let at = 0;
      for (; at + frameBytes <= pending.length; at += frameBytes) {
        const data = Uint8Array.from(pending.subarray(at, at + frameBytes));
        samples.push({ time: seconds((samples.length * tenths) / 10), tiles: detectTiles({ ...size, data }) });
      }
      pending = pending.subarray(at);
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve(samples);
      else reject(new Error(`ffmpeg could not read the picture of ${path} (exit ${code}): ${stderr.trim()}`));
    });
  });
}

/** Tile grids of absolute `path`, a `width`×`height` picture of `duration` s, sampled across the whole file. */
export async function analyseGallery(
  ffmpeg: string,
  path: string,
  picture: { width: number; height: number; duration: number },
): Promise<GalleryAnalysis> {
  const size = galleryFrameSize(picture.width, picture.height);
  const interval = galleryInterval(picture.duration);
  const samples = await sampleGallery(ffmpeg, path, size, interval);
  return galleryLayouts(samples, size, interval, picture.duration);
}

/** Crop fractions (4 decimals) that keep `tile` of a `width`×`height` frame; sides that keep the edge are left out. */
export function tileCrop(tile: TileRect, width: number, height: number): AngleCrop {
  const fraction = (pixels: number, of: number) => Math.round((pixels / of) * 10000) / 10000;
  const sides = { left: fraction(tile.x0, width), top: fraction(tile.y0, height), right: fraction(width - tile.x1, width), bottom: fraction(height - tile.y1, height) };
  return Object.fromEntries(Object.entries(sides).filter(([, value]) => value > 0));
}
