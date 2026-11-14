// Pitch-keeping time stretch of a program audio span at clip speed ≠ 1 (#499), the preview's twin of export `atempo`.
// WSOLA: Hann frames every HOP program samples counted from the span's start, each read from the source where the
// speed puts its centre, moved by up to SEARCH samples so it lines up with the frame before it. That alignment is a
// chain: a StretchChain carries it from one read of a span to the next, so a play hears one chain from where it
// started; a fresh chain starts with its first frame exactly where the speed puts it. Pure apart from the chain.

/** Frame length, samples: export `atempo`'s window at the sidecar's 48 kHz (`rate / 24` up to a power of two). */
export const STRETCH_WINDOW = 2048;
const HOP = STRETCH_WINDOW / 2;
/** Farthest a frame moves from where the speed puts it: half a period of 47 Hz, below any voice. */
const SEARCH = STRETCH_WINDOW / 4;
/** Coarse search: every 2nd move over every 4th sample, then the best one ±1 over every sample. */
const COARSE_STEP = 2;
const COARSE_STRIDE = 4;
const COARSE_MOVES = Array.from({ length: (2 * SEARCH) / COARSE_STEP + 1 }, (_, n) => n * COARSE_STEP - SEARCH);
/**
 * Correlation a move of SEARCH samples must win by: of moves that line up about as well (on a held note, every period
 * does), the one nearest where the speed puts the frame wins, so the sound does not sit early or late.
 */
const MOVE_COST = 0.05;

// Periodic Hann: two frames half a window apart sum to exactly 1.
const HANN = Float64Array.from({ length: STRETCH_WINDOW }, (_, n) => 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / STRETCH_WINDOW));

/**
 * What the stretch needs of an `AudioSpan`: program samples `[start, end)` play source samples from `in` on, `speed`
 * source samples per program sample.
 */
export interface StretchSpan {
  start: number;
  end: number;
  in: number;
  speed: number;
}

/**
 * Source sample at the centre of each frame of one span, as reads of it in order compute them: the next read
 * continues the alignment where the last one left it. A read that does not follow on (a seek, a gap) starts it over.
 */
export class StretchChain {
  /** Frame of `centres[0]`. */
  #head = 0;
  #centres: number[] = [];

