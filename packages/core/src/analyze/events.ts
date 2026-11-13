import type { AnalyzeEvent } from "@frameshell/protocol";
import { LOOK_COLUMNS, LOOK_ROWS, cellOf } from "./look.js";
import { slidingMedians } from "./median.js";
import { stillRuns } from "./rhythm.js";
import { frameAt, frameStart } from "./shots.js";

// What happens in a film, moment by moment: flashes, elements that appear or disappear, holds and hits of the sound.
// Pure: `picture.ts` measures the per-frame series, `service.ts` decodes the sound. After HyperFrames' `measure` (Apache-2.0), ported per #478.

/** Cells of the grid the picture is split in. */
export const CELLS = LOOK_COLUMNS * LOOK_ROWS;

/** Change of the mean luma (0 to 1) from the picture around it that makes a flash. */
export const FLASH_RISE = 0.12;
/** Longest a flash lasts, seconds; a longer jump is a new shot, not a flash. */
export const FLASH_MAX_S = 0.25;
/** Shortest hold, seconds. */
export const HOLD_MIN_S = 0.5;
/** Grey levels a grid cell must change by in one frame to count as moving. */
export const MOVING_CELL_LEVEL = 2.5;
/** Grey levels a grid cell must differ by before and after an episode to count as changed. */
export const CHANGED_CELL_LEVEL = 12;
/** Frames without a moving cell that still belong to one episode. */
export const EPISODE_GAP_FRAMES = 2;
/** Longest an element's coming or going lasts, seconds; longer is camera or subject motion. */
export const EPISODE_MAX_S = 2;
/** Share of the picture above which a change is the whole picture changing (a cut, a transition), not an element. */
export const EPISODE_MAX_AREA = 0.6;
/** Share of the detail around an episode that must be gained or lost for it to be an element appearing or disappearing. */
export const DETAIL_SHARE = 0.15;
/** Rise of the sound, dB over the mean of the 80 ms before, that makes a hit. */
export const HIT_RISE_DB = 12;
/** Quietest peak, dBFS, a hit may have: below it the sound is noise. */
export const HIT_FLOOR_DB = -50;
/** Seconds after a hit in which none other is counted. */
export const HIT_REFRACTORY_S = 0.15;
/** Seconds within which a hit counts as on a big change of the picture. */
export const HIT_SYNC_S = 0.2;
/** Hops (10 ms) the mean level before an onset is taken over. */
const HIT_LOOKBACK = 8;
/** Hops (10 ms) after an onset its peak level is read over. */
const HIT_PEAK_HOPS = 10;

/** The per-frame series the picture events are found on. */
export interface PictureSeries {
  /** Frames measured. */
  frames: number;
  /** Mean luma of each frame, 0 to 1. */
  brightness: Float32Array;
  /** Mean grey change from the frame before, 0 to 255; 0 for the first. */
  activity: Float32Array;
  /** `CELLS` mean grey levels per frame, frame after frame, cells row by row. */
  cellLuma: Float32Array;
  /** `CELLS` mean detail per frame (sum of the grey steps to the pixel on the right and below): flat areas are 0, edges and text are high. */
  cellDetail: Float32Array;
}

/** Mean grey level and detail of each cell of a `width` x `height` grey frame, as {@link PictureSeries} stores them. */
export function cellStats(grey: Uint8Array, width: number, height: number, luma: Float32Array, detail: Float32Array): void {
  luma.fill(0);
  detail.fill(0);
  const pixels = new Float64Array(CELLS);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const cell = cellOf(x, y, width, height);
      const value = grey[y * width + x]!;
      luma[cell] = luma[cell]! + value;
      const right = x + 1 < width ? Math.abs(grey[y * width + x + 1]! - value) : 0;
      const below = y + 1 < height ? Math.abs(grey[(y + 1) * width + x]! - value) : 0;
      detail[cell] = detail[cell]! + right + below;
      pixels[cell] = pixels[cell]! + 1;
    }
  }
  for (let cell = 0; cell < CELLS; cell++) {
    const count = Math.max(1, pixels[cell]!);
    luma[cell] = luma[cell]! / count;
    detail[cell] = detail[cell]! / count;
  }
}

const round = (value: number, digits: number) => Math.round(value * 10 ** digits) / 10 ** digits;

