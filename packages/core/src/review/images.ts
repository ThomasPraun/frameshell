import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { ReviewSheet } from "@frameshell/protocol";
import { pool } from "../export/service.js";
import { type FramePick, type SheetLayout, frameTime, splitImages, tileHeight, tileLabel } from "./plan.js";
import { type ShadeFractions, writeSheet } from "./sheet.js";
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
  signal?: AbortSignal | undefined;
}

/**
 * Capture the frames of `picks` (once per film, see {@link Frames}) and tile them into images of `layout.perImage`
 * tiles, in pick order.
 */
export async function writeSheetImages(options: SheetImagesOptions): Promise<SheetImage[]> {
  const { ffmpeg, fps, aspect, frames, layout, picks, dir, stem, signal } = options;
  const named = options.label ?? ((pick: FramePick, at: number) => tileLabel(at, pick.tag));
  const flagsOf = (pick: FramePick, at: number) => options.flags?.(pick, at) ?? [];
  const label = (pick: FramePick, at: number) => [named(pick, at), ...flagsOf(pick, at).map((flag) => `!${flag}`)].join(" ");
  const tile = { width: layout.tileWidth, height: tileHeight(layout.tileWidth, aspect) };
  const parts = splitImages(picks, layout.perImage);
  await frames.ensure(picks.map((pick) => pick.frame), signal);
  const images: SheetImage[] = [];
  for (const [i, part] of parts.entries()) {
    const path = join(dir, parts.length === 1 && !options.numbered ? `${stem}.png` : `${stem}-${i + 1}.png`);
    const labelled = part.map((pick) => ({ pick, at: frameTime(pick.frame, fps) }));
    const size = await writeSheet(
      ffmpeg,
      labelled.map(({ pick, at }) => ({ path: frames.path(pick.frame), label: label(pick, at) })),
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
        row: Math.floor(t / size.columns),
        column: t % size.columns,
      })),
    });
  }
  return images;
}
