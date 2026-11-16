// Video subject matte refinement (ADR 0032): pure per-frame and over-time steps between the model's coarse
// alpha and the luma matte. Order per frame: coarse alpha smoothed over time (forward then backward, no lag),
// snapped to the frame's own colour edges by a guided filter fitted small and applied at the frame's size,
// then steepened by a contrast curve.
import { PROXY_SHORT_SIDE } from "../media/recipe.js";

/** Picture size, in pixels. */
export interface PlaneSize {
  width: number;
  height: number;
}

/** Radius, in frame pixels, of the guided filter's window (the #461 recipe: r 8 at 540p). */
export const GUIDED_RADIUS = 8;
/** Regularization of the guided filter on 0..1 values: lower follows the guide's edges more closely. */
export const GUIDED_EPS = 2e-3;
/**
 * The guided filter's coefficients are fitted on a picture this many times smaller, then upscaled (He and
 * Sun's fast guided filter): about 3x faster at 540p, and the edges still come from the full-size guide.
 */
export const GUIDED_SUBSAMPLE = 2;
/**
 * Short side, pixels, {@link GUIDED_RADIUS} and {@link GUIDED_SUBSAMPLE} are meant for (the proxy's). A larger
 * frame scales both by {@link guidedScale}: the window still spans the coarse alpha's blur, the fit costs the same.
 */
export const GUIDED_REFERENCE_SHORT_SIDE = PROXY_SHORT_SIDE;
/** Slope of {@link contrast} around 0.5: soft edges from upscaling become a firmer edge. */
export const CONTRAST_GAIN = 1.6;
/** Time constant, seconds, of each pass of {@link emaWeight}'s exponential smoothing. */
export const TEMPORAL_TAU_S = 0.18;

/**
 * Plane of `from` size resampled bilinearly to `to` (pixel centers aligned), values unchanged in range.
 * Used both ways: model input down from the frame, coarse alpha up to the frame.
 */
export function resizeBilinear(src: Float32Array, from: PlaneSize, to: PlaneSize): Float32Array {
  const out = new Float32Array(to.width * to.height);
  const stepX = from.width / to.width;
  const stepY = from.height / to.height;
  for (let y = 0; y < to.height; y++) {
    const sy = Math.min(from.height - 1, Math.max(0, (y + 0.5) * stepY - 0.5));
    const y0 = Math.floor(sy);
    const y1 = Math.min(from.height - 1, y0 + 1);
    const fy = sy - y0;
    for (let x = 0; x < to.width; x++) {
      const sx = Math.min(from.width - 1, Math.max(0, (x + 0.5) * stepX - 0.5));
      const x0 = Math.floor(sx);
      const x1 = Math.min(from.width - 1, x0 + 1);
      const fx = sx - x0;
      const top = src[y0 * from.width + x0]! * (1 - fx) + src[y0 * from.width + x1]! * fx;
      const bottom = src[y1 * from.width + x0]! * (1 - fx) + src[y1 * from.width + x1]! * fx;
      out[y * to.width + x] = top * (1 - fy) + bottom * fy;
    }
  }
  return out;
}

/**
 * Mean of each pixel's `(2r+1)²` window, the window cut at the picture's border (divided by the pixels it
 * holds). Separable running sums, both passes in memory order: cost independent of `r`.
 */
export function boxMean(src: Float32Array, size: PlaneSize, r: number): Float32Array {
  const { width, height } = size;
  const inverse = (count: number) => {
    const out = new Float64Array(count);
    for (let i = 0; i < count; i++) out[i] = 1 / (Math.min(count - 1, i + r) - Math.max(0, i - r) + 1);
    return out;
  };
  const perX = inverse(width);
  const perY = inverse(height);
  const rows = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    let sum = 0;
    for (let x = 0; x <= Math.min(r, width - 1); x++) sum += src[row + x]!;
    for (let x = 0; x < width; x++) {
      rows[row + x] = sum * perX[x]!;
      if (x + r + 1 < width) sum += src[row + x + r + 1]!;
      if (x - r >= 0) sum -= src[row + x - r]!;
    }
  }
  // Column sums kept for a whole row at once, so the vertical pass also reads rows in order.
  const sums = new Float64Array(width);
  for (let y = 0; y <= Math.min(r, height - 1); y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) sums[x] = sums[x]! + rows[row + x]!;
  }
  const out = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    const k = perY[y]!;
    for (let x = 0; x < width; x++) out[row + x] = sums[x]! * k;
    if (y + r + 1 < height) {
      const add = (y + r + 1) * width;
      for (let x = 0; x < width; x++) sums[x] = sums[x]! + rows[add + x]!;
    }
    if (y - r >= 0) {
      const drop = (y - r) * width;
      for (let x = 0; x < width; x++) sums[x] = sums[x]! - rows[drop + x]!;
    }
  }
  return out;
}