  /** Centres of frames `[from, to]`, computing the missing ones with `align(previous centre, nominal centre)`. */
  centres(from: number, to: number, nominalOf: (frame: number) => number, align: (previous: number, nominal: number) => number): number[] {
    const end = this.#head + this.#centres.length;
    if (this.#centres.length === 0 || from < this.#head || from > end) {
      this.#head = from;
      this.#centres = [nominalOf(from)];
    } else if (from > this.#head) {
      // Keep the frame before `from`: the next new frame aligns to it.
      const keep = Math.max(0, from - 1 - this.#head);
      this.#centres = this.#centres.slice(keep);
      this.#head += keep;
    }
    for (let k = this.#head + this.#centres.length; k <= to; k++) {
      const nominal = nominalOf(k);
      this.#centres.push(nominal + align(this.#centres[k - 1 - this.#head]!, nominal));
    }
    return this.#centres.slice(from - this.#head, to - this.#head + 1);
  }
}

/** Source samples `[first, first + count)` that {@link stretch} reads for program samples `[from, to)` of `span`. */
export function stretchWindow(span: StretchSpan, from: number, to: number): { first: number; count: number } {
  if (to <= from) return { first: 0, count: 0 };
  const { lo, hi } = bounds(span, from, to);
  const range = played(span);
  const first = Math.max(0, lo, range.lo);
  return { first, count: Math.max(0, Math.min(hi, range.hi) - first) };
}

/**
 * Program samples `[from, to)` of `span`, stretched to keep the pitch. `source` holds mono source samples from
 * `first` on (the {@link stretchWindow} of the same samples); positions it lacks, and source outside the part the
 * span plays (export trims before `atempo`, so a cut word never bleeds in), are silence. `chain` carries the
 * alignment over from the read before (the same span's samples up to `from`); without one the read starts its own.
 */
export function stretch(span: StretchSpan, from: number, to: number, source: Float32Array, first: number, chain = new StretchChain()): Float32Array {
  const out = new Float32Array(Math.max(0, to - from));
  if (out.length === 0) return out;
  const { lo, hi, head, last } = bounds(span, from, to);
  // The window as one array, silent where the source has nothing or the span plays nothing: every index below stays
  // inside it.
  const window = new Float32Array(hi - lo);
  const range = played(span);
  const a = Math.max(lo, first, range.lo);
  const b = Math.min(hi, first + source.length, range.hi);
  if (b > a) window.set(source.subarray(a - first, b - first), a - lo);
  const centres = chain.centres(head, last, (k) => nominal(span, k), (previous, base) => offset(window, previous - lo, base - lo));
  for (let i = 0; i < out.length; i++) {
    const j = from + i - span.start;
    const k = Math.floor(j / HOP);
    const u = j - k * HOP;
    // Frame k past its centre, frame k + 1 before its centre.
    const past = window[centres[k - head]! - lo + u] ?? 0;
    const before = window[centres[k + 1 - head]! - lo - HOP + u] ?? 0;
    out[i] = HANN[HOP + u]! * past + HANN[u]! * before;
  }
  return out;
}

/** Frames `head..last` that program samples `[from, to)` hear and the source `[lo, hi)` they and their search read. */
function bounds(span: StretchSpan, from: number, to: number): { head: number; last: number; lo: number; hi: number } {
  const head = Math.floor((from - span.start) / HOP);
  const last = Math.floor((to - 1 - span.start) / HOP) + 1;
  // From the frame before `head`: a chain carried over aligns the first new frame to it.
  const lo = nominal(span, head - 1) - HOP - SEARCH;
  return { head, last, lo, hi: nominal(span, last) + HOP + SEARCH + 1 };
}

/** Source samples `[lo, hi)` the span plays: its frames may reach past them, by up to HOP * speed + SEARCH. */
function played(span: StretchSpan): { lo: number; hi: number } {
  return { lo: Math.ceil(span.in), hi: Math.ceil(span.in + (span.end - span.start) * span.speed) };
}

/** Source sample the speed puts at the centre of frame `k`. */
function nominal(span: StretchSpan, k: number): number {
  return Math.round(span.in + k * HOP * span.speed);
}

/**
 * Move of the frame centred near `base` that best continues the frame centred at `previous` (indexes into `window`):
 * where the two overlap, the previous frame plays `previous + m` and this one `base + move - HOP + m`, for m in
 * `[0, HOP)`; the move maximizes their correlation coefficient less {@link MOVE_COST} per SEARCH moved. Silence there
 * keeps the frame where the speed puts it.
 */
function offset(window: Float32Array, previous: number, base: number): number {
  const energy = (stride: number) => {
    let sum = 0;
    for (let m = 0; m < HOP; m += stride) sum += window[previous + m]! ** 2;
    return sum;
  };
  const coarseEnergy = energy(COARSE_STRIDE);
  if (coarseEnergy < 1e-9) return 0;
  const score = (move: number, stride: number, target: number): number => {
    const start = base + move - HOP;
    let dot = 0;
    let power = 0;
    for (let m = 0; m < HOP; m += stride) {
      const value = window[start + m]!;
      dot += window[previous + m]! * value;
      power += value * value;
    }
    return (power > 0 ? dot / Math.sqrt(power * target) : 0) - (MOVE_COST * Math.abs(move)) / SEARCH;
  };
  const best = (moves: Iterable<number>, stride: number): number => {
    const target = stride === COARSE_STRIDE ? coarseEnergy : energy(stride);
    let chosen = 0;
    let top = -Infinity;
    for (const move of moves) {
      const value = score(move, stride, target);
      if (value > top) {
        top = value;
        chosen = move;
      }
    }
    return chosen;
  };
  const near = best(COARSE_MOVES, COARSE_STRIDE);
  return best([near - 1, near, near + 1].filter((move) => Math.abs(move) <= SEARCH), 1);
}
