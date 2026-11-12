import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { SUBTITLE_FONT } from "@frameshell/schema";
import { assColor, assDocument, assTime } from "../export/ass.js";
import { FONTS_DIR } from "../export/compiler.js";
import { writeFonts } from "../export/fonts.js";
import { runTool } from "../media/ffmpeg.js";

// Tile frames into one labelled sheet with the managed ffmpeg. Shared by `review` and #471 `analyze`.

/** Pixels between tiles and around the sheet. */
export const SHEET_GAP = 2;

/** One tile of a sheet: a PNG and the text drawn in its top-left corner. */
export interface SheetTile {
  /** Absolute path of the frame (any size; it is scaled to the tile). */
  path: string;
  label: string;
}

/** Where and how {@link writeSheet} tiles. */
export interface SheetOptions {
  /** Absolute PNG to write. */
  out: string;
  /** Tiles per row at most; fewer when there are fewer tiles. */
  columns: number;
  /** Size of one tile, px. */
  tile: { width: number; height: number };
  /** Absolute scratch folder, created and removed here. */
  scratch: string;
  /** Zones to shade red on every tile, as fractions (0 to 1) of the frame's height (top, bottom) or width (left, right). */
  shade?: ShadeFractions;
  signal?: AbortSignal;
}

/** How much of each edge of a frame is shaded; see {@link SheetOptions.shade}. */
export interface ShadeFractions {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** Size of the image {@link writeSheet} wrote. */
export interface SheetSize {
  width: number;
  height: number;
  columns: number;
  rows: number;
}

/**
 * Write `tiles` as one image: scaled to `options.tile`, the label burned in with the bundled subtitle face (the
 * `ass` filter every export uses, so it works wherever export does), laid out left to right then top to bottom.
 * Rejects with ffmpeg's error. At least one tile.
 */
export async function writeSheet(ffmpeg: string, tiles: readonly SheetTile[], options: SheetOptions): Promise<SheetSize> {
  const { out, tile, scratch } = options;
  const columns = Math.min(options.columns, tiles.length);
  const rows = Math.ceil(tiles.length / columns);
  await mkdir(scratch, { recursive: true });
  try {
    await writeFonts(scratch, [SUBTITLE_FONT.file]);
    await writeFile(join(scratch, "labels.ass"), labelScript(tiles, tile));
    for (const [i, { path }] of tiles.entries()) await copyFile(path, join(scratch, `t${String(i + 1).padStart(4, "0")}.png`));
    await mkdir(dirname(out), { recursive: true });
    await runTool(
      ffmpeg,
      [
        ...["-hide_banner", "-loglevel", "error", "-nostdin", "-y"],
        ...["-framerate", "1", "-i", "t%04d.png"],
        ...["-vf", `scale=${tile.width}:${tile.height}:flags=area${shadeFilters(tile, options.shade)},ass=filename=labels.ass:fontsdir=${FONTS_DIR},tile=${columns}x${rows}:padding=${SHEET_GAP}:margin=${SHEET_GAP}:color=0x202020`],
        ...["-frames:v", "1", out],
      ],
      { cwd: scratch, ...(options.signal ? { signal: options.signal } : {}) },
    );
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
  return { width: columns * (tile.width + SHEET_GAP) + SHEET_GAP, height: rows * (tile.height + SHEET_GAP) + SHEET_GAP, columns, rows };
}

/** `drawbox` filters (each led by a comma) that shade the zones of `shade` red and outline their inner edge; none without `shade`. */
export function shadeFilters(tile: { width: number; height: number }, shade: ShadeFractions | undefined): string {
  if (!shade) return "";
  const { width, height } = tile;
  const top = Math.round(shade.top * height);
  const bottom = Math.round(shade.bottom * height);
  const left = Math.round(shade.left * width);
  const right = Math.round(shade.right * width);
  const zones = [
    { size: top, x: 0, y: 0, w: width, h: top },
    { size: bottom, x: 0, y: height - bottom, w: width, h: bottom },
    { size: left, x: 0, y: 0, w: left, h: height },
    { size: right, x: width - right, y: 0, w: right, h: height },
  ];
  return zones
    .filter(({ size }) => size > 0)
    .map(({ x, y, w, h }) => `,drawbox=x=${x}:y=${y}:w=${w}:h=${h}:color=red@0.3:t=fill,drawbox=x=${x}:y=${y}:w=${w}:h=${h}:color=red@0.9:t=2`)
    .join("");
}

/** ASS script showing label `i` during second `i` of the tile sequence, which `-framerate 1` plays one frame per second. */
function labelScript(tiles: readonly SheetTile[], tile: { width: number; height: number }): string {
  // Also bounded by the width: a narrow tall tile of a vertical film would otherwise clip a flagged label.
  const size = Math.max(10, Math.round(Math.min(tile.height * 0.075, tile.width * 0.06)));
  const style = [
    "Style: label",
    SUBTITLE_FONT.family,
    size * (SUBTITLE_FONT.ascent + SUBTITLE_FONT.descent),
    assColor("#ffffff"),
    assColor("#ffffff"),
    assColor("#000000"),
    assColor("#000000"),
    "0,0,0,0,100,100,0,0,1",
    Math.max(1, Math.round(size / 8)),
    // Shadow 0, top-left (\an7), left, right, top margins, encoding.
    "0,7,6,0,4,1",
  ].join(",");
  const events = tiles.map(({ label }, i) => `Dialogue: 0,${assTime(i * 100)},${assTime((i + 1) * 100)},label,,0,0,0,,${label.replace(/[{}\\]/g, "")}`);
  return assDocument(tile, [style], events);
}