/**
 * He et al.'s guided filter with a gray guide: `input` (0..1) refitted, window by window, as a linear function
 * of `guide` (0..1), so its edges move onto the guide's edges (hair, shoulders) while flat areas stay flat.
 * `r` is in pixels of `size`; with `subsample` above 1 the fit runs on a smaller copy (see {@link GUIDED_SUBSAMPLE}).
 * The matte uses {@link guidedFilterRgb}: a gray guide cannot part two colours of the same brightness.
 */
export function guidedFilter(
  guide: Float32Array,
  input: Float32Array,
  size: PlaneSize,
  r = GUIDED_RADIUS,
  eps = GUIDED_EPS,
  subsample = GUIDED_SUBSAMPLE,
): Float32Array {
  const s = Math.max(1, Math.floor(subsample));
  const small = s === 1 ? size : { width: Math.max(1, Math.round(size.width / s)), height: Math.max(1, Math.round(size.height / s)) };
  const g = s === 1 ? guide : resizeBilinear(guide, size, small);
  const p = s === 1 ? input : resizeBilinear(input, size, small);
  const radius = Math.max(1, Math.round(r / s));
  const n = small.width * small.height;
  const ii = new Float32Array(n);
  const ip = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    ii[i] = g[i]! * g[i]!;
    ip[i] = g[i]! * p[i]!;
  }
  const meanI = boxMean(g, small, radius);
  const meanP = boxMean(p, small, radius);
  const corrI = boxMean(ii, small, radius);
  const corrIp = boxMean(ip, small, radius);
  // Reuse the product buffers for the per-window coefficients.
  const a = ii;
  const b = ip;
  for (let i = 0; i < n; i++) {
    const variance = corrI[i]! - meanI[i]! * meanI[i]!;
    const covariance = corrIp[i]! - meanI[i]! * meanP[i]!;
    a[i] = covariance / (variance + eps);
    b[i] = meanP[i]! - a[i]! * meanI[i]!;
  }
  const meanA = s === 1 ? boxMean(a, small, radius) : resizeBilinear(boxMean(a, small, radius), small, size);
  const meanB = s === 1 ? boxMean(b, small, radius) : resizeBilinear(boxMean(b, small, radius), small, size);
  const out = new Float32Array(size.width * size.height);
  for (let i = 0; i < out.length; i++) out[i] = meanA[i]! * guide[i]! + meanB[i]!;
  return out;
}

/** Factor {@link GUIDED_RADIUS} and {@link GUIDED_SUBSAMPLE} are scaled by for a frame of `size`: 1 up to 540p, 4 at 2160p. */
export function guidedScale(size: PlaneSize): number {
  return Math.max(1, Math.min(size.width, size.height) / GUIDED_REFERENCE_SHORT_SIDE);
}

/** Guided filter settings; the defaults are the #461 recipe scaled to the frame by {@link guidedScale}. */
export interface GuidedOptions {
  /** Window radius, pixels of the frame. */
  radius?: number;
  /** Regularization, see {@link GUIDED_EPS}. */
  eps?: number;
  /** The fit runs on a copy this many times smaller, see {@link GUIDED_SUBSAMPLE}. */
  subsample?: number;
}

/** Window-averaged coefficients of `q = ar*R + ag*G + ab*B + b` (R, G, B as bytes), at the fit's size. */
interface RgbCoefficients {
  size: PlaneSize;
  ar: Float32Array;
  ag: Float32Array;
  ab: Float32Array;
  b: Float32Array;
}

