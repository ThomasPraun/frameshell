// Video subject matte refinement (ADR 0032): pure per-frame and over-time steps between the model's coarse
// alpha and the luma matte. Order per frame: coarse alpha smoothed over time (forward then backward, no lag),
// upscaled to the frame, snapped to the frame's own edges by a guided filter, then steepened by a contrast curve.

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
 * holds). Separable running sums: cost independent of `r`.
 */
export function boxMean(src: Float32Array, size: PlaneSize, r: number): Float32Array {
  const { width, height } = size;
  const rows = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    let sum = 0;
    for (let x = 0; x <= Math.min(r, width - 1); x++) sum += src[row + x]!;
    for (let x = 0; x < width; x++) {
      const lo = Math.max(0, x - r);
      const hi = Math.min(width - 1, x + r);
      rows[row + x] = sum / (hi - lo + 1);
      if (x + r + 1 < width) sum += src[row + x + r + 1]!;
      if (x - r >= 0) sum -= src[row + x - r]!;
    }
  }
  const out = new Float32Array(width * height);
  for (let x = 0; x < width; x++) {
    let sum = 0;
    for (let y = 0; y <= Math.min(r, height - 1); y++) sum += rows[y * width + x]!;
    for (let y = 0; y < height; y++) {
      const lo = Math.max(0, y - r);
      const hi = Math.min(height - 1, y + r);
      out[y * width + x] = sum / (hi - lo + 1);
      if (y + r + 1 < height) sum += rows[(y + r + 1) * width + x]!;
      if (y - r >= 0) sum -= rows[(y - r) * width + x]!;
    }
  }
  return out;
}

/**
 * He et al.'s guided filter with a gray guide: `input` (0..1) refitted, window by window, as a linear function
 * of `guide` (0..1), so its edges move onto the guide's edges (hair, shoulders) while flat areas stay flat.
 * `r` is in pixels of `size`; with `subsample` above 1 the fit runs on a smaller copy (see {@link GUIDED_SUBSAMPLE}).
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

/**
 * Luma matte of one frame: `coarse` alpha (0..1 at `coarseSize`) upscaled to `size`, guided by `gray`
 * (0..1 at `size`), contrast applied, as bytes 0 (background) to 255 (subject).
 */
export function refineFrame(coarse: Float32Array, coarseSize: PlaneSize, gray: Float32Array, size: PlaneSize): Uint8Array {
  const up = coarseSize.width === size.width && coarseSize.height === size.height ? coarse : resizeBilinear(coarse, coarseSize, size);
  const guided = guidedFilter(gray, up, size);
  const out = new Uint8Array(size.width * size.height);
  for (let i = 0; i < out.length; i++) out[i] = Math.round(contrast(guided[i]!) * 255);
  return out;
}

/** Gray guide 0..1 (BT.601 luma weights) of packed 8-bit RGB. */
export function grayOfRgb(rgb: Uint8Array): Float32Array {
  const out = new Float32Array(rgb.length / 3);
  for (let i = 0; i < out.length; i++) out[i] = (0.299 * rgb[i * 3]! + 0.587 * rgb[i * 3 + 1]! + 0.114 * rgb[i * 3 + 2]!) / 255;
  return out;
}
