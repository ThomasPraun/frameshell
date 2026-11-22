// Pointer track of a Shoot screen recording (ADR 0049): the mouse pointer's position over the captured screen, polled
// while the session records and written next to the screen file at End, for `clip zoom --follow pointer`.
import { join } from "node:path";
import { writeJsonAtomic } from "@frameshell/core/fs-util";
import { POINTER_SAMPLE_HZ, type PointerSample, type PointerTrack, pointerFileOf } from "@frameshell/schema";

/** A screen's bounds, in the points `screen.getCursorScreenPoint` reads. */
export interface DisplayBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A pointer reading: wall-clock milliseconds (high resolution) and the position in screen points. */
export interface PointerReading {
  at: number;
  x: number;
  y: number;
}

/**
 * The pointer track of a recording whose time 0 is wall-clock millisecond `start`: each reading as seconds on that
 * clock and fractions of `bounds`; readings before the start are dropped.
 */
export function pointerTrack(readings: readonly PointerReading[], start: number, bounds: DisplayBounds): PointerTrack {
  const samples: PointerSample[] = [];
  for (const reading of readings) {
    if (reading.at < start) continue;
    const t = Math.round(reading.at - start) / 1000;
    if (samples.length > 0 && t <= samples[samples.length - 1]![0]) continue;
    samples.push([t, round4((reading.x - bounds.x) / bounds.width), round4((reading.y - bounds.y) / bounds.height)]);
  }
  return { version: 1, width: bounds.width, height: bounds.height, samples };
}

/** Polls the pointer {@link POINTER_SAMPLE_HZ} times a second until stopped. */
export class PointerRecorder {
  readonly #readings: PointerReading[] = [];
  readonly #timer: ReturnType<typeof setInterval>;

  /**
   * @param read the pointer's position now, in screen points (Electron `screen.getCursorScreenPoint`).
   * @param now wall-clock milliseconds, high resolution (`performance.timeOrigin + performance.now()`).
   */
  constructor(
    readonly bounds: DisplayBounds,
    read: () => { x: number; y: number },
    now: () => number,
  ) {
    const sample = () => {
      try {
        this.#readings.push({ at: now(), ...read() });
      } catch {
        // A reading that fails (the display went away) is a gap; the zoom treats it as the pointer leaving.
      }
    };
    sample();
    this.#timer = setInterval(sample, 1000 / POINTER_SAMPLE_HZ);
  }

  /** Stop polling; the readings so far stay. */
  stop(): void {
    clearInterval(this.#timer);
  }

  /** The readings so far. */
  get readings(): readonly PointerReading[] {
    return this.#readings;
  }
}

/** Write the pointer track of screen file `file` of session folder `folder` (project-relative); returns its path. */
export async function writePointerTrack(root: string, folder: string, file: string, track: PointerTrack): Promise<string> {
  const rel = pointerFileOf(`${folder}/${file}`);
  await writeJsonAtomic(join(root, ...rel.split("/")), track);
  return rel;
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