type Planes9 = [Float32Array, Float32Array, Float32Array, Float32Array, Float32Array, Float32Array, Float32Array, Float32Array, Float32Array];

/**
 * He et al.'s guided filter with a colour guide: `input` (0..1 at `inputSize`, resampled as needed) refitted,
 * window by window, as a linear function of the three channels of `rgb` (packed 8-bit RGB at `size`), so its
 * edges move onto the frame's colour edges, also where both sides are equally bright (dark hair on a dark wall of
 * another hue). Fitted on a copy {@link GuidedOptions.subsample} times smaller (fast guided filter) and applied at
 * `size`, so the edges come from the full-size frame. Returns the filtered plane at `size`, not clamped.
 */
export function guidedFilterRgb(rgb: Uint8Array, size: PlaneSize, input: Float32Array, inputSize: PlaneSize, options: GuidedOptions = {}): Float32Array {
  const out = new Float32Array(size.width * size.height);
  applyRgbCoefficients(fitRgbCoefficients(rgb, size, input, inputSize, options), rgb, size, out);
  return out;
}

/**
 * Luma matte of one frame: `coarse` alpha (0..1 at `coarseSize`) snapped by {@link guidedFilterRgb} to the colour
 * edges of `rgb` (packed 8-bit RGB at `size`; any size, the window scales by {@link guidedScale}), contrast
 * applied, as bytes 0 (background) to 255 (subject). Holds no full-size float plane: at 3840x2160 it allocates
 * the 8 MB result plus about 10 MB at the fit's size.
 */
export function refineFrame(coarse: Float32Array, coarseSize: PlaneSize, rgb: Uint8Array, size: PlaneSize): Uint8Array {
  const out = new Uint8Array(size.width * size.height);
  applyRgbCoefficients(fitRgbCoefficients(rgb, size, coarse, coarseSize, {}), rgb, size, out);
  return out;
}

function fitRgbCoefficients(rgb: Uint8Array, size: PlaneSize, input: Float32Array, inputSize: PlaneSize, options: GuidedOptions): RgbCoefficients {
  const scale = guidedScale(size);
  const s = Math.max(1, Math.floor(options.subsample ?? GUIDED_SUBSAMPLE * scale));
  const eps = options.eps ?? GUIDED_EPS;
  const small = s === 1 ? size : { width: Math.max(1, Math.round(size.width / s)), height: Math.max(1, Math.round(size.height / s)) };
  const radius = Math.max(1, Math.round((options.radius ?? GUIDED_RADIUS * scale) / s));
  const [r, g, bl] = shrinkRgb(rgb, size, small);
  const p = inputSize.width === small.width && inputSize.height === small.height ? input : resizeBilinear(input, inputSize, small);
  const n = small.width * small.height;
  const products = Array.from({ length: 9 }, () => new Float32Array(n)) as Planes9;
  const [rr, rg, rb, gg, gb, bb, rp, gp, bp] = products;
  for (let i = 0; i < n; i++) {
    const ri = r[i]!;
    const gi = g[i]!;
    const bi = bl[i]!;
    const pi = p[i]!;
    rr[i] = ri * ri;
    rg[i] = ri * gi;
    rb[i] = ri * bi;
    gg[i] = gi * gi;
    gb[i] = gi * bi;
    bb[i] = bi * bi;
    rp[i] = ri * pi;
    gp[i] = gi * pi;
    bp[i] = bi * pi;
  }
  const mean = (plane: Float32Array) => boxMean(plane, small, radius);
  const [mr, mg, mb, mp] = [mean(r), mean(g), mean(bl), mean(p)];
  const [crr, crg, crb, cgg, cgb, cbb, crp, cgp, cbp] = products.map(mean) as Planes9;
  // The product planes are spent: four of them take the coefficients.
  const [ar, ag, ab, b] = [rr, rg, rb, gg];
  for (let i = 0; i < n; i++) {
    const r0 = mr[i]!;
    const g0 = mg[i]!;
    const b0 = mb[i]!;
    const p0 = mp[i]!;
    // Window covariance of the guide with eps on its diagonal (symmetric 3x3), and of guide and input.
    const s00 = crr[i]! - r0 * r0 + eps;
    const s01 = crg[i]! - r0 * g0;
    const s02 = crb[i]! - r0 * b0;
    const s11 = cgg[i]! - g0 * g0 + eps;
    const s12 = cgb[i]! - g0 * b0;
    const s22 = cbb[i]! - b0 * b0 + eps;
    const c0 = crp[i]! - r0 * p0;
    const c1 = cgp[i]! - g0 * p0;
    const c2 = cbp[i]! - b0 * p0;
    // Inverse by cofactors; eps keeps the matrix positive definite, so the determinant is at least eps³.
    const i00 = s11 * s22 - s12 * s12;
    const i01 = s02 * s12 - s01 * s22;
    const i02 = s01 * s12 - s02 * s11;
    const i11 = s00 * s22 - s02 * s02;
    const i12 = s01 * s02 - s00 * s12;
    const i22 = s00 * s11 - s01 * s01;
    const det = s00 * i00 + s01 * i01 + s02 * i02;
    const a0 = (i00 * c0 + i01 * c1 + i02 * c2) / det;
    const a1 = (i01 * c0 + i11 * c1 + i12 * c2) / det;
    const a2 = (i02 * c0 + i12 * c1 + i22 * c2) / det;
    ar[i] = a0;
    ag[i] = a1;
    ab[i] = a2;
    b[i] = p0 - a0 * r0 - a1 * g0 - a2 * b0;
  }
  // Fitted on channels in 0..1, applied to bytes.
  const perByte = (plane: Float32Array) => {
    const averaged = mean(plane);
    for (let i = 0; i < n; i++) averaged[i] = averaged[i]! / 255;
    return averaged;
  };
  return { size: small, ar: perByte(ar), ag: perByte(ag), ab: perByte(ab), b: mean(b) };
}

