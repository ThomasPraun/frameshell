import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ReviewSheet } from "@frameshell/protocol";
import { pool } from "../export/service.js";
import { runTool } from "../media/ffmpeg.js";
import { readRawFrames } from "../media/raw-frames.js";
import { encodeRgbPng } from "../segment/png.js";
import { type CropRect, type FramePick, type SheetLayout, frameTime, splitImages, tileHeight, tileLabel } from "./plan.js";
import { DIFFERENCE_GAIN, type ShadeFractions, writeDifference, writeSheet } from "./sheet.js";
import { type FilmSource, captureParallelism } from "./source.js";

// From picked frames to labelled sheet images. Shared by `review` and #471 `analyze`.

/** Frames of a source captured once into `dir`, whichever sheet asks for them. */
export class Frames {
  readonly #have = new Set<number>();
  readonly #source: Pick<FilmSource, "capture">;
  readonly #dir: string;

  constructor(source: Pick<FilmSource, "capture">, dir: string) {
    this.#source = source;
    this.#dir = dir;
  }

  /** Absolute path the PNG of `frame` is (or will be) captured to. */
  path(frame: number): string {
    return join(this.#dir, `f${String(frame).padStart(7, "0")}.png`);
  }

  /** Capture the frames not captured yet, a few at a time. */
  async ensure(frames: readonly number[], signal?: AbortSignal): Promise<void> {
    await mkdir(this.#dir, { recursive: true });
    const missing = [...new Set(frames)].filter((frame) => !this.#have.has(frame));
    await pool(missing, captureParallelism(), async (frame) => {
      signal?.throwIfAborted();
      await this.#source.capture(frame, this.path(frame));
      this.#have.add(frame);
    });
  }
}

/** One image written by {@link writeSheetImages}: a sheet without the kind the caller gives it. */
export type SheetImage = Omit<ReviewSheet, "kind">;

/** What {@link writeSheetImages} tiles and where it writes. */
export interface SheetImagesOptions {
  ffmpeg: string;
  /** Frame rate of the film the picks index. */
  fps: number;
  /** Width over height of its picture. */
  aspect: number;
  frames: Frames;
  layout: SheetLayout;
  picks: readonly FramePick[];
  /** Absolute folder the PNGs are written to. */
  dir: string;
  /** File name without extension: `<stem>.png`, or `<stem>-<i>.png` when several images or `numbered`. */
  stem: string;
  numbered?: boolean;
  /** Absolute scratch folder, a subfolder per image is created and removed inside it. */
  scratch: string;
  /** Text of a tile; default {@link tileLabel} of the frame's time and tag. */
  label?: (pick: FramePick, at: number) => string;
  /** Zones shaded on every tile; see `SheetOptions.shade`. */
  shade?: ShadeFractions | undefined;
  /** What is wrong with a frame (`subtitle`…): marked `!name` on its tile and listed in the tile's `flags`. */
  flags?: (pick: FramePick, at: number) => string[];
  /** The part of a frame its tile shows (film pixels), cropped from the captured frame before it is scaled; null or absent: the whole frame. */
  crop?: ((pick: FramePick, at: number) => CropRect | null) | undefined;
  signal?: AbortSignal | undefined;
}

/** Crop each frame of `frames` that `crops` names into `dir` (one ffmpeg each, a few at a time); the paths to tile, by frame. */
async function croppedFrames(ffmpeg: string, frames: Frames, crops: ReadonlyMap<number, CropRect>, dir: string, signal?: AbortSignal): Promise<Map<number, string>> {
  await mkdir(dir, { recursive: true });
  const paths = new Map<number, string>();
  await pool([...crops], captureParallelism(), async ([frame, { x, y, width, height }]) => {
    signal?.throwIfAborted();
    const out = join(dir, `c${String(frame).padStart(7, "0")}.png`);
    await runTool(ffmpeg, ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-i", frames.path(frame), "-vf", `crop=${width}:${height}:${x}:${y}`, "-frames:v", "1", out], signal ? { signal } : {});
    paths.set(frame, out);
  });
  return paths;
}

/** The frames of `picks` captured (see {@link Frames}) and, where `crop` names a part, cropped into `cropDir`: the PNG of each frame and its crop. */
async function pickedFrames(
  options: Pick<SheetImagesOptions, "ffmpeg" | "fps" | "frames" | "crop" | "signal">,
  picks: readonly FramePick[],
  cropDir: string,
): Promise<{ path: (frame: number) => string; crops: Map<number, CropRect> }> {
  const { ffmpeg, fps, frames, signal } = options;
  await frames.ensure(picks.map((pick) => pick.frame), signal);
  const crops = new Map<number, CropRect>();
  for (const pick of picks) {
    const crop = options.crop?.(pick, frameTime(pick.frame, fps));
    if (crop) crops.set(pick.frame, crop);
  }
  const cropped = crops.size > 0 ? await croppedFrames(ffmpeg, frames, crops, cropDir, signal) : new Map<number, string>();
  return { path: (frame) => cropped.get(frame) ?? frames.path(frame), crops };
}

/**
 * Capture the frames of `picks` (once per film, see {@link Frames}) and tile them into images of `layout.perImage`
 * tiles, in pick order.
 */
export async function writeSheetImages(options: SheetImagesOptions): Promise<SheetImage[]> {
  const { ffmpeg, fps, aspect, layout, picks, dir, stem, signal } = options;
  const named = options.label ?? ((pick: FramePick, at: number) => tileLabel(at, pick.tag));
  const flagsOf = (pick: FramePick, at: number) => options.flags?.(pick, at) ?? [];
  const label = (pick: FramePick, at: number) => [named(pick, at), ...flagsOf(pick, at).map((flag) => `!${flag}`)].join(" ");
  const tile = { width: layout.tileWidth, height: tileHeight(layout.tileWidth, aspect) };
  const parts = splitImages(picks, layout.perImage);
  const cropDir = join(options.scratch, `crop-${stem}`);
  try {
    const { path: framePath, crops } = await pickedFrames(options, picks, cropDir);
    const images: SheetImage[] = [];
    for (const [i, part] of parts.entries()) {
      const path = join(dir, parts.length === 1 && !options.numbered ? `${stem}.png` : `${stem}-${i + 1}.png`);
      const labelled = part.map((pick) => ({ pick, at: frameTime(pick.frame, fps) }));
      const size = await writeSheet(
        ffmpeg,
        labelled.map(({ pick, at }) => ({ path: framePath(pick.frame), label: label(pick, at) })),
        { out: path, columns: layout.columns, tile, scratch: join(options.scratch, `sheet-${stem}-${i}`), ...(options.shade ? { shade: options.shade } : {}), ...(signal ? { signal } : {}) },
      );
      images.push({
        path,
        width: size.width,
        height: size.height,
        columns: size.columns,
        rows: size.rows,
        tile,
        tiles: labelled.map(({ pick, at }, t) => ({
          at,
          frame: pick.frame,
          tag: pick.tag,
          label: label(pick, at),
          ...(flagsOf(pick, at).length > 0 ? { flags: flagsOf(pick, at) } : {}),
          ...(crops.has(pick.frame) ? { crop: crops.get(pick.frame)! } : {}),
          row: Math.floor(t / size.columns),
          column: t % size.columns,
        })),
      });
    }
    return images;
  } finally {
    await rm(cropDir, { recursive: true, force: true });
  }
}

/** What the per-clip kit sheets (`pop`, `onion`) share with {@link writeSheetImages}. */
export type KitSheetOptions = Pick<SheetImagesOptions, "ffmpeg" | "fps" | "aspect" | "frames" | "layout" | "dir" | "scratch" | "crop" | "signal">;

/**
 * The `pop` sheet, `pop.png`: the frame before and the frame of a pop side by side, then their difference amplified
 * {@link DIFFERENCE_GAIN} times (black where nothing changed), each cropped like the run's other tiles.
 */
export async function writePopSheet(options: KitSheetOptions & { picks: readonly [FramePick, FramePick] }): Promise<SheetImage> {
  const { ffmpeg, fps, aspect, layout, dir, picks, signal } = options;
  const work = join(options.scratch, "pop");
  await mkdir(work, { recursive: true });
  try {
    const { path, crops } = await pickedFrames(options, picks, join(work, "crop"));
    const [before, after] = picks;
    const difference = join(work, "difference.png");
    await writeDifference(ffmpeg, path(before.frame), path(after.frame), difference, signal);
    const at = (pick: FramePick) => frameTime(pick.frame, fps);
    const tiles = [
      { pick: before, path: path(before.frame), label: tileLabel(at(before), "pop", "frame before") },
      { pick: after, path: path(after.frame), label: tileLabel(at(after), "pop", "frame") },
      { pick: after, path: difference, label: tileLabel(at(after), "pop", `difference x${DIFFERENCE_GAIN}`) },
    ];
    const tile = { width: layout.tileWidth, height: tileHeight(layout.tileWidth, aspect) };
    const out = join(dir, "pop.png");
    const size = await writeSheet(ffmpeg, tiles, { out, columns: layout.columns, tile, scratch: join(work, "sheet"), ...(signal ? { signal } : {}) });
    return {
      path: out,
      width: size.width,
      height: size.height,
      columns: size.columns,
      rows: size.rows,
      tile,
      tiles: tiles.map(({ pick, label }, i) => ({
        at: at(pick),
        frame: pick.frame,
        tag: pick.tag,
        label,
        ...(crops.has(pick.frame) ? { crop: crops.get(pick.frame)! } : {}),
        row: Math.floor(i / size.columns),
        column: i % size.columns,
      })),
    };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/** Opacity each moving part of a frame is laid over the still background of the `onion` image with. */
export const ONION_OPACITY = 0.25;
/** Levels (0 to 255) a channel of a pixel must differ from the background by for the pixel to be part of what moves. */
export const ONION_CHANGE = 16;

/**
 * The onion skin of RGB `frames` (one size, at least one): the still background (per channel, the median of the
 * frames), then, in order, every pixel of each frame that differs from it laid over at {@link ONION_OPACITY}.
 */
export function onionBlend(frames: readonly Uint8Array[]): Uint8Array {
  const count = frames.length;
  const size = frames[0]!.length;
  const background = new Uint8Array(size);
  const column = new Uint8Array(count);
  for (let c = 0; c < size; c++) {
    // Insertion sort: a column is at most a couple of dozen values.
    for (let k = 0; k < count; k++) {
      const value = frames[k]![c]!;
      let m = k;
      while (m > 0 && column[m - 1]! > value) {
        column[m] = column[m - 1]!;
        m--;
      }
      column[m] = value;
    }
    background[c] = column[count >> 1]!;
  }
  const out = Float32Array.from(background);
  for (const frame of frames) {
    for (let p = 0; p < size; p += 3) {
      const change = Math.max(Math.abs(frame[p]! - background[p]!), Math.abs(frame[p + 1]! - background[p + 1]!), Math.abs(frame[p + 2]! - background[p + 2]!));
      if (change <= ONION_CHANGE) continue;
      for (let c = p; c < p + 3; c++) out[c] = out[c]! + ONION_OPACITY * (frame[c]! - out[c]!);
    }
  }
  return Uint8Array.from(out, (value) => Math.round(value));
}

/** The `onion` sheet, `onion.png`: the frames of `picks` blended by {@link onionBlend} into one tile labelled `label`. */
export async function writeOnionSheet(options: KitSheetOptions & { picks: readonly FramePick[]; label: string }): Promise<SheetImage> {
  const { ffmpeg, fps, aspect, layout, dir, picks, signal } = options;
  const work = join(options.scratch, "onion");
  await mkdir(join(work, "frames"), { recursive: true });
  try {
    const { path, crops } = await pickedFrames(options, picks, join(work, "crop"));
    for (const [i, pick] of picks.entries()) await copyFile(path(pick.frame), join(work, "frames", `o${String(i + 1).padStart(5, "0")}.png`));
    const tile = { width: layout.tileWidth, height: tileHeight(layout.tileWidth, aspect) };
    const bytes = tile.width * tile.height * 3;
    const decoded: Uint8Array[] = [];
    for await (const frame of readRawFrames(ffmpeg, join(work, "frames", "o%05d.png"), `scale=${tile.width}:${tile.height}:flags=area,format=rgb24`, bytes)) decoded.push(Uint8Array.from(frame));
    const blended = join(work, "onion.png");
    await writeFile(blended, encodeRgbPng(onionBlend(decoded), tile.width, tile.height));
    const out = join(dir, "onion.png");
    const size = await writeSheet(ffmpeg, [{ path: blended, label: options.label }], { out, columns: 1, tile, scratch: join(work, "sheet"), ...(signal ? { signal } : {}) });
    const first = picks[0]!;
    return {
      path: out,
      width: size.width,
      height: size.height,
      columns: 1,
      rows: 1,
      tile,
      tiles: [{ at: frameTime(first.frame, fps), frame: first.frame, tag: first.tag, label: options.label, ...(crops.has(first.frame) ? { crop: crops.get(first.frame)! } : {}), row: 0, column: 0 }],
    };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
