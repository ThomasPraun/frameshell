// Program audio mixer run by the AudioWorklet (ADR 0001). Pure: no Web Audio types, unit tested directly.

/** Web Audio render quantum, frames. */
export const QUANTUM = 128;
/** 2 ms at 48 kHz: edge fade at every segment start and end, hides the phase jump of a splice. */
export const EDGE_FADE_SAMPLES = 96;

/**
 * Samples to play from context frame `at` on. `fadeFrom`/`fadeTo` are the
 * frames of the segment's edges (a segment may arrive in many chunks): gain
 * ramps 0 to 1 over the first {@link EDGE_FADE_SAMPLES} after `fadeFrom` and
 * back to 0 at `fadeTo - 1`.
 */
export interface MixChunk {
  at: number;
  data: Float32Array;
  fadeFrom: number;
  fadeTo: number;
}

interface Queued extends MixChunk {
  /** Frame after the last sample played; lowered by cuts. */
  end: number;
}

/**
 * Context frame of each render quantum, as an AudioWorklet should count it.
 * Chromium's global `currentFrame` is wrong both ways (ADR 0001):
 * - it lags one quantum now and then while the worklet gets messages;
 *   indexing by it repeats a 128-sample block (an audible tick);
 * - the context renders quanta without calling `process()` (seen at start-up
 *   under load: 57 quanta), so counting calls falls behind it for
 *   good and everything scheduled on the context clock plays late.
 * A stale `currentFrame` is never ahead of the true frame, and a count of
 * calls never is either, so the frame is the later of the two.
 */
export class QuantumClock {
  #next = -1;

  /** Frame after the last quantum counted; -1 before the first. */
  get next(): number {
    return this.#next;
  }

  /** Frame of the quantum being rendered; call once per `process()` with the global `currentFrame`. */
  tick(currentFrame: number, size = QUANTUM): number {
    const frame = Math.max(this.#next, currentFrame);
    this.#next = frame + size;
    return frame;
  }
}

/**
 * Mixes scheduled chunks into render quanta at exact frames, counted by a
 * {@link QuantumClock}: a stale `currentFrame` never repeats a block, and
 * quanta the context skipped never make the program late.
 */
export class ProgramMixer {
  #queue: Queued[] = [];
  readonly #clock = new QuantumClock();

  /** Context frame of the next quantum; -1 before the first. */
  get position(): number {
    return this.#clock.next;
  }

  /** Chunks not fully played yet. */
  get pending(): number {
    return this.#queue.length;
  }

  /** Add a chunk; overlapping chunks are summed. */
  schedule(chunk: MixChunk): void {
    if (chunk.data.length === 0) return;
    this.#queue.push({ ...chunk, end: chunk.at + chunk.data.length });
  }

  /**
   * End everything scheduled at frame `at` with a fade-out into it; chunks
   * scheduled afterwards may start at `at`. A frame already played (or too
   * close to fade) cuts {@link EDGE_FADE_SAMPLES} after the next quantum starts.
   */
  cut(at: number): void {
    const earliest = Math.max(this.#clock.next, 0) + EDGE_FADE_SAMPLES;
    const frame = Math.max(at, earliest);
    for (const chunk of this.#queue) {
      chunk.end = Math.min(chunk.end, frame);
      chunk.fadeTo = Math.min(chunk.fadeTo, frame);
    }
    // Chunks scheduled after this call are not cut: they belong to what plays from `at` on.
    this.#queue = this.#queue.filter((chunk) => chunk.end > chunk.at);
  }

  /** Fade out within the next quantum and forget everything scheduled (pause, seek). */
  stop(): void {
    this.cut(0);
  }

  /** Mix one quantum into `out` (zeroed first); `currentFrame` is the worklet global, see {@link QuantumClock}. */
  render(out: Float32Array, currentFrame: number): void {
    const f0 = this.#clock.tick(currentFrame, out.length);
    const f1 = f0 + out.length;
    out.fill(0);
    let finished = false;
    for (const chunk of this.#queue) {
      if (chunk.end <= f0) {
        finished = true;
        continue;
      }
      if (chunk.at >= f1) continue;
      const a = Math.max(f0, chunk.at);
      const b = Math.min(f1, chunk.end);
      const { data, at, fadeFrom, fadeTo } = chunk;
      for (let f = a; f < b; f++) {
        const gain = Math.min(1, (f - fadeFrom) / EDGE_FADE_SAMPLES, (fadeTo - 1 - f) / EDGE_FADE_SAMPLES);
        if (gain > 0) out[f - f0]! += data[f - at]! * gain;
      }
      if (chunk.end <= f1) finished = true;
    }
    if (finished) this.#queue = this.#queue.filter((chunk) => chunk.end > f1);
  }
}
