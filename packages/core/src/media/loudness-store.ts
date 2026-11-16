import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ErrorCode, RpcError } from "@frameshell/protocol";
import { z } from "zod";
import { type LoudnessReading, type SoundRange, measureLoudness } from "../analyze/loudness.js";
import { writeJsonAtomic } from "../fs-util.js";
import type { GcClass } from "../gc.js";

/** Project-relative cache directory of per-asset loudness readings (regenerable). */
export const LOUDNESS_DIR = ".frameshell/loudness";
/** Bump when the measurement changes: it is part of the cache file name. */
const LOUDNESS_VERSION = 1;
/** Readings kept in memory per store: a few bytes each. */
const MEMORY_ENTRIES = 256;
/** Shortest part measured on its own, seconds: one 400 ms gating block of EBU R128; anything shorter reads as silence. */
export const MIN_RANGE_SECONDS = 0.4;
/** A range this close to the start and end of the file is the whole file (seconds): one reading, not two. */
const WHOLE_FILE_TOLERANCE = 0.05;

/** Cache key of the reading of content `hash` (`sha256:<hex>`): its file is `<key>.json` in {@link LOUDNESS_DIR}. */
export function loudnessCacheKey(hash: string): string {
  return `${hash.replace(/^sha256:/, "").slice(0, 20)}-l${LOUDNESS_VERSION}`;
}

/** File name stem of the reading of milliseconds `startMs` to `endMs` of the content with cache key `key`. */
const rangeStem = (key: string, startMs: number, endMs: number) => `${key}-r${startMs}-${endMs}`;

/** `<hash>-l<version>` of a whole-file reading, then `-r<start ms>-<end ms>` for a part of it. */
const READING_FILE = /^([0-9a-f]{20}-l\d+)(?:-r\d+-\d+)?\.json$/;
/** Atomic-write temps of readings (`writeJsonAtomic`). */
const LOUDNESS_TEMP = /^[0-9a-f]{20}-l\d+(?:-r\d+-\d+)?\.json\..+\.tmp$/;

/**
 * What an entry of {@link LOUDNESS_DIR} is, for `gc`: a reading, whole or of a part, keyed by its content's
 * {@link loudnessCacheKey} (an older version never matches a current key), a temp, or null (not ours: kept).
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
  /** Seconds of the sound of an asset, null when unknown: a part that spans all of it reads as the whole file. */
  duration?(root: string, rel: string): Promise<number | null>;
}

/**
 * EBU R128 loudness of assets (integrated LUFS, range, true peak), cached by content hash in {@link LOUDNESS_DIR}
 * (ADR 0037 slice 3). A reading is of the asset's own sound on the source clock, whole or of a part of it (the seconds a
 * clip plays, `SoundRange`): clip gain and speed are not in it, callers add what they know. A part is cached beside the
 * whole file by its hash and its start and end in milliseconds, so the same part is measured once; one that spans the
 * whole file or is shorter than a gating block ({@link MIN_RANGE_SECONDS}) is the whole-file reading. Measured by the
 * managed ffmpeg's `ebur128` ({@link measureLoudness}, the one the reference analysis uses); `music.candidates` and
 * `duck --level` read it, and sound placement (#463) will.
 */
export class LoudnessStore {
  readonly #options: LoudnessStoreOptions;
  readonly #memory = new Map<string, Promise<LoudnessReading>>();

  constructor(options: LoudnessStoreOptions) {
    this.#options = options;
  }

  /**
   * Loudness of project-relative `rel`, over `range` (seconds of the file) when given. `integrated` is null for
   * silence. Throws InvalidOperation when the file has no sound (a still image), the `Binary*` errors when ffmpeg cannot
   * be fetched, and ffmpeg's own error when the file cannot be decoded.
   */
  async reading(root: string, rel: string, range?: SoundRange): Promise<LoudnessReading> {
    const { hash } = await this.#options.derivedAudio(root, rel);
    const part = range ? await this.#part(root, rel, range) : null;
    const stem = part ? rangeStem(loudnessCacheKey(hash), part.startMs, part.endMs) : loudnessCacheKey(hash);
    const key = `${root}\0${stem}`;
    let reading = this.#memory.get(key);
    if (!reading) {
      reading = this.#load(root, rel, stem, part);
      this.#memory.set(key, reading);
      reading.catch(() => this.#memory.delete(key));
      if (this.#memory.size > MEMORY_ENTRIES) this.#memory.delete(this.#memory.keys().next().value!);
    }
    return reading;
  }

  /** `range` in whole milliseconds, or null when the whole file is what to read. */
  async #part(root: string, rel: string, range: SoundRange): Promise<{ startMs: number; endMs: number } | null> {
    const start = Math.max(0, range.start);
    if (!(range.end - start >= MIN_RANGE_SECONDS)) return null;
    const duration = await this.#options.duration?.(root, rel).catch(() => null);
    if (duration != null && start <= WHOLE_FILE_TOLERANCE && range.end >= duration - WHOLE_FILE_TOLERANCE) return null;
    return { startMs: Math.round(start * 1000), endMs: Math.round(range.end * 1000) };
  }

  async #load(root: string, rel: string, stem: string, part: { startMs: number; endMs: number } | null): Promise<LoudnessReading> {
    const cache = join(root, ...LOUDNESS_DIR.split("/"), `${stem}.json`);
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
    const measured = await measureLoudness(
      await this.#options.ffmpeg(root),
      join(root, ...rel.split("/")),
      undefined,
      undefined,
      part ? { start: part.startMs / 1000, end: part.endMs / 1000 } : undefined,
    );
    if (!measured) {
      throw new RpcError(ErrorCode.InvalidOperation, `${rel} has no sound to measure.`, { reason: "no audio", asset: rel });
    }
    await writeJsonAtomic(cache, { version: LOUDNESS_VERSION, ...measured });
    return measured;
  }
}
