import { stat } from "node:fs/promises";
import { basename, join } from "node:path";
import type { AnalyzeSync } from "@frameshell/protocol";
import { sha256File } from "../fs-util.js";
import { readRawFrames } from "../media/raw-frames.js";
import { ENERGY_HOP_S } from "../media/energy.js";
import { PEOPLE_DIR, readFaceScan } from "../people/scan-cache.js";
import type { FileFaceScan } from "../people/scan-run.js";
import { SYNC_MAX_LAG_S, SYNC_MIN_FACE_S, longestTrack, mouthMotion, mouthViewSize, skippedSync, syncOffset, syncResult, voiceLevel } from "./lip.js";
import { MAX_PICTURE_S } from "./picture.js";

/** The film `measureSync` reads. */
export interface SyncFilm {
  fps: number;
  frames: number;
  width: number;
  height: number;
}

const HOW_TO_SCAN = "import the video into the project and run `frameshell people scan <asset>` (the scan is found again by the file's content).";

/** The video a face scan is asked for. */
export interface FaceScanFilm extends SyncFilm {
  /** Absolute path. */
  file: string;
  /** Content hash, `sha256:<hex>`: the key of the cached scan. */
  hash: string;
  /** Seconds. */
  duration: number;
}

/** What {@link measureSync} may use besides the film and its sound. */
export interface SyncOptions {
  signal?: AbortSignal | undefined;
  /**
   * Scan the faces of the film and cache the scan under `root` by content; rejects when it cannot (no model, no network, untrusted
   * runtime). Called only when no scan is cached. Absent, or `faces: false`: only a scan already cached is used.
   */
  scanFaces?: ((film: FaceScanFilm, signal: AbortSignal | undefined, onProgress: (fraction: number) => void) => Promise<FileFaceScan>) | undefined;
  /** Scan the faces when none is cached; false skips it (the slow part). Default true. */
  faces?: boolean | undefined;
  /** Says what the run is doing (the scan takes a while). */
  stage?: ((message: string) => void) | undefined;
  /** 0..1 of the face scan. */
  onScanProgress?: ((fraction: number) => void) | undefined;
  /** A run-level warning: a failed scan is skipped sync with its reason and this, never a failed run. */
  warn?: ((message: string) => void) | undefined;
}

/**
 * Mouth against voice of `file` (see {@link AnalyzeSync}): the face track of the people scan cached for this exact content (found under
 * `root` whatever the path), or made now by `options.scanFaces` and cached there, its mouth area read from the picture, against `db`
 * (the 10 ms energy envelope of the sound, dBFS; null for a film with no sound).
 * Skipped, with the reason, when there is no sound, no scan (and none asked for or none possible), no face on screen long enough,
 * or when mouth and voice do not follow each other.
 */
export async function measureSync(root: string, ffmpeg: string, file: string, film: SyncFilm, db: ArrayLike<number> | null, options: SyncOptions = {}): Promise<AnalyzeSync> {
  const { signal } = options;
  if (db === null) return skippedSync("the video has no sound.");
  const scanning = options.faces !== false && options.scanFaces !== undefined;
  // Without a scan to run, a project that never scanned has nothing to read: no hash of the file either.
  if (!scanning && !(await stat(join(root, ...PEOPLE_DIR.split("/"))).catch(() => null))?.isDirectory()) {
    return skippedSync(options.faces === false ? `face scan not asked for (faces: false); ${HOW_TO_SCAN}` : `no face scan: ${HOW_TO_SCAN}`);
  }
  const hash = `sha256:${await sha256File(file)}`;
  let scan: FileFaceScan | null = await readFaceScan(root, hash);
  if (scan === null && !scanning) {
    return skippedSync(options.faces === false ? `this file has no cached face scan and faces: false skips making one: ${HOW_TO_SCAN}` : `this file has no cached face scan: ${HOW_TO_SCAN}`);
  }
  if (scan === null) {
    options.stage?.(`Finding faces in ${basename(file)}`);
    try {
      scan = await options.scanFaces!({ ...film, file, hash, duration: film.frames / film.fps }, signal, (fraction) => options.onScanProgress?.(fraction));
    } catch (error) {
      if (signal?.aborted) throw error;
      const reason = `the faces could not be scanned: ${(error as Error).message}`;
      options.warn?.(`sync: ${reason}`);
      return skippedSync(`${reason} (--no-faces / faces: false skips the scan; or ${HOW_TO_SCAN})`);
    }
  }
  const track = longestTrack(scan.tracks);
  if (track === null) return skippedSync("the people scan of this file found no face.");
  if (track.end - track.start < SYNC_MIN_FACE_S) return skippedSync(`the face that is on screen longest is there for ${Math.round((track.end - track.start) * 10) / 10} s, under the ${SYNC_MIN_FACE_S} s a lag needs.`);
  const size = mouthViewSize(film.width, film.height);
  const count = Math.min(film.frames, Math.floor(MAX_PICTURE_S * film.fps + 1e-6));
  const grey = readRawFrames(ffmpeg, file, `fps=${film.fps},scale=${size.width}:${size.height}:flags=area,format=gray`, size.width * size.height);
  const motion = await mouthMotion(grey, size, film.fps, track, count, signal);
  const voice = voiceLevel(db, ENERGY_HOP_S, film.fps, count);
  const from = Math.max(1, Math.floor(track.start * film.fps));
  const to = Math.min(count, Math.ceil(track.end * film.fps));
  signal?.throwIfAborted();
  return syncResult(syncOffset(motion, voice, Math.round(SYNC_MAX_LAG_S * film.fps), from, to), film.fps, track.id, to - from);
}
