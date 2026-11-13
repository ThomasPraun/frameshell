import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ErrorCode, RpcError } from "@frameshell/protocol";
import { z } from "zod";
import { type LoudnessReading, measureLoudness } from "../analyze/loudness.js";
import { writeJsonAtomic } from "../fs-util.js";
import type { GcClass } from "../gc.js";

/** Project-relative cache directory of per-asset loudness readings (regenerable). */
export const LOUDNESS_DIR = ".frameshell/loudness";
/** Bump when the measurement changes: it is part of the cache file name. */
const LOUDNESS_VERSION = 1;
/** Readings kept in memory per store: a few bytes each. */
const MEMORY_ENTRIES = 256;

/** Cache key of the reading of content `hash` (`sha256:<hex>`): its file is `<key>.json` in {@link LOUDNESS_DIR}. */
export function loudnessCacheKey(hash: string): string {
  return `${hash.replace(/^sha256:/, "").slice(0, 20)}-l${LOUDNESS_VERSION}`;
}

const READING_FILE = /^([0-9a-f]{20}-l\d+)\.json$/;
/** Atomic-write temps of readings (`writeJsonAtomic`). */
const LOUDNESS_TEMP = /^[0-9a-f]{20}-l\d+\.json\..+\.tmp$/;

/**
 * What an entry of {@link LOUDNESS_DIR} is, for `gc`: the reading with cache key `key` (an older version never matches a
 * current key), a temp, or null (not ours: kept).
 */
export function classifyLoudness(name: string, isDirectory: boolean): GcClass {
  if (isDirectory) return null;
  if (LOUDNESS_TEMP.test(name)) return { kind: "temp", key: null };
  const key = READING_FILE.exec(name)?.[1];
  return key ? { kind: "loudness", key } : null;
}

const ReadingFileSchema = z.object({
  version: z.literal(LOUDNESS_VERSION),
  integrated: z.number().nullable(),
  range: z.number().nullable(),
  truePeak: z.number().nullable(),
});

/** Options for {@link LoudnessStore}. */
export interface LoudnessStoreOptions {
  /** Content hash of an asset; see `MediaService.derivedAudio`. */
  derivedAudio(root: string, rel: string): Promise<{ hash: string }>;
  /** Managed or overridden ffmpeg for the project. */
  ffmpeg(root: string): Promise<string>;
}

/**
 * EBU R128 loudness of whole assets (integrated LUFS, range, true peak), cached by content hash in
 * {@link LOUDNESS_DIR} (ADR 0037 slice 3). One reading per asset, on the source clock with the asset's own sound:
 * clip gain, speed and the part a clip plays are not in it, callers add what they know. Measured by the managed
 * ffmpeg's `ebur128` ({@link measureLoudness}, the one the reference analysis uses); `music.candidates` and `duck --level`
 * read it, and sound placement (#463) will.
 */
export class LoudnessStore {
  readonly #options: LoudnessStoreOptions;
  readonly #memory = new Map<string, Promise<LoudnessReading>>();

  constructor(options: LoudnessStoreOptions) {
    this.#options = options;
  }

  /**
   * Loudness of project-relative `rel`. `integrated` is null for silence. Throws InvalidOperation when the file has
   * no sound (a still image), the `Binary*` errors when ffmpeg cannot be fetched, and ffmpeg's own error when the
   * file cannot be decoded.
   */
  async reading(root: string, rel: string): Promise<LoudnessReading> {
    const { hash } = await this.#options.derivedAudio(root, rel);
    const key = `${root}\0${hash}`;
    let reading = this.#memory.get(key);
    if (!reading) {
      reading = this.#load(root, rel, hash);
      this.#memory.set(key, reading);
      reading.catch(() => this.#memory.delete(key));
      if (this.#memory.size > MEMORY_ENTRIES) this.#memory.delete(this.#memory.keys().next().value!);
    }
    return reading;
  }

  async #load(root: string, rel: string, hash: string): Promise<LoudnessReading> {
    const cache = join(root, ...LOUDNESS_DIR.split("/"), `${loudnessCacheKey(hash)}.json`);
    const cached = await readFile(cache, "utf8").then(
      (text) => {
        try {
          return ReadingFileSchema.safeParse(JSON.parse(text));
        } catch {
          return null;
        }
      },
      () => null,
    );
    if (cached?.success) return { integrated: cached.data.integrated, range: cached.data.range, truePeak: cached.data.truePeak };
    const measured = await measureLoudness(await this.#options.ffmpeg(root), join(root, ...rel.split("/")));
    if (!measured) {
      throw new RpcError(ErrorCode.InvalidOperation, `${rel} has no sound to measure.`, { reason: "no audio", asset: rel });
    }
    await writeJsonAtomic(cache, { version: LOUDNESS_VERSION, ...measured });
    return measured;
  }
}
