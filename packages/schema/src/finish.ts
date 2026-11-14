// Film finish (ADR 0043): the timeline's letterbox bars and a clip's vignette and grain, each from functions that
// export and the preview both draw from. No Zod here: the preview engine worker imports this file.

/** Width and height of a frame in pixels. */
export interface FrameSize {
  width: number;
  height: number;
}

/** One black bar in frame pixels, top-left origin. */
export interface LetterboxBar {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * The black bars that show `frame` at picture aspect `aspect` (width / height): top and bottom when the aspect is
 * wider than the frame, left and right when narrower, none when it matches to the pixel. The picture keeps
 * `round(width / aspect)` rows (or `round(height * aspect)` columns, at least 1); the odd pixel goes to the second bar.
 */
export function letterboxBars(frame: FrameSize, aspect: number): LetterboxBar[] {
  const { width, height } = frame;
  const rows = Math.max(1, Math.round(width / aspect));
  if (rows < height) {
    const top = Math.floor((height - rows) / 2);
    return [
      { left: 0, top: 0, width, height: top },
      { left: 0, top: top + rows, width, height: height - rows - top },
    ].filter((bar) => bar.height > 0);
  }
  const columns = Math.max(1, Math.round(height * aspect));
  if (columns < width) {
    const left = Math.floor((width - columns) / 2);
    return [
      { left: 0, top: 0, width: left, height },
      { left: left + columns, top: 0, width: width - columns - left, height },
    ].filter((bar) => bar.width > 0);
  }
  return [];
}

/** Range and default of each vignette number (ADR 0043 decision 8). */
export const VIGNETTE_LIMITS = {
  strength: { min: 0, max: 1, default: 0.35 },
  radius: { min: 0, max: 1.5, default: 1 },
  softness: { min: 0, max: 1, default: 0.6 },
} as const;

/** A clip's `vignette` as stored; omitted numbers take {@link VIGNETTE_LIMITS} defaults. */
export interface VignetteFields {
  strength?: number | undefined;
  radius?: number | undefined;
  softness?: number | undefined;
}

/** A vignette with every number given. */
export interface ResolvedVignette {
  /** Darkening at and past `radius`: 0 none, 1 black. */
  strength: number;
  /** Distance from the centre, in half-diagonals of the picture, where the darkening is full. */
  radius: number;
  /** Width of the falloff inside `radius`, in half-diagonals: 0 a hard edge. */
  softness: number;
}

/**
 * The vignette a clip's picture is drawn with: its `vignette` with defaults filled in; null for none, a strength of 0,
 * multicam shots and nested timeline clips (ADR 0043 decision 9). Export and the preview both ask this.
 */
export function vignetteOf(clip: { type: string; vignette?: VignetteFields | undefined }): ResolvedVignette | null {
  if (clip.type === "shot" || clip.type === "timeline" || !clip.vignette) return null;
  const strength = clip.vignette.strength ?? VIGNETTE_LIMITS.strength.default;
  if (strength <= 0) return null;
  return {
    strength,
    radius: clip.vignette.radius ?? VIGNETTE_LIMITS.radius.default,
    softness: clip.vignette.softness ?? VIGNETTE_LIMITS.softness.default,
  };
}

/**
 * Gain of a `size` picture at point (`x`, `y`) in its pixels, top-left origin (pixel i's centre is i + 0.5): 1 within
 * `radius - softness` of the centre, then a smoothstep down to `1 - strength` at `radius`. Distance is in pixels (a
 * circle on any aspect) over the half-diagonal. Export's plate does these steps in this order (`vignetteExpression`
 * in packages/core/src/export/vignette.ts); a parity test holds them together.
 */
export function vignetteGain(x: number, y: number, size: FrameSize, vignette: ResolvedVignette): number {
  const { width, height } = size;
  const dx = x - width / 2;
  const dy = y - height / 2;
  const distance = (2 * Math.sqrt(dx * dx + dy * dy)) / Math.sqrt(width * width + height * height);
  const { strength, radius, softness } = vignette;
  const t = softness > 0 ? Math.min(1, Math.max(0, (distance - radius + softness) / softness)) : distance >= radius ? 1 : 0;
  return 1 - strength * (t * t * (3 - 2 * t));
}

/**
 * The 8-bit level of `gain` in export's vignette plate and the preview's pass: a pixel byte becomes
 * `floor(byte * level / 255)`, as ffmpeg `blend` multiply computes it.
 */
export function vignetteLevel(gain: number): number {
  return Math.floor(255 * gain + 0.5);
}

/** Range and default of each grain number (ADR 0043 units). */
export const GRAIN_LIMITS = {
  amount: { min: 0, max: 1, default: 0.35 },
  size: { min: 1, max: 4, default: 1.5 },
  seed: { min: 0, max: 0x7fffffff },
} as const;

/** Frames before grain repeats: its phase is the timeline frame modulo this (ADR 0043 decision 7; changes only with the goldens). */
export const GRAIN_PERIOD = 64;

/** ffmpeg `noise` strength of grain `amount` 1: each grain value is uniform over this many levels. */
export const GRAIN_STRENGTH = 48;

/** A clip's `grain` as stored; omitted numbers take {@link GRAIN_LIMITS} defaults, the seed {@link grainSeed}. */
export interface GrainFields {
  amount?: number | undefined;
  size?: number | undefined;
  seed?: number | undefined;
}

/** Grain with every number given. */
export interface ResolvedGrain {
  /** 0 none to 1 strong. */
  amount: number;
  /** Width of one grain in project pixels (1-4). */
  size: number;
  /** Seed of the pattern, 0 to 2^31 - 1. */
  seed: number;
  /** Integer levels the grain values spread over: {@link grainStrength} of `amount`. */
  strength: number;
}

/** Low 31 bits of the 32-bit FNV-1a hash of `id`'s UTF-8 bytes: the grain seed of a clip that names none. */
export function grainSeed(id: string): number {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(id)) hash = Math.imul(hash ^ byte, 0x01000193);
  return (hash >>> 0) & 0x7fffffff;
}

