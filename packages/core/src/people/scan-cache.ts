import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { FACE_DETECTION_MODEL, FACE_RECOGNITION_MODEL } from "../binaries/manifest.js";
import { writeTextAtomic } from "../fs-util.js";
import type { GcClass } from "../gc.js";
import { FACE_SAMPLE_HZ } from "../multicam/faces.js";
import { FACE_EMBEDDING_DIMS, type FaceTrack, type PeopleScanResult } from "./scan.js";

/** Project-relative cache directory of what `people.scan` and its successors derive (regenerable, `gc`-swept). */
export const PEOPLE_DIR = ".frameshell/people";

/** Bump when sampling, tracking or the file layout changes: it is part of the cache key. */
const FACE_SCAN_VERSION = 1;

/**
 * Cache key of the face scan of content `hash` (`sha256:<hex>`): its files are
 * `<key>.json` and `<key>.f32` in {@link PEOPLE_DIR}. It carries the scan
 * version, sampling rate and both model ids, so changing any of them scans again.
 */
export function faceScanKey(hash: string): string {
  const setup = createHash("sha256").update(`${FACE_SAMPLE_HZ}\0${FACE_DETECTION_MODEL}\0${FACE_RECOGNITION_MODEL}`).digest("hex").slice(0, 6);
  return `${hash.replace(/^sha256:/, "").slice(0, 20)}-f${FACE_SCAN_VERSION}-${setup}`;
}

const SCAN_FILE = /^([0-9a-f]{20}-f\d+-[0-9a-f]{6})\.(json|f32)$/;
const SCAN_TEMP = /^[0-9a-f]{20}-f\d+-[0-9a-f]{6}\.(json|f32)\..+\.tmp$/;

/**
 * What an entry of {@link PEOPLE_DIR} is, for `gc`: a file of the face scan
 * with cache key `key` (an older version or model never matches a current
 * key), a temp of an interrupted write, or null (not ours: kept).
 */
export function classifyFaceScan(name: string, isDirectory: boolean): GcClass {
  if (isDirectory) return null;
  if (SCAN_TEMP.test(name)) return { kind: "temp", key: null };
  const key = SCAN_FILE.exec(name)?.[1];
  return key ? { kind: "people", key } : null;
}

const TrackSchema = z.object({
  id: z.string(),
  start: z.number(),
  end: z.number(),
  boxes: z.array(z.tuple([z.number(), z.number(), z.number(), z.number(), z.number(), z.number()])),
  embeddings: z.array(z.object({ time: z.number(), row: z.int().nonnegative() })),
});

const FaceScanFileSchema = z.object({
  version: z.literal(FACE_SCAN_VERSION),
  hash: z.string(),
  models: z.object({ detector: z.string(), recognizer: z.string() }),
  hz: z.number(),
  width: z.int(),
  height: z.int(),
  samples: z.int().nonnegative(),
  dims: z.literal(FACE_EMBEDDING_DIMS),
  rows: z.int().nonnegative(),
  tracks: z.array(TrackSchema),
});

/**
 * A face scan as cached, for readers of `<key>.json` (header and tracks) and
 * `<key>.f32` (every embedding, `rows` × `dims` little-endian float32, each of
 * length 1, a track's rows listed in its `embeddings`).
 */
export interface StoredFaceScan {
  /** Content hash of the video scanned. */
  hash: string;
  models: { detector: string; recognizer: string };
  /** Frames looked at per second. */
  hz: number;
  /** Size of the pictures faces were embedded from. */
  width: number;
  height: number;
  /** Frames looked at. */
  samples: number;
  tracks: FaceTrack[];
}

const round4 = (value: number) => Math.round(value * 10_000) / 10_000;

/** Write the scan of content `hash` under `root`: embeddings first, then the JSON that makes it readable. */
export async function writeFaceScan(root: string, hash: string, scan: PeopleScanResult): Promise<void> {
  const key = faceScanKey(hash);
  const rows: Float32Array[] = [];
  const tracks = scan.tracks.map((track) => ({
    id: track.id,
    start: track.start,
    end: track.end,
    boxes: track.boxes.map((box) => [box.time, round4(box.x), round4(box.y), round4(box.width), round4(box.height), round4(box.score)] as [number, number, number, number, number, number]),
    embeddings: track.embeddings.map(({ time, vector }) => ({ time, row: rows.push(vector) - 1 })),
  }));
  const floats = new Float32Array(rows.length * FACE_EMBEDDING_DIMS);
  rows.forEach((row, i) => floats.set(row, i * FACE_EMBEDDING_DIMS));
  const dir = join(root, ...PEOPLE_DIR.split("/"));
  // Float32Array bytes are in the machine's order: little-endian on every platform Node runs on.
  await writeTextAtomic(join(dir, `${key}.f32`), new Uint8Array(floats.buffer));
  const file: z.infer<typeof FaceScanFileSchema> = {
    version: FACE_SCAN_VERSION,
    hash,
    models: { detector: FACE_DETECTION_MODEL, recognizer: FACE_RECOGNITION_MODEL },
    hz: FACE_SAMPLE_HZ,
    width: scan.width,
    height: scan.height,
    samples: scan.samples,
    dims: FACE_EMBEDDING_DIMS,
    rows: rows.length,
    tracks,
  };
  await writeTextAtomic(join(dir, `${key}.json`), `${JSON.stringify(file)}\n`);
}

/**
 * The cached face scan of content `hash`, or null when there is none, it is
 * damaged, or it was made by other models or an older version (scan again).
 */
export async function readFaceScan(root: string, hash: string): Promise<StoredFaceScan | null> {
  const key = faceScanKey(hash);
  const dir = join(root, ...PEOPLE_DIR.split("/"));
  const text = await readFile(join(dir, `${key}.json`), "utf8").catch(() => null);
  const bytes = await readFile(join(dir, `${key}.f32`)).catch(() => null);
  if (text === null || bytes === null) return null;
  let parsed: z.infer<typeof FaceScanFileSchema>;
  try {
    parsed = FaceScanFileSchema.parse(JSON.parse(text));
  } catch {
    return null;
  }
  if (parsed.hash !== hash || bytes.length !== parsed.rows * FACE_EMBEDDING_DIMS * 4) return null;
  // Copy: a Buffer from a read may sit at an offset that is not a multiple of 4.
  const floats = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length));
  const tracks: FaceTrack[] = [];
  for (const track of parsed.tracks) {
    if (track.embeddings.some(({ row }) => row >= parsed.rows)) return null;
    tracks.push({
      id: track.id,
      start: track.start,
      end: track.end,
      boxes: track.boxes.map(([time, x, y, width, height, score]) => ({ time, x, y, width, height, score })),
      embeddings: track.embeddings.map(({ time, row }) => ({ time, vector: floats.slice(row * FACE_EMBEDDING_DIMS, (row + 1) * FACE_EMBEDDING_DIMS) })),
    });
  }
  return { hash, models: parsed.models, hz: parsed.hz, width: parsed.width, height: parsed.height, samples: parsed.samples, tracks };
}
