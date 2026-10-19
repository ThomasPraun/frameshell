import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { RpcError } from "@frameshell/protocol";
import type { MulticamGroup } from "@frameshell/schema";
import type { DirectorTurn } from "./director.js";

/**
 * When a screen angle moves (ADR 0016, screen shots): frame differences of
 * the angle's picture, sampled {@link MOTION_HZ} times a second at a tiny size,
 * then thresholded into stretches. Deterministic: the same file and threshold
 * give the same stretches.
 */

/** Samples per second of a picture's motion. */
export const MOTION_HZ = 4;
/** Size every sampled frame is scaled to before comparing; area averaging makes small changes (typing) still register. */
export const MOTION_SIZE = { width: 64, height: 36 } as const;

/** Mean absolute brightness difference of two equally sized gray frames, 0 to 255. */
export function frameDifference(previous: Uint8Array, current: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < current.length; i++) sum += Math.abs(current[i]! - previous[i]!);
  return sum / current.length;
}

/**
 * Stretches (seconds on the file's clock) where `differences` exceed `threshold`.
 * `differences[i]` compares the frames at i / hz and (i + 1) / hz, so a moving
 * sample covers the interval between them.
 */
export function motionStretches(differences: ArrayLike<number>, threshold: number, hz = MOTION_HZ): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  let first = -1;
  for (let i = 0; i <= differences.length; i++) {
    const moving = i < differences.length && differences[i]! > threshold;
    if (moving && first < 0) first = i;
    if (!moving && first >= 0) {
      out.push({ start: round(first / hz), end: round(i / hz) });
      first = -1;
    }
  }
  return out;
}

const round = (seconds: number) => Math.round(seconds * 1000) / 1000;

/** Frame differences of the first video stream of absolute `path`: one value per sample after the first. Throws when ffmpeg cannot decode it. */
export async function pictureDifferences(ffmpeg: string, path: string): Promise<Float32Array> {
  const frameBytes = MOTION_SIZE.width * MOTION_SIZE.height;
  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-nostdin",
    "-i",
    path,
    "-map",
    "0:v:0",
    "-an",
    "-vf",
    `fps=${MOTION_HZ},scale=${MOTION_SIZE.width}:${MOTION_SIZE.height}:flags=area,format=gray`,
    "-f",
    "rawvideo",
    "-",
  ];
  return new Promise<Float32Array>((resolve, reject) => {
    const child = spawn(ffmpeg, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const differences: number[] = [];
    let previous: Uint8Array | null = null;
    let pending: Buffer = Buffer.alloc(0);
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => (stderr = (stderr + chunk).slice(-4000)));
    child.stdout.on("data", (chunk: Buffer) => {
      pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
      let at = 0;
      for (; at + frameBytes <= pending.length; at += frameBytes) {
        const frame = Uint8Array.from(pending.subarray(at, at + frameBytes));
        if (previous) differences.push(frameDifference(previous, frame));
        previous = frame;
      }
      pending = pending.subarray(at);
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve(Float32Array.from(differences));
      else reject(new Error(`ffmpeg could not read the picture of ${path} (exit ${code}): ${stderr.trim()}`));
    });
  });
}

/** Where {@link groupMotion} finds the media facts it needs; the daemon wires these to its services. */
export interface MotionSource {
  /** Frame differences of a project-relative asset (see {@link MotionStore.differences}). */
  differences(root: string, asset: string): Promise<Float32Array>;
}

/** Options for {@link MotionStore}. */
export interface MotionStoreOptions {
  /** Managed or overridden ffmpeg for the project. */
  ffmpeg(root: string): Promise<string>;
}

/** Differences kept in memory per store (~4 bytes per sample: an hour is ~58 KB). */
const MEMORY_ENTRIES = 16;

/** Frame differences per asset, kept in memory by file identity (path, size, modification time); nothing is written to the project. */
export class MotionStore implements MotionSource {
  readonly #options: MotionStoreOptions;
  readonly #memory = new Map<string, Promise<Float32Array>>();

  constructor(options: MotionStoreOptions) {
    this.#options = options;
  }

  /** Frame differences of project-relative `rel`; throws when the file cannot be read or decoded. */
  async differences(root: string, rel: string): Promise<Float32Array> {
    const path = join(root, ...rel.split("/"));
    const info = await stat(path);
    const key = `${path}\0${info.size}\0${info.mtimeMs}`;
    let result = this.#memory.get(key);
    if (!result) {
      result = this.#options.ffmpeg(root).then((ffmpeg) => pictureDifferences(ffmpeg, path));
      this.#memory.set(key, result);
      result.catch(() => this.#memory.delete(key));
      if (this.#memory.size > MEMORY_ENTRIES) this.#memory.delete(this.#memory.keys().next().value!);
    }
    return result;
  }
}

/** Motion of every screen angle of a group plus what could not be measured. */
export interface GroupMotion {
  /** Group-clock stretches, each naming its screen angle. */
  motion: DirectorTurn[];
  /** One line per screen angle that could not be measured. */
  warnings: string[];
}

/**
 * Stretches in which each screen angle of `group` (`angle.screen`) moves, on
 * the group clock (the angle's `offset` applied), sorted by start then angle
 * id. A screen whose file cannot be decoded gets no motion and a warning;
 * daemon errors (missing asset) are thrown.
 */
export async function groupMotion(source: MotionSource, root: string, group: MulticamGroup, threshold: number): Promise<GroupMotion> {
  const warnings: string[] = [];
  const motion: DirectorTurn[] = [];
  for (const angle of group.angles) {
    if (angle.screen !== true) continue;
    try {
      const differences = await source.differences(root, angle.asset);
      for (const span of motionStretches(differences, threshold)) {
        const start = Math.max(0, round(angle.offset + span.start));
        const end = round(angle.offset + span.end);
        if (end > start) motion.push({ angle: angle.id, start, end });
      }
    } catch (error) {
      if (error instanceof RpcError || (error as NodeJS.ErrnoException).code === "ENOENT") throw error;
      warnings.push(`${angle.name} (${angle.asset}): could not read the picture (${(error as Error).message}), so it has no motion.`);
    }
  }
  motion.sort((a, b) => a.start - b.start || a.angle.localeCompare(b.angle));
  return { motion, warnings };
}
