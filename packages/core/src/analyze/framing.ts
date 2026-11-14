import { readRawFrames } from "../media/raw-frames.js";

// Which kind of cut a big change of the picture is, from the frame before it and the frame after: a new scene, the same
// framing with time skipped (a jump cut), the same shot punched in or out (a crop and scale of it), or no cut at all (a
// flash, a caption). Pure but for `readBoundaryFrames`. After HyperFrames' `measure` (Apache-2.0), ported per #478.

/** Longest side of the grey frames cuts are classified on, px: enough to tell a 1.05x scale from none, small enough to search many scales. */
export const FRAMING_LONG_SIDE = 96;
/** Zero-mean correlation (-1 to 1) a scaled crop must reach to be the same shot punched in or out. */
export const PUNCH_MATCH = 0.8;
/** Zero-mean correlation of the two frames, with {@link SAME_MAX_CHANGED} or less of the picture changed, from which they show the same framing. */
export const SAME_CORRELATION = 0.3;
/** Share of the picture changed above which the frames do not show the same framing, whatever their correlation. */
export const SAME_MAX_CHANGED = 0.4;
/** Share of the picture changed up to which the frames show the same framing even with no correlation (a flat wall, a subject that left its place). */
export const CLOSE_CHANGED = 0.2;
/** Grey levels a pixel must differ by (after the mean grey of the two frames is levelled) to count as changed. */
export const CHANGED_LEVEL = 16;
/** Share of the picture that must have changed for a same-framing cut to be a jump cut: under it the change is a caption, a flash, a small element. */
export const JUMP_MIN_CHANGED = 0.08;
/** Smallest scale change reported as a punch: under it the picture is the same framing. */
export const MIN_PUNCH_SCALE = 1.08;
/** Largest scale change searched (2.5 is a 150 % punch-in). */
export const MAX_PUNCH_SCALE = 2.5;
/** Ratio between two scales searched, so a scale is found within about 2 %. */
export const SCALE_STEP = 1.04;
/** What the correlation must gain over the unscaled one for a scale to count: otherwise the frames were already the same framing. */
export const PUNCH_GAIN = 0.08;
/** Fractions of the picture's size the scaled crop may be shifted by, either way: a subject that is not at the centre. */
export const SHIFTS = [-0.04, 0, 0.04] as const;
/** Grey spread (standard deviation, levels) under which a frame has no structure to match: a black, white or flat frame. */
export const FLAT_SPREAD = 2;

/** What a big change of the picture is. */
export type CutKind = "cut" | "jump" | "punch-in" | "punch-out" | "change";

/** How two consecutive frames relate. */
export interface Framing {
  kind: CutKind;
  /** Zero-mean correlation of the two frames as they are, 0 to 1 (a negative one reads 0), 3 decimals. */
  similarity: number;
  /** For a punch, how many times larger the picture after the cut shows what the one before shows (1.3: 30 % bigger; below 1: a punch out); null otherwise. */
  scale: number | null;
  /** Share of the picture that changed, 0 to 1, 3 decimals. */
  changed: number;
}

/** Sums of two grey frames read as paired samples: what a zero-mean correlation needs. */
class Pairs {
  n = 0;
  sx = 0;
  sy = 0;
  sxx = 0;
  syy = 0;
  sxy = 0;
  add(x: number, y: number): void {
    this.n++;
    this.sx += x;
    this.sy += y;
    this.sxx += x * x;
    this.syy += y * y;
    this.sxy += x * y;
  }
  /** Whether `x` (or `y`) has no structure to match. */
  flat(side: "x" | "y"): boolean {
    const variance = side === "x" ? this.sxx / this.n - (this.sx / this.n) ** 2 : this.syy / this.n - (this.sy / this.n) ** 2;
    return variance < FLAT_SPREAD ** 2;
  }
  /** Zero-mean correlation; 0 when either side is flat. */
  correlation(): number {
    const { n } = this;
    if (n === 0 || this.flat("x") || this.flat("y")) return 0;
    const vx = this.sxx - (this.sx * this.sx) / n;
    const vy = this.syy - (this.sy * this.sy) / n;
    return (this.sxy - (this.sx * this.sy) / n) / Math.sqrt(vx * vy);
  }
}

/** Value of the grey frame `image` (`width` x `height`) at the real position (`x`, `y`), bilinear, edges held. */
function sample(image: Uint8Array, width: number, height: number, x: number, y: number): number {
  const fx = Math.min(Math.max(x, 0), width - 1);
  const fy = Math.min(Math.max(y, 0), height - 1);
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(x0 + 1, width - 1);
  const y1 = Math.min(y0 + 1, height - 1);
  const tx = fx - x0;
  const ty = fy - y0;
  const top = image[y0 * width + x0]! * (1 - tx) + image[y0 * width + x1]! * tx;
  const bottom = image[y1 * width + x0]! * (1 - tx) + image[y1 * width + x1]! * tx;
  return top * (1 - ty) + bottom * ty;
}

/**
 * Correlation of `tight` with `wide` when `tight` shows `scale` times what `wide` shows, the crop of `wide` centred
 * (`shiftX`, `shiftY`) fractions of the picture off the middle.
 */
