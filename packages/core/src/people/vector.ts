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

/**
 * Average-linkage (UPGMA) clustering of vectors by cosine similarity, keeping
 * merges at `cut.threshold` or above, or the best merges that leave
 * `cut.count` groups (every vector alone when there are fewer). The nearest-neighbour
 * chain finds the same merges as greedy best-pair merging in O(n²) time; average
 * linkage is reducible, so either cut keeps the merges above a line.
 * Returns groups of indexes, each sorted, in order of their first index.
 */
export function averageLinkage(vectors: readonly ArrayLike<number>[], cut: { threshold: number } | { count: number }): number[][] {
  const n = vectors.length;
  if (n === 0) return [];
  const sim = new Float32Array(n * n);
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) sim[i * n + j] = sim[j * n + i] = cosine(vectors[i]!, vectors[j]!);
  const size = new Array<number>(n).fill(1);
  const active = new Array<boolean>(n).fill(true);
  const merges: { a: number; b: number; score: number }[] = [];
  const chain: number[] = [];
  let left = n;
  while (left > 1) {
    if (chain.length === 0) chain.push(active.indexOf(true));
    const top = chain[chain.length - 1]!;
    const previous = chain.length > 1 ? chain[chain.length - 2]! : -1;
    // Ties prefer the previous link, so the chain always ends at a reciprocal pair.
    let next = previous;
    let best = previous >= 0 ? sim[top * n + previous]! : -Infinity;
    for (let k = 0; k < n; k++) {
      if (!active[k] || k === top) continue;
      if (sim[top * n + k]! > best) {
        best = sim[top * n + k]!;
        next = k;
      }
    }
    if (next !== previous) {
      chain.push(next);
      continue;
    }
    chain.length -= 2;
    merges.push({ a: top, b: previous, score: best });
    // Lance-Williams update: the merged group lives on in `previous`.
    for (let k = 0; k < n; k++) {
      if (!active[k] || k === top || k === previous) continue;
      const value = (size[top]! * sim[top * n + k]! + size[previous]! * sim[previous * n + k]!) / (size[top]! + size[previous]!);
      sim[previous * n + k] = sim[k * n + previous] = value;
    }
    size[previous]! += size[top]!;
    active[top] = false;
    left--;
  }
  const kept =
    "count" in cut ? [...merges].sort((a, b) => b.score - a.score).slice(0, Math.max(0, n - cut.count)) : merges.filter((merge) => merge.score >= cut.threshold);
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  for (const { a, b } of kept) parent[find(a)] = find(b);
  const groups = new Map<number, number[]>();
  for (let i = 0; i < n; i++) groups.set(find(i), [...(groups.get(find(i)) ?? []), i]);
  return [...groups.values()].sort((a, b) => a[0]! - b[0]!);
}
