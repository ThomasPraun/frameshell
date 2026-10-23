/** Cosine similarity of two vectors of the same length (-1..1); 0 when either is all zeros. */
export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

/** Euclidean length of `vector`. */
function length(vector: ArrayLike<number>): number {
  let sum = 0;
  for (let i = 0; i < vector.length; i++) sum += vector[i]! * vector[i]!;
  return Math.sqrt(sum);
}

/** `vector` scaled to length 1; null when it is all zeros. */
export function unit(vector: ArrayLike<number>): number[] | null {
  const size = length(vector);
  return size === 0 ? null : Array.from({ length: vector.length }, (_, i) => vector[i]! / size);
}

/**
 * Mean direction of embeddings: each scaled to length 1 and by its weight (default 1), summed, scaled to
 * length 1. Null when there are none or they cancel out; all-zero vectors are skipped.
 */
export function meanDirection(vectors: readonly ArrayLike<number>[], weights?: readonly number[]): number[] | null {
  const first = vectors[0];
  if (!first) return null;
  const sum = new Array<number>(first.length).fill(0);
  vectors.forEach((vector, k) => {
    const size = length(vector);
    if (size === 0) return;
    const scale = (weights?.[k] ?? 1) / size;
    for (let i = 0; i < sum.length; i++) sum[i]! += vector[i]! * scale;
  });
  return unit(sum);
}