function scaledCorrelation(wide: Uint8Array, tight: Uint8Array, width: number, height: number, scale: number, shiftX: number, shiftY: number): number {
  const pairs = new Pairs();
  const mx = (width - 1) / 2;
  const my = (height - 1) / 2;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      pairs.add(sample(wide, width, height, mx + shiftX * width + (x - mx) / scale, my + shiftY * height + (y - my) / scale), tight[y * width + x]!);
    }
  }
  return pairs.correlation();
}

/** Best correlation of `tight` against crops of `wide` over the scales and shifts searched, and the scale that gave it. */
function bestScale(wide: Uint8Array, tight: Uint8Array, width: number, height: number): { correlation: number; scale: number } {
  let best = { correlation: -1, scale: 1 };
  for (let scale = MIN_PUNCH_SCALE; scale <= MAX_PUNCH_SCALE + 1e-9; scale *= SCALE_STEP) {
    for (const shiftY of SHIFTS) {
      for (const shiftX of SHIFTS) {
        const correlation = scaledCorrelation(wide, tight, width, height, scale, shiftX, shiftY);
        if (correlation > best.correlation) best = { correlation, scale };
      }
    }
  }
  return best;
}

const round3 = (value: number) => Math.round(value * 1000) / 1000;

/**
 * What the change from `before` to `after` (two grey frames of `width` x `height`) is. A crop of one scaled to match the
 * other is a punch in (the second is the tighter) or out; the same framing (most of the picture where it was) with a good
 * part of it changed is a jump cut, with little of it a `change` (a caption, an effect); two flat frames (a flash) are
 * a `change` too; anything else is a new scene, a `cut`. The scale is an estimate from small frames, good to a few percent.
 */
export function classifyChange(before: Uint8Array, after: Uint8Array, width: number, height: number): Framing {
  const pairs = new Pairs();
  let lift = 0;
  for (let i = 0; i < before.length; i++) {
    pairs.add(before[i]!, after[i]!);
    lift += after[i]! - before[i]!;
  }
  lift /= before.length;
  let moved = 0;
  for (let i = 0; i < before.length; i++) if (Math.abs(after[i]! - before[i]! - lift) >= CHANGED_LEVEL) moved++;
  const changed = round3(moved / before.length);
  const similarity = pairs.correlation();
  const shown = round3(Math.max(0, similarity));
  const flatBefore = pairs.flat("x");
  const flatAfter = pairs.flat("y");
  if (flatBefore && flatAfter) return { kind: "change", similarity: shown, scale: null, changed };
  if (flatBefore || flatAfter) return { kind: "cut", similarity: shown, scale: null, changed };
  const zoomIn = bestScale(before, after, width, height);
  const zoomOut = bestScale(after, before, width, height);
  const out = zoomOut.correlation > zoomIn.correlation;
  const best = out ? zoomOut : zoomIn;
  if (best.correlation >= PUNCH_MATCH && best.correlation >= similarity + PUNCH_GAIN) {
    return { kind: out ? "punch-out" : "punch-in", similarity: shown, scale: Math.round((out ? 1 / best.scale : best.scale) * 100) / 100, changed };
  }
  const same = changed <= CLOSE_CHANGED || (similarity >= SAME_CORRELATION && changed <= SAME_MAX_CHANGED);
  if (!same) return { kind: "cut", similarity: shown, scale: null, changed };
  return { kind: changed >= JUMP_MIN_CHANGED ? "jump" : "change", similarity: shown, scale: null, changed };
}

/** Size the grey frames of a `width` x `height` film are read at: {@link FRAMING_LONG_SIDE} on the long side. */
export function framingSize(width: number, height: number): { width: number; height: number } {
  const scale = FRAMING_LONG_SIDE / Math.max(width, height);
  return { width: Math.max(8, Math.round(width * scale)), height: Math.max(8, Math.round(height * scale)) };
}

/**
 * The grey frames `frame - 1` and `frame` of each of `frames` (ascending, from 1), read in one pass at {@link framingSize}
 * on the film's constant rate `film.fps` (the frames `readPicture` counted). A frame past the end of the film is missing.
 */
export async function readBoundaryFrames(
  ffmpeg: string,
  file: string,
  film: { width: number; height: number; fps: number },
  frames: readonly number[],
  signal?: AbortSignal,
  progress?: (fraction: number) => void,
): Promise<{ size: { width: number; height: number }; pairs: Map<number, { before: Uint8Array; after: Uint8Array }> }> {
  const size = framingSize(film.width, film.height);
  const pairs = new Map<number, { before: Uint8Array; after: Uint8Array }>();
  if (frames.length === 0) return { size, pairs };
  const wanted = new Set<number>();
  for (const frame of frames) {
    wanted.add(frame - 1);
    wanted.add(frame);
  }
  const last = frames.at(-1)!;
  const kept = new Map<number, Uint8Array>();
  let index = 0;
  for await (const grey of readRawFrames(ffmpeg, file, `fps=${film.fps},scale=${size.width}:${size.height}:flags=area,format=gray`, size.width * size.height)) {
    signal?.throwIfAborted();
    if (wanted.has(index)) kept.set(index, grey);
    if (index >= last) break;
    index++;
    if (index % 60 === 0) progress?.(index / (last + 1));
  }
  for (const frame of frames) {
    const before = kept.get(frame - 1);
    const after = kept.get(frame);
    if (before && after) pairs.set(frame, { before, after });
  }
  return { size, pairs };
}
