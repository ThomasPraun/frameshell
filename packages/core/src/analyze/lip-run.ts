import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { AnalyzeSync } from "@frameshell/protocol";
import { sha256File } from "../fs-util.js";
import { readRawFrames } from "../media/raw-frames.js";
import { ENERGY_HOP_S } from "../media/energy.js";
import { PEOPLE_DIR, readFaceScan } from "../people/scan-cache.js";
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

/**
 * Mouth against voice of `file` (see {@link AnalyzeSync}): the face track of the people scan cached for this exact file under
 * `root`, its mouth area read from the picture, against `db` (the 10 ms energy envelope of the sound, dBFS; null for a film with no sound).
 * Skipped, with the reason, when there is no sound, no cached scan, no face on screen long enough, or when mouth and voice do not follow each other.
 */
export async function measureSync(root: string, ffmpeg: string, file: string, film: SyncFilm, db: ArrayLike<number> | null, signal?: AbortSignal): Promise<AnalyzeSync> {
  if (db === null) return skippedSync("the video has no sound.");
  if (!(await stat(join(root, ...PEOPLE_DIR.split("/"))).catch(() => null))?.isDirectory()) return skippedSync(`no face scan: ${HOW_TO_SCAN}`);
  const scan = await readFaceScan(root, `sha256:${await sha256File(file)}`);
  if (scan === null) return skippedSync(`this file has no cached face scan: ${HOW_TO_SCAN}`);
  const track = longestTrack(scan.tracks);
  if (track === null) return skippedSync("the people scan of this file found no face.");
  if (track.end - track.start < SYNC_MIN_FACE_S) return skippedSync(`the face that is on screen longest is there for ${Math.round((track.end - track.start) * 10) / 10} s, under the ${SYNC_MIN_FACE_S} s a lag needs.`);
  const size = mouthViewSize(film.width, film.height);
  const count = Math.min(film.frames, Math.floor(MAX_PICTURE_S * film.fps + 1e-6));
  const grey = readRawFrames(ffmpeg, file, `fps=${film.fps},scale=${size.width}:${size.height}:flags=area,format=gray`, size.width * size.height);
  const motion = await mouthMotion(grey, size, film.fps, track, count);
  const voice = voiceLevel(db, ENERGY_HOP_S, film.fps, count);
  const from = Math.max(1, Math.floor(track.start * film.fps));
  const to = Math.min(count, Math.ceil(track.end * film.fps));
  signal?.throwIfAborted();
  return syncResult(syncOffset(motion, voice, Math.round(SYNC_MAX_LAG_S * film.fps), from, to), film.fps, track.id, to - from);
}
