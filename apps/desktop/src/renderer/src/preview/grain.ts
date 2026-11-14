// Preview grain (ADR 0043 decision 6): a hash lattice over the picture that shows, bilinear between cells, matched to
// export's ffmpeg `noise` plate by its spread (`grainSpread`), not its pixels. The grade pass's shader (`grade.ts`)
// runs these same steps; preview-grain.test.ts holds this model to `grainSpread`.
import type { LayerRect } from "@frameshell/schema/composite";
import type { FrameSize, ResolvedGrain } from "@frameshell/schema/finish";

/** What the pass needs to grain one picture. */
export interface PictureGrain {
  grain: ResolvedGrain;
  /** Grain cells across `crop` (`grainPlate`). */
  plate: FrameSize;
  /** Pattern frame shown (`grainPhase` of the timeline frame). */
  phase: number;
  /** Pixels of the picture that show, in texture pixels: the lattice spans them. */
  crop: LayerRect;
}

/** 32-bit integer mix (Wellons' lowbias32): the shader's `mixBits`, bit for bit. */
export function mixBits(value: number): number {
  let x = value >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d);
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b);
  x ^= x >>> 16;
  return x >>> 0;
}

/**
 * Value of lattice cell (`x`, `y`), clamped into the plate: an integer uniform over `strength` levels from
 * `-floor(strength / 2)`, as ffmpeg `noise` draws them, from the cell, phase and seed.
 */
export function grainCell(x: number, y: number, look: PictureGrain): number {
  const { plate, phase, grain } = look;
  const cx = Math.min(Math.max(x, 0), plate.width - 1);
  const cy = Math.min(Math.max(y, 0), plate.height - 1);
  const hash = mixBits(cx ^ mixBits(cy ^ mixBits(phase ^ mixBits(grain.seed))));
  return (((hash >>> 16) * grain.strength) >>> 16) - Math.floor(grain.strength / 2);
}

/** Levels texel (`x`, `y`) of the picture moves by: the lattice read bilinearly at the texel's centre, rounded. */
export function grainDelta(x: number, y: number, look: PictureGrain): number {
  const { crop, plate } = look;
  const px = ((x + 0.5 - crop.left) * plate.width) / crop.width - 0.5;
  const py = ((y + 0.5 - crop.top) * plate.height) / crop.height - 0.5;
  const ix = Math.floor(px);
  const iy = Math.floor(py);
  const fx = px - ix;
  const fy = py - iy;
  const top = grainCell(ix, iy, look) + (grainCell(ix + 1, iy, look) - grainCell(ix, iy, look)) * fx;
  const bottom = grainCell(ix, iy + 1, look) + (grainCell(ix + 1, iy + 1, look) - grainCell(ix, iy + 1, look)) * fx;
  return Math.floor(top + (bottom - top) * fy + 0.5);
}
