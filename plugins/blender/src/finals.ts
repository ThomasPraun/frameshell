import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { STATE_DIR } from "./deps.js";

/**
 * Cycles seconds per frame and megapixel before any final has run on this machine. The #482 measurement (80 samples,
 * 1600x900, M4 Pro) is 6-7 s per frame, about 4.5 s per megapixel; rounded up because most machines are slower.
 */
export const DEFAULT_SECONDS_PER_MEGAPIXEL = 5;

/** Blender start-up, scene load and the VP9 encode of a final, on top of its frames (the measured rate leaves them out). */
const OVERHEAD_SECONDS = 10;

/** Project-relative file of measured final rates; under `.frameshell/`, never an input of a key. */
export const FINALS_FILE = `${STATE_DIR}/finals.json`;

/** What {@link FINALS_FILE} holds: seconds per frame and megapixel, last measured per .blend, and the last of any. */
interface Measured {
  sources: Record<string, number>;
  last: number | null;
}

/**
 * Times of Cycles finals on this machine (ADR 0035 decision 4): every final render records its seconds per frame and
 * megapixel for its .blend, and estimates use that .blend's last rate, else the project's last, else
 * {@link DEFAULT_SECONDS_PER_MEGAPIXEL}. The project's `.frameshell/` is per machine, like the render cache.
 */
export class FinalTimes {
  readonly #file: string;

  constructor(projectDir: string) {
    this.#file = resolve(projectDir, ...FINALS_FILE.split("/"));
  }

  /** Estimated seconds of a final of `frames` frames at `width` x `height` of the .blend `source` (project-relative). */
  async estimate(source: string, frames: number, width: number, height: number): Promise<number> {
    const measured = await this.#read();
    const rate = measured.sources[source] ?? measured.last ?? DEFAULT_SECONDS_PER_MEGAPIXEL;
    return OVERHEAD_SECONDS + frames * megapixels(width, height) * rate;
  }

  /** Records a finished final of `source`: `seconds` Blender spent rendering `frames` frames at `width` x `height`. */
  async record(source: string, seconds: number, frames: number, width: number, height: number): Promise<void> {
    const rate = seconds / (frames * megapixels(width, height));
    if (!Number.isFinite(rate) || rate <= 0) return;
    const measured = await this.#read();
    measured.sources[source] = Number(rate.toFixed(4));
    measured.last = measured.sources[source]!;
    await this.#write(measured);
  }

  /**
   * Drops the rates of .blend files not in `keep` (project-relative paths, the ones current clips use) and keeps `last`.
   * Does nothing for a file modified at or after `opts.keepNewerThan` (a final may be recording) or with nothing to drop.
   * Returns the bytes the file shrinks by (with `dryRun`, would shrink by, writing nothing), or null when it is left as it is.
   */
  async prune(keep: ReadonlySet<string>, opts: { dryRun: boolean; keepNewerThan: number }): Promise<{ bytes: number } | null> {
    const info = await stat(this.#file).catch(() => null);
    if (!info?.isFile() || info.mtimeMs >= opts.keepNewerThan) return null;
    const measured = await this.#read();
    const kept = Object.fromEntries(Object.entries(measured.sources).filter(([source]) => keep.has(source)));
    if (Object.keys(kept).length === Object.keys(measured.sources).length) return null;
    const next: Measured = { sources: kept, last: measured.last };
    const text = serialize(next);
    if (!opts.dryRun) await this.#write(next, text);
    return { bytes: Math.max(0, info.size - Buffer.byteLength(text)) };
  }

  async #write(measured: Measured, text = serialize(measured)): Promise<void> {
    await mkdir(join(this.#file, ".."), { recursive: true });
    const temp = `${this.#file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    await writeFile(temp, text);
    await rename(temp, this.#file);
  }

  async #read(): Promise<Measured> {
    try {
      const parsed = JSON.parse(await readFile(this.#file, "utf8")) as Partial<Measured>;
      const sources: Record<string, number> = {};
      for (const [source, rate] of Object.entries(parsed.sources ?? {})) if (typeof rate === "number" && rate > 0) sources[source] = rate;
      return { sources, last: typeof parsed.last === "number" && parsed.last > 0 ? parsed.last : null };
    } catch {
      return { sources: {}, last: null };
    }
  }
}

function serialize(measured: Measured): string {
  return `${JSON.stringify(measured, null, 2)}\n`;
}

function megapixels(width: number, height: number): number {
  return (width * height) / 1e6;
}
