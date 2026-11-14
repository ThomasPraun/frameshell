/** A half-open range `[from, to)` of indexes. */
export interface IndexRange {
  from: number;
  to: number;
}

/**
 * Pearson correlation of `a[i]` and `b[i - lag]` over the indexes `i` that fall in `aRange` while `i - lag` falls in `bRange`
 * (so a positive `lag` pairs a sample of `a` with an earlier one of `b`). Null when fewer than `minSamples` pair up or
 * either side is flat over them.
 */
export function correlationAtLag(a: ArrayLike<number>, b: ArrayLike<number>, lag: number, aRange: IndexRange, bRange: IndexRange, minSamples = 2): number | null {
  const first = Math.max(aRange.from, bRange.from + lag);
  const last = Math.min(aRange.to, bRange.to + lag);
  const n = last - first;
  if (n < Math.max(2, minSamples)) return null;
  let sumA = 0;
  let sumB = 0;
  for (let i = first; i < last; i++) {
    sumA += a[i]!;
    sumB += b[i - lag]!;
  }
  const [meanA, meanB] = [sumA / n, sumB / n];
  let cov = 0;
  let varA = 0;
  let varB = 0;
  for (let i = first; i < last; i++) {
    const [da, db] = [a[i]! - meanA, b[i - lag]! - meanB];
    cov += da * db;
    varA += da * da;
    varB += db * db;
  }
  if (varA < 1e-9 || varB < 1e-9) return null;
  return cov / Math.sqrt(varA * varB);
}

/** The lag in `[-maxLag, maxLag]` at which {@link correlationAtLag} is highest, and its value; null when no lag has one. The smallest `|lag|` wins a tie. */
export function bestLag(a: ArrayLike<number>, b: ArrayLike<number>, maxLag: number, aRange: IndexRange, bRange: IndexRange, minSamples = 2): { lag: number; correlation: number } | null {
  let best: { lag: number; correlation: number } | null = null;
  for (let step = 0; step <= 2 * maxLag; step++) {
    // 0, -1, 1, -2, 2…: nearer lags first, so an equal match keeps the smaller shift.
    const lag = (step % 2 === 0 ? -step / 2 : (step + 1) / 2) + 0;
    const r = correlationAtLag(a, b, lag, aRange, bRange, minSamples);
    if (r !== null && (best === null || r > best.correlation + 1e-12)) best = { lag, correlation: r };
  }
  return best;
}