/** Noise strength (integer levels, 0 to {@link GRAIN_STRENGTH}) of grain `amount`. */
export function grainStrength(amount: number): number {
  return Math.round(amount * GRAIN_STRENGTH);
}

/**
 * The grain a clip's picture is drawn with: its `grain` with defaults filled in, the seed from its id when it names
 * none (a subject-matte copy keeps its plate clip's id, so its grain lines up); null for none, an amount too small to
 * show, multicam shots and nested timeline clips (ADR 0043 decision 9). Export and the preview both ask this.
 */
export function grainOf(clip: { id: string; type: string; grain?: GrainFields | undefined }): ResolvedGrain | null {
  if (clip.type === "shot" || clip.type === "timeline" || !clip.grain) return null;
  const amount = clip.grain.amount ?? GRAIN_LIMITS.amount.default;
  const strength = grainStrength(amount);
  if (strength <= 1) return null;
  return { amount, size: clip.grain.size ?? GRAIN_LIMITS.size.default, seed: clip.grain.seed ?? grainSeed(clip.id), strength };
}

/** Frame of the grain pattern shown at timeline frame `frame`: the same whatever piece, segment or capture draws it. */
export function grainPhase(frame: number): number {
  return ((frame % GRAIN_PERIOD) + GRAIN_PERIOD) % GRAIN_PERIOD;
}

/**
 * Grain cells across a picture of `picture` pixels shown as a layer of `layer` project pixels: one cell per `size`
 * project pixels, at most one per picture pixel. Export's plate has this size, scaled up to the picture; the preview
 * interpolates the same lattice.
 */
export function grainPlate(size: number, layer: FrameSize, picture: FrameSize): FrameSize {
  const cells = (shown: number, pixels: number) => Math.min(pixels, Math.max(1, Math.round(shown / size)));
  return { width: cells(layer.width, picture.width), height: cells(layer.height, picture.height) };
}

/**
 * Expected mean and standard deviation of the luma change grain makes on a mid-grey picture: integer values uniform
 * over `strength` levels from `-floor(strength / 2)`, times 2/3 when the plate is smaller than the picture (`smooth`:
 * bilinear upscaling). Export's plate and the preview's pass are each held to it, not to each other's pixels.
 */
export function grainSpread(grain: ResolvedGrain, smooth: boolean): { mean: number; std: number } {
  const { strength } = grain;
  return { mean: (strength - 1) / 2 - Math.floor(strength / 2), std: Math.sqrt((strength * strength - 1) / 12) * (smooth ? 2 / 3 : 1) };
}
