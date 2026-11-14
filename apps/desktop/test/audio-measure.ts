// Measurements of synthetic test audio shared by the preview stretch tests (#499).

/** 1 ms moving mean of |x| at `rate`. */
export function envelope(x: Float32Array, rate = 48_000): Float32Array {
  const width = Math.round(rate / 1000);
  const out = new Float32Array(x.length);
  let sum = 0;
  for (let i = 0; i < x.length; i++) {
    sum += Math.abs(x[i]!);
    if (i >= width) sum -= Math.abs(x[i - width]!);
    out[i] = sum / width;
  }
  return out;
}

/** First sample of `x` whose {@link envelope} reaches `fraction` of its loudest, from sample `from` on; -1 if none. */
export function onset(x: Float32Array, fraction: number, from = 0): number {
  const level = envelope(x);
  let peak = 0;
  for (const value of level) peak = Math.max(peak, value);
  for (let i = from; i < level.length; i++) if (level[i]! >= fraction * peak) return i;
  return -1;
}

/** Last sample of `x` whose {@link envelope} is at `fraction` of its loudest or more; -1 if none. */
export function offset(x: Float32Array, fraction: number): number {
  const level = envelope(x);
  let peak = 0;
  for (const value of level) peak = Math.max(peak, value);
  for (let i = level.length - 1; i >= 0; i--) if (level[i]! >= fraction * peak) return i;
  return -1;
}

/** Frequency (Hz) of the strongest sinusoid in `x` between 50 Hz and 2 kHz: a Hann-windowed DFT, 1 Hz then 0.05 Hz steps. */
export function dominantHz(x: Float32Array, rate: number): number {
  const windowed = Float64Array.from(x, (value, n) => value * (0.5 - 0.5 * Math.cos((2 * Math.PI * n) / x.length)));
  const power = (hz: number): number => {
    const step = (2 * Math.PI * hz) / rate;
    let re = 0;
    let im = 0;
    for (let n = 0; n < windowed.length; n++) {
      re += windowed[n]! * Math.cos(step * n);
      im -= windowed[n]! * Math.sin(step * n);
    }
    return re * re + im * im;
  };
  const peak = (from: number, to: number, step: number): number => {
    let best = from;
    let top = -1;
    for (let hz = from; hz <= to; hz += step) {
      const value = power(hz);
      if (value > top) {
        top = value;
        best = hz;
      }
    }
    return best;
  };
  const coarse = peak(50, 2000, 1);
  return peak(coarse - 1, coarse + 1, 0.05);
}

/**
 * Lag (samples, positive when late) of the sinusoidal level swing of `x` over samples `[from, to)` (whole cycles of
 * it) behind `sin(omega * n + phase)`: the phase of the 10 ms mean of |x| at `omega` radians per sample.
 */
export function swingLag(x: Float32Array, omega: number, phase: number, from: number, to: number, rate = 48_000): number {
  const width = Math.round(rate / 100);
  let sum = 0;
  let s = 0;
  let c = 0;
  for (let i = 0; i < Math.min(x.length, to + width); i++) {
    sum += Math.abs(x[i]!);
    if (i >= width) sum -= Math.abs(x[i - width]!);
    // The mean of the `width` samples up to i belongs to the middle one.
    const n = i - Math.floor(width / 2);
    if (n < from || n >= to) continue;
    s += (sum / width) * Math.sin(omega * n);
    c += (sum / width) * Math.cos(omega * n);
  }
  let delta = phase - Math.atan2(c, s);
  delta -= 2 * Math.PI * Math.round(delta / (2 * Math.PI));
  return delta / omega;
}