/** Packed 8-bit RGB of `size` shrunk to `to` by area averaging (no aliasing even 8 times smaller), as three 0..1 planes. */
function shrinkRgb(rgb: Uint8Array, size: PlaneSize, to: PlaneSize): [Float32Array, Float32Array, Float32Array] {
  const n = to.width * to.height;
  // Integer sums: exact, and faster than float adds.
  const sums = [new Uint32Array(n), new Uint32Array(n), new Uint32Array(n)] as const;
  const [red, green, blue] = sums;
  const column = new Int32Array(size.width);
  const columns = new Uint32Array(to.width);
  const rows = new Uint32Array(to.height);
  for (let x = 0; x < size.width; x++) {
    column[x] = Math.min(to.width - 1, Math.floor((x * to.width) / size.width));
    columns[column[x]!]!++;
  }
  for (let y = 0; y < size.height; y++) {
    const target = Math.min(to.height - 1, Math.floor((y * to.height) / size.height));
    rows[target]!++;
    const row = target * to.width;
    let at = y * size.width * 3;
    for (let x = 0; x < size.width; x++, at += 3) {
      const i = row + column[x]!;
      red[i]! += rgb[at]!;
      green[i]! += rgb[at + 1]!;
      blue[i]! += rgb[at + 2]!;
    }
  }
  const planes = sums.map(() => new Float32Array(n)) as [Float32Array, Float32Array, Float32Array];
  for (let y = 0; y < to.height; y++) {
    for (let x = 0; x < to.width; x++) {
      const i = y * to.width + x;
      const k = 1 / (255 * Math.max(1, rows[y]! * columns[x]!));
      for (let c = 0; c < 3; c++) planes[c]![i] = sums[c]![i]! * k;
    }
  }
  return planes;
}

/**
 * `coefficients` upsampled bilinearly (pixel centers aligned, as {@link resizeBilinear}) and applied to each pixel
 * of `rgb`, one row at a time so no full-size coefficient plane is held. Into bytes, the result goes through
 * {@link contrast} and is rounded to 0..255.
 */
