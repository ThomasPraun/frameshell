// Dropped program frames of a play, by why they were dropped (ADR 0001 amendment, #567). Runs in the engine worker.

/** Program frames a play passed over without drawing them, by kind. */
export interface PlayDrops {
  /** Due at a display tick of the engine but not decoded then: the engine's budget (ADR 0001 threshold 3). */
  starved: number[];
  /** Never due at any tick: the host gave the engine no display tick while the frame was due (scheduling, not decode). */
  cadence: number[];
}

/**
 * Classifies the frames a play skips. The engine reports each tick's due frame ({@link due}) and each frame it shows
 * ({@link shown}); a frame between two shown ones was dropped, starved when some tick wanted it, cadence otherwise.
 */
export class DropLog {
  /** Last frame shown in this play; null while paused. */
  #last: number | null = null;
  /** Frames after `#last` that some tick wanted. */
  readonly #due = new Set<number>();
  #drops: PlayDrops = { starved: [], cadence: [] };

  /** A play starts from `frame` (on the canvas already): forget the previous play's drops. */
  start(frame: number): void {
    this.#last = frame;
    this.#due.clear();
    this.#drops = { starved: [], cadence: [] };
  }

  /** The play stopped; its drops stay readable until the next {@link start}. */
  stop(): void {
    this.#last = null;
    this.#due.clear();
  }

  /** A display tick while playing wanted `frame`. */
  due(frame: number): void {
    if (this.#last !== null && frame > this.#last) this.#due.add(frame);
  }

  /** `frame` is on the canvas now: frames between the last shown one and it were dropped. */
  shown(frame: number): void {
    const last = this.#last;
    if (last === null || frame <= last) return;
    for (let skipped = last + 1; skipped < frame; skipped++) {
      (this.#due.has(skipped) ? this.#drops.starved : this.#drops.cadence).push(skipped);
    }
    for (const wanted of this.#due) if (wanted <= frame) this.#due.delete(wanted);
    this.#last = frame;
  }

  /** Drops of the current (or last) play, copied. */
  get drops(): PlayDrops {
    return { starved: [...this.#drops.starved], cadence: [...this.#drops.cadence] };
  }
}