function span(kind: AnalyzeEvent["kind"], startFrame: number, endFrame: number, fps: number): AnalyzeEvent {
  return { kind, startFrame, endFrame, start: frameStart(startFrame, fps), end: frameStart(endFrame, fps) };
}

/**
 * Flashes: runs of frames whose mean luma is at least {@link FLASH_RISE} above (or below) the median of the frames
 * around them, lasting at most {@link FLASH_MAX_S}. The median ignores a flash and follows a new shot, so a cut to a
 * brighter shot is not a flash.
 */
export function flashes(brightness: ArrayLike<number>, fps: number): AnalyzeEvent[] {
  const longest = Math.max(1, Math.floor(FLASH_MAX_S * fps + 1e-6));
  const half = 2 * longest;
  const events: AnalyzeEvent[] = [];
  let first = -1;
  let sign = 0;
  let peak = 0;
  const close = (end: number) => {
    if (first >= 0 && end - first <= longest) events.push({ ...span("flash", first, end, fps), direction: sign > 0 ? "up" : "down", amount: round(peak, 3) });
    first = -1;
  };
  const around = slidingMedians(brightness, half);
  for (let i = 0; i <= brightness.length; i++) {
    let jump = 0;
    if (i < brightness.length) {
      const delta = brightness[i]! - around[i]!;
      if (Math.abs(delta) >= FLASH_RISE) jump = delta;
    }
    const direction = Math.sign(jump);
    if (first >= 0 && direction !== sign) close(i);
    if (direction !== 0 && first < 0) {
      first = i;
      sign = direction;
      peak = 0;
    }
    if (direction !== 0) peak = Math.max(peak, Math.abs(jump));
  }
  return events;
}

/** Holds: stretches of at least {@link HOLD_MIN_S} in which the picture does not change. */
export function holds(activity: ArrayLike<number>, fps: number): AnalyzeEvent[] {
  return stillRuns(activity, Math.ceil(HOLD_MIN_S * fps - 1e-6)).map((run) => span("hold", run.startFrame, run.endFrame, fps));
}

/**
 * Elements appearing and disappearing: an episode is a run of frames (gaps of up to {@link EPISODE_GAP_FRAMES}) in which
 * some cell of the grid moves by {@link MOVING_CELL_LEVEL} or more. When the cells that differ before and after it are
 * under {@link EPISODE_MAX_AREA} of the picture, and the episode holds no cut and lasts no longer than {@link EPISODE_MAX_S}, it is an element
 * that came (the area gained detail) or went (it lost detail). Anything else is a cut, a transition or the camera moving.
 * Moving cells are counted over the whole picture, so a subject that keeps moving (a talking head) holds one episode open
 * past {@link EPISODE_MAX_S}: elements that come and go over it are not found.
 */
export function elementEvents(series: Pick<PictureSeries, "frames" | "cellLuma" | "cellDetail">, cutFrames: readonly number[], fps: number): AnalyzeEvent[] {
  const { frames, cellLuma, cellDetail } = series;
  const luma = (frame: number, cell: number) => cellLuma[frame * CELLS + cell]!;
  const detail = (frame: number, cell: number) => cellDetail[frame * CELLS + cell]!;
  const moving = (frame: number) => {
    for (let cell = 0; cell < CELLS; cell++) if (Math.abs(luma(frame, cell) - luma(frame - 1, cell)) >= MOVING_CELL_LEVEL) return true;
    return false;
  };
  const events: AnalyzeEvent[] = [];
  const maxFrames = Math.floor(EPISODE_MAX_S * fps + 1e-6);
  const episode = (first: number, last: number) => {
    if (last - first + 1 > maxFrames) return;
    if (cutFrames.some((cut) => cut >= first - 1 && cut <= last + 1)) return;
    const before = first - 1;
    const after = Math.min(frames - 1, last + 1);
    const changed: number[] = [];
    for (let cell = 0; cell < CELLS; cell++) if (Math.abs(luma(after, cell) - luma(before, cell)) >= CHANGED_CELL_LEVEL) changed.push(cell);
    if (changed.length === 0 || changed.length / CELLS > EPISODE_MAX_AREA) return;
    const columns = changed.map((cell) => cell % LOOK_COLUMNS);
    const rows = changed.map((cell) => Math.floor(cell / LOOK_COLUMNS));
    const [left, right] = [Math.min(...columns), Math.max(...columns)];
    const [top, bottom] = [Math.min(...rows), Math.max(...rows)];
    // Detail over the changed cells and the ring around them: an element's edges fall in the neighbours.
    let gained = 0;
    let lost = 0;
    for (let row = Math.max(0, top - 1); row <= Math.min(LOOK_ROWS - 1, bottom + 1); row++) {
      for (let column = Math.max(0, left - 1); column <= Math.min(LOOK_COLUMNS - 1, right + 1); column++) {
        const cell = row * LOOK_COLUMNS + column;
        gained += detail(after, cell);
        lost += detail(before, cell);
      }
    }
    const share = (gained - lost) / Math.max(gained, lost, 1e-6);
    if (Math.abs(share) < DETAIL_SHARE) return;
    events.push({
      ...span(share > 0 ? "appear" : "disappear", first, last + 1, fps),
      area: round(changed.length / CELLS, 3),
      region: { x: round(left / LOOK_COLUMNS, 3), y: round(top / LOOK_ROWS, 3), width: round((right - left + 1) / LOOK_COLUMNS, 3), height: round((bottom - top + 1) / LOOK_ROWS, 3) },
    });
  };
  let first = -1;
  let last = -1;
  for (let frame = 1; frame < frames; frame++) {
    if (!moving(frame)) continue;
    if (first >= 0 && frame - last - 1 > EPISODE_GAP_FRAMES) {
      episode(first, last);
      first = -1;
    }
    if (first < 0) first = frame;
    last = frame;
  }
  if (first >= 0) episode(first, last);
  return events;
}

