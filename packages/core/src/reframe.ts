// Single-clip reframe (`clip.reframe`, epic #451): where a clip's picture must sit so a face stays framed in a
// frame of another aspect. Pure geometry; the layer model is `layerRect` in @frameshell/schema.
import type { KeyEase } from "@frameshell/schema";
import type { FacePoint } from "./multicam/faces.js";

/** Where the face lands in the frame, fractions of its width and height: centered, the face center 30 % from the top. */
export const REFRAME_FACE_AT = Object.freeze({ x: 0.5, y: 0.3 });

/** The fill scale is raised by this factor so pixel rounding never leaves an uncovered edge. */
const HEADROOM = 1.002;

/** Aspect of a frame: `width`:`height`, whole numbers. */
export interface FrameFormat {
  width: number;
  height: number;
}

/** `9x16` or `9:16` as a {@link FrameFormat}; null when it is not two positive whole numbers. */
export function parseFrameFormat(text: string): FrameFormat | null {
  const match = /^(\d{1,3})\s*[x:]\s*(\d{1,3})$/i.exec(text.trim());
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  return width > 0 && height > 0 ? { width, height } : null;
}

/** Placement fields a reframe sets: `x`, `y` in project pixels, `scale` as a factor of the fitted size. */
export interface ReframePlacement {
  x: number;
  y: number;
  scale: number;
}

/** Sizes of the picture and the project frame (`frameshell.json` resolution), in pixels. */
export interface ReframeGeometry {
  /** The picture as it plays, rotation applied. */
  source: { width: number; height: number };
  project: { width: number; height: number };
  /** Aspect of the frame the picture must fill. */
  format: FrameFormat;
}

/**
 * Scale that makes the picture cover a frame of `format` (never below the fitted size), and the offset limits
 * `x`, `y` (project pixels, symmetric) keeping that cover: past them the frame would show outside the picture.
 */
export function reframeBounds(geometry: ReframeGeometry): { scale: number; maxX: number; maxY: number } {
  const { w, h, scale } = layer(geometry);
  const frame = frameUnits(geometry.format);
  return {
    scale,
    maxX: floor4(Math.max(0, ((w - frame) / 2 / frame) * geometry.project.width)),
    maxY: floor4(Math.max(0, ((h - 1) / 2) * geometry.project.height)),
  };
}

/**
 * Placement that puts the point `at` of the picture (fractions of it) at {@link REFRAME_FACE_AT} of a frame of
 * `format`, with the picture covering the frame: the cover scale of {@link reframeBounds}, `x` and `y` clamped to
 * its limits. The same math as `layerRect`, in units of the frame's height so any export size of that aspect agrees.
 */
export function reframePlacement(geometry: ReframeGeometry, at: { x: number; y: number }): ReframePlacement {
  const { w, h, scale } = layer(geometry);
  const frame = frameUnits(geometry.format);
  const offsetX = REFRAME_FACE_AT.x * frame - frame / 2 + w * (0.5 - at.x);
  const offsetY = REFRAME_FACE_AT.y - 0.5 + h * (0.5 - at.y);
  const { maxX, maxY } = reframeBounds(geometry);
  const x = clamp((offsetX / frame) * geometry.project.width, maxX);
  const y = clamp(offsetY * geometry.project.height, maxY);
  return { x: round4(x), y: round4(y), scale };
}

/** Width of a frame of `format` in units of its height. */
function frameUnits(format: FrameFormat): number {
  return format.width / format.height;
}

/** The covering layer in units of the frame's height: size and scale factor. */
function layer({ source, format }: ReframeGeometry): { w: number; h: number; scale: number } {
  const frame = frameUnits(format);
  const ratio = source.width / source.height;
  const fit = Math.min(frame / ratio, 1);
  const w0 = ratio * fit;
  const h0 = fit;
  const cover = Math.max(frame / w0, 1 / h0) * HEADROOM;
  const scale = Math.ceil(cover * 10_000) / 10_000;
  return { w: w0 * scale, h: h0 * scale, scale };
}

function clamp(value: number, limit: number): number {
  return Math.min(limit, Math.max(-limit, value));
}

/** Rounded down, so a limit stays a limit after the placement is rounded to the same four decimals. */
function floor4(value: number): number {
  return Math.floor(value * 10_000) / 10_000;
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

/** One key of the reframe, on the timeline clock. */
export interface ReframeKey {
  /** Timeline seconds. */
  time: number;
  x: number;
  y: number;
  /** How the value moves from this key to the next; absent: linearly (a hold when the next key is the same). */
  ease?: KeyEase;
}

/** Placement of a reframe: `scale` always, and `x`, `y` held or moving. */
export interface ReframePlan {
  scale: number;
  /** Where the picture sits at the first key (all of it, when nothing moves). */
  x: number;
  y: number;
  /** Keys when `x` or `y` move; empty when the face holds one place. */
  keys: ReframeKey[];
  /** Whether `x` moves (has keys of its own) and whether `y` does. */
  moves: { x: boolean; y: boolean };
}

/**
 * The reframe of a clip whose face is at `points` (source seconds, fractions of the picture; the stops and glides
 * of `proposeReframeKeys`): each point becomes a placement, times move to the timeline through `toTimeline`, and a
 * key that starts a move eases in and out. A property whose placement never changes needs no keys.
 */
export function planReframe(geometry: ReframeGeometry, points: readonly FacePoint[], toTimeline: (source: number) => number): ReframePlan {
  const placed = points.map((point) => ({ time: Math.round(toTimeline(point.time) * 1000) / 1000, ...reframePlacement(geometry, point) }));
  const first = placed[0];
  if (!first) {
    const { scale } = reframeBounds(geometry);
    return { scale, x: 0, y: 0, keys: [], moves: { x: false, y: false } };
  }
  const moves = { x: placed.some((key) => key.x !== first.x), y: placed.some((key) => key.y !== first.y) };
  const keys = !moves.x && !moves.y ? [] : placed.map((key, i): ReframeKey => {
    const next = placed[i + 1];
    const moving = next !== undefined && (next.x !== key.x || next.y !== key.y);
    return { time: key.time, x: key.x, y: key.y, ...(moving ? { ease: "in-out" as const } : {}) };
  });
  return { scale: first.scale, x: first.x, y: first.y, keys, moves };
}
