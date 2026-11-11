import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { exists, writeJsonAtomic } from "../fs-util.js";
import type { GcClass } from "../gc.js";
import { RECIPE_VERSION, fpsRational } from "../media/recipe.js";

/** Project-relative cache directory of subject mattes (regenerable, `gc`-swept). */
export const MATTES_DIR = ".frameshell/cache/mattes";

/** Bump when the refinement, the smoothing or the file layout changes: it is part of the cache key. */
export const MATTE_VERSION = 1;

/**
 * Cache key of the matte of content `hash` (`sha256:<hex>`) made by `model` (`<id>@<revision>`, or
 * `stand-in`) on the proxy grid of `fps`. Its files are `<key>.mp4` and `<key>.json` in {@link MATTES_DIR}.
 * The proxy recipe is in the key: a matte follows its proxy's frames and size.
 */
export function matteKey(hash: string, model: string, fps: number): string {
  const setup = createHash("sha256").update(`${model}\0${fpsRational(fps)}\0${RECIPE_VERSION}`).digest("hex").slice(0, 8);
  return `${hash.replace(/^sha256:/, "").slice(0, 20)}-m${MATTE_VERSION}-${setup}`;
}

const MATTE_FILE = /^([0-9a-f]{20}-m\d+-[0-9a-f]{8})\.(mp4|json)$/;
/** Encoder output before its rename (`.partial`), atomic-write temps (`.tmp`), the smoothing scratch file (`.coarse`). */
const MATTE_TEMP = /^[0-9a-f]{20}-m\d+-[0-9a-f]{8}\..+\.(partial|tmp|coarse)$/;

/**
 * What an entry of {@link MATTES_DIR} is, for `gc`: a file of the matte with cache key `key` (an older
 * version, model, fps or proxy recipe never matches a current key), a temp of an interrupted job, or null
 * (not ours: kept).
 */
export function classifyMatte(name: string, isDirectory: boolean): GcClass {
  if (isDirectory) return null;
  if (MATTE_TEMP.test(name)) return { kind: "temp", key: null };
  const key = MATTE_FILE.exec(name)?.[1];
  return key ? { kind: "matte", key } : null;
}

const MatteInfoSchema = z.object({
  version: z.literal(MATTE_VERSION),
  hash: z.string(),
  model: z.string(),
  fps: z.number().positive(),
  width: z.int().positive(),
  height: z.int().positive(),
  frames: z.int().nonnegative(),
  /** Seconds the job took to make it. */
  seconds: z.number().nonnegative(),
});

/** What `<key>.json` says about a finished matte. Written after the video: its presence marks it complete. */
export type MatteInfo = z.infer<typeof MatteInfoSchema>;

/** Project-relative paths of the matte with cache key `key`. */
export function mattePaths(key: string): { video: string; info: string } {
  return { video: `${MATTES_DIR}/${key}.mp4`, info: `${MATTES_DIR}/${key}.json` };
}

/**
 * The finished matte with cache key `key` of content `hash` under `root`, or null when there is none, its
 * record is damaged, or it is another content's (keys keep 20 hex digits of the hash).
 */
export async function readMatteInfo(root: string, key: string, hash: string): Promise<MatteInfo | null> {
  const { video, info } = mattePaths(key);
  const text = await readFile(join(root, ...info.split("/")), "utf8").catch(() => null);
  if (text === null) return null;
  let parsed: MatteInfo;
  try {
    parsed = MatteInfoSchema.parse(JSON.parse(text));
  } catch {
    return null;
  }
  if (parsed.hash !== hash) return null;
  // The record without its video (deleted by hand) is not a matte.
  return (await exists(join(root, ...video.split("/")))) ? parsed : null;
}

/** Mark the matte with cache key `key` complete: its video is in place already. */
export async function writeMatteInfo(root: string, key: string, info: MatteInfo): Promise<void> {
  await writeJsonAtomic(join(root, ...mattePaths(key).info.split("/")), info);
}