/** One hit of the sound before it is placed on the film. */
export interface SoundHit {
  /** Seconds. */
  time: number;
  /** dB the level rose by over the mean of the 80 ms before. */
  rise: number;
  /** Loudest level in the 100 ms after, dBFS. */
  level: number;
}

/**
 * Hits in an energy envelope (`db[i]` is dBFS of the 10 ms from `i / 100` s, see `energyEnvelope`): moments where the
 * level climbs {@link HIT_RISE_DB} over the 80 ms before it and reaches {@link HIT_FLOOR_DB}, at least
 * {@link HIT_REFRACTORY_S} apart. A word after a pause counts as much as an effect.
 */
export function soundHits(db: ArrayLike<number>, hopSeconds = 0.01): SoundHit[] {
  const hits: SoundHit[] = [];
  const refractory = Math.ceil(HIT_REFRACTORY_S / hopSeconds);
  for (let i = 1; i < db.length; ) {
    let baseline = 0;
    const from = Math.max(0, i - HIT_LOOKBACK);
    for (let j = from; j < i; j++) baseline += db[j]!;
    baseline /= i - from;
    // The first hop whose level has climbed over the baseline by half the rise is the onset; the full rise may come a hop or two later.
    const onset = db[i]! - baseline >= HIT_RISE_DB / 2 ? i : -1;
    if (onset < 0) {
      i++;
      continue;
    }
    let peak = -Infinity;
    for (let j = onset; j < Math.min(db.length, onset + HIT_PEAK_HOPS); j++) peak = Math.max(peak, db[j]!);
    if (peak - baseline >= HIT_RISE_DB && peak >= HIT_FLOOR_DB) {
      hits.push({ time: onset * hopSeconds, rise: round(peak - baseline, 1), level: round(peak, 1) });
      i = onset + refractory;
    } else i++;
  }
  return hits;
}

/**
 * The hits as film events at `fps`: placed on a frame, and with the offset to the nearest big change of the picture within
 * {@link HIT_SYNC_S}. A hit past the last of the film's `frames` (the sound outlasts the picture) is left out.
 */
export function hitEvents(hits: readonly SoundHit[], changeFrames: readonly number[], fps: number, frames: number): AnalyzeEvent[] {
  return hits.flatMap((hit) => {
    const frame = frameAt(hit.time, fps);
    if (frame >= frames) return [];
    const start = frameStart(frame, fps);
    let offset: number | null = null;
    for (const change of changeFrames) {
      const gap = start - frameStart(change, fps);
      if (Math.abs(gap) <= HIT_SYNC_S && (offset === null || Math.abs(gap) < Math.abs(offset))) offset = gap;
    }
    return [{ ...span("hit", frame, frame + 1, fps), amount: hit.rise, level: hit.level, offset: offset === null ? null : round(offset, 3) }];
  });
}
