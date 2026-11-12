/** Smallest power of two that is at least `n` (1 for `n` <= 1). */
export function nextPowerOfTwo(n: number): number {
  let size = 1;
  while (size < n) size *= 2;
  return size;
}

/** Twiddle factors `exp(-2πik/n)` for k < n/2, per transform length. */
const twiddles = new Map<number, { cos: Float64Array; sin: Float64Array }>();

function twiddlesOf(n: number): { cos: Float64Array; sin: Float64Array } {
  let table = twiddles.get(n);
  if (!table) {
    const cos = new Float64Array(n / 2);
    const sin = new Float64Array(n / 2);
    for (let k = 0; k < n / 2; k++) {
      cos[k] = Math.cos((2 * Math.PI * k) / n);
      sin[k] = -Math.sin((2 * Math.PI * k) / n);
    }
    table = { cos, sin };
    twiddles.set(n, table);
  }
  return table;
}

/**
 * In-place iterative radix-2 FFT of the complex signal `re` + i·`im`; the
 * length must be a power of two. `inverse` also divides by the length.
 * The one FFT of `core`: multicam sync correlates with it, the beat detector
 * takes spectra with it (`people/fbank.ts` keeps its own, pinned to a
 * reference by test).
 */
export function fft(re: Float64Array, im: Float64Array, inverse: boolean): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tRe = re[i]!;
      const tIm = im[i]!;
      re[i] = re[j]!;
      im[i] = im[j]!;
      re[j] = tRe;
      im[j] = tIm;
    }
  }
  const table = twiddlesOf(n);
  const sign = inverse ? -1 : 1;
  for (let length = 2; length <= n; length <<= 1) {
    const half = length >> 1;
    const step = n / length;
    for (let start = 0; start < n; start += length) {
      for (let k = 0; k < half; k++) {
        const wRe = table.cos[k * step]!;
        const wIm = sign * table.sin[k * step]!;
        const a = start + k;
        const b = a + half;
        const tRe = re[b]! * wRe - im[b]! * wIm;
        const tIm = re[b]! * wIm + im[b]! * wRe;
        re[b] = re[a]! - tRe;
        im[b] = im[a]! - tIm;
        re[a] = re[a]! + tRe;
        im[a] = im[a]! + tIm;
      }
    }
  }
  if (inverse) {
    for (let i = 0; i < n; i++) {
      re[i] = re[i]! / n;
      im[i] = im[i]! / n;
    }
  }
}
