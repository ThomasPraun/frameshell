/**
 * The median of the window `[i - half, i + half]` (clipped to the series) for every `i` of `values`: the upper middle
 * of an even window. One sorted window slides along, so a long film costs a search and a splice per frame.
 */
export function slidingMedians(values: ArrayLike<number>, half: number): Float64Array {
  const out = new Float64Array(values.length);
  const window: number[] = [];
  const at = (value: number) => {
    let low = 0;
    let high = window.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (window[mid]! < value) low = mid + 1;
      else high = mid;
    }
    return low;
  };
  for (let j = 0; j <= Math.min(values.length - 1, half); j++) window.splice(at(values[j]!), 0, values[j]!);
  for (let i = 0; i < values.length; i++) {
    if (i > 0) {
      if (i + half < values.length) window.splice(at(values[i + half]!), 0, values[i + half]!);
      if (i - half - 1 >= 0) window.splice(at(values[i - half - 1]!), 1);
    }
    out[i] = window[Math.floor(window.length / 2)]!;
  }
  return out;
}