function applyRgbCoefficients(coefficients: RgbCoefficients, rgb: Uint8Array, size: PlaneSize, out: Float32Array | Uint8Array): void {
  const { size: small, ar, ag, ab, b } = coefficients;
  const { width, height } = size;
  const x0 = new Int32Array(width);
  const x1 = new Int32Array(width);
  const fx = new Float32Array(width);
  const stepX = small.width / width;
  for (let x = 0; x < width; x++) {
    const sx = Math.min(small.width - 1, Math.max(0, (x + 0.5) * stepX - 0.5));
    x0[x] = Math.floor(sx);
    x1[x] = Math.min(small.width - 1, x0[x]! + 1);
    fx[x] = sx - x0[x]!;
  }
  const planes = [ar, ag, ab, b];
  const rows = planes.map(() => new Float32Array(small.width));
  const [rowR, rowG, rowB, rowC] = rows as [Float32Array, Float32Array, Float32Array, Float32Array];
  const line = new Float32Array(width);
  // Bytes: `contrast` folded into one multiply-add; a clamped array clamps to 0..255 and rounds on store.
  const bytes = out instanceof Uint8Array ? new Uint8ClampedArray(out.buffer, out.byteOffset, out.length) : null;
  const slope = CONTRAST_GAIN * 255;
  const offset = 127.5 - 0.5 * slope;
  const stepY = small.height / height;
  for (let y = 0; y < height; y++) {
    const sy = Math.min(small.height - 1, Math.max(0, (y + 0.5) * stepY - 0.5));
    const top = Math.floor(sy) * small.width;
    const bottom = Math.min(small.height - 1, Math.floor(sy) + 1) * small.width;
    const fy = sy - Math.floor(sy);
    for (let k = 0; k < 4; k++) {
      const plane = planes[k]!;
      const row = rows[k]!;
      for (let x = 0; x < small.width; x++) row[x] = plane[top + x]! + (plane[bottom + x]! - plane[top + x]!) * fy;
    }
    let px = y * width * 3;
    for (let x = 0; x < width; x++, px += 3) {
      const l = x0[x]!;
      const h = x1[x]!;
      const f = fx[x]!;
      line[x] =
        (rowR[l]! + (rowR[h]! - rowR[l]!) * f) * rgb[px]! +
        (rowG[l]! + (rowG[h]! - rowG[l]!) * f) * rgb[px + 1]! +
        (rowB[l]! + (rowB[h]! - rowB[l]!) * f) * rgb[px + 2]! +
        (rowC[l]! + (rowC[h]! - rowC[l]!) * f);
    }
    const at = y * width;
    if (bytes) for (let x = 0; x < width; x++) bytes[at + x] = line[x]! * slope + offset;
    else out.set(line, at);
  }
}

/** `(v - 0.5) * gain + 0.5`, clamped to 0..1: the #461 recipe's contrast step. */
export function contrast(value: number, gain = CONTRAST_GAIN): number {
  return Math.min(1, Math.max(0, (value - 0.5) * gain + 0.5));
}

/**
 * Weight of the newest frame in one exponential smoothing pass at `fps` with time constant `tau` seconds:
 * `1 - exp(-1 / (fps * tau))`, so the smoothing lasts the same time at any frame rate.
 */
export function emaWeight(fps: number, tau = TEMPORAL_TAU_S): number {
  return 1 - Math.exp(-1 / (Math.max(1e-3, fps) * Math.max(1e-6, tau)));
}

/** One smoothing step in place: `state = weight * frame + (1 - weight) * state`; the first frame is copied. */
export function emaStep(state: Float32Array | null, frame: ArrayLike<number>, weight: number): Float32Array {
  if (!state) return Float32Array.from(frame);
  for (let i = 0; i < state.length; i++) state[i] = weight * frame[i]! + (1 - weight) * state[i]!;
  return state;
}

/**
 * Frames smoothed forward then backward with {@link emaStep} (zero phase, as `filtfilt`): a still edge stays
 * put, a moving one is not dragged behind, and frame-to-frame flicker shrinks. In memory: for tests and short
 * runs; the matte job runs the same two passes over a file.
 */
export function smoothForwardBackward(frames: readonly ArrayLike<number>[], weight: number): Float32Array[] {
  const forward: Float32Array[] = [];
  let state: Float32Array | null = null;
  for (const frame of frames) {
    state = emaStep(state, frame, weight);
    forward.push(Float32Array.from(state));
  }
  const out: Float32Array[] = new Array(forward.length);
  state = null;
  for (let t = forward.length - 1; t >= 0; t--) {
    state = emaStep(state, forward[t]!, weight);
    out[t] = Float32Array.from(state);
  }
  return out;
}
