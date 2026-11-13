// Dropped program frames of a play, by why they were dropped (ADR 0001 amendment, #567). Runs in the engine worker.

/** Frame numbers of one kind posted at most: a long bad play would otherwise post thousands every second. */
export const DROP_SAMPLE = 50;
/** Tick times are counted in buckets this wide (ms) up to {@link BUSY_BUCKETS}: a play of any length costs the same. */
const BUSY_STEP_MS = 0.1;
const BUSY_BUCKETS = 1000;

/** Dropped frames of one kind: how many, and the first {@link DROP_SAMPLE} of them. */
export interface DropKind {
  count: number;
  frames: number[];
}

/** What a play dropped, by kind, and how long the engine's own ticks took. */
export interface PlayDrops {
  /**
   * Due at a display tick of the engine but not decoded then, or skipped after a tick of the engine's own that took
   * longer than a frame: the engine's budget (ADR 0001 threshold 3).
   */
  starved: DropKind;
  /** Never due at any tick while the engine was idle: the host gave it no display tick in time (scheduling). */
  cadence: DropKind;
  /** Longest tick of the play, ms of the engine's own work (draw, audio scheduling, decoder feeding). */
  busyMaxMs: number;
  /** 95th percentile of those tick times, ms (to 0.1 ms). */
  busyP95Ms: number;
}

/**
 * Classifies the frames a play skips. Per display tick the engine reports the due frame ({@link due}), each frame
 * it shows ({@link shown}) and how long the tick took ({@link busy}). A frame between two shown ones was dropped:
 * starved when some tick wanted it or a tick since the last shown frame overran a frame period, cadence otherwise.
 */
export class DropLog {
  /** Last frame shown in this play; null while paused. */
  #last: number | null = null;
  #frameMs = 1000 / 30;
  /** Frames after `#last` that some tick wanted. */
  readonly #due = new Set<number>();
  /** Longest tick since `#last` was shown, that tick included. */
  #busySinceShown = 0;
  #starved: DropKind = { count: 0, frames: [] };
  #cadence: DropKind = { count: 0, frames: [] };
  /** Ticks of the play by time taken; the last bucket holds every tick of 100 ms or more. */
  #busy = new Uint32Array(BUSY_BUCKETS);
  #ticks = 0;
  #busyMax = 0;

  /** A play at `fps` starts from `frame` (on the canvas already): forget the previous play's drops. */
  start(frame: number, fps: number): void {
    this.#last = frame;
    this.#frameMs = 1000 / fps;
    this.#due.clear();
    this.#busySinceShown = 0;
    this.#starved = { count: 0, frames: [] };
    this.#cadence = { count: 0, frames: [] };
    this.#busy.fill(0);
    this.#ticks = 0;
    this.#busyMax = 0;
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
    const slow = this.#busySinceShown > this.#frameMs;
    for (let skipped = last + 1; skipped < frame; skipped++) {
      const kind = slow || this.#due.has(skipped) ? this.#starved : this.#cadence;
      kind.count++;
      if (kind.frames.length < DROP_SAMPLE) kind.frames.push(skipped);
    }
    for (const wanted of this.#due) if (wanted <= frame) this.#due.delete(wanted);
    this.#busySinceShown = 0;
    this.#last = frame;
  }

  /** The tick that just ran while playing took `ms` of the engine's own work. */
  busy(ms: number): void {
    if (this.#last === null) return;
    this.#busy[Math.min(BUSY_BUCKETS - 1, Math.floor(ms / BUSY_STEP_MS))]!++;
    this.#ticks++;
    this.#busyMax = Math.max(this.#busyMax, ms);
    this.#busySinceShown = Math.max(this.#busySinceShown, ms);
  }

  /** Drops of the current (or last) play, frame lists capped at {@link DROP_SAMPLE}. */
  get drops(): PlayDrops {
    const round = (ms: number) => Math.round(ms * 10) / 10;
    let p95 = 0;
    for (let bucket = 0, seen = 0; bucket < BUSY_BUCKETS && this.#ticks > 0; bucket++) {
      seen += this.#busy[bucket]!;
      if (seen >= 0.95 * this.#ticks) {
        p95 = Math.min(this.#busyMax, (bucket + 1) * BUSY_STEP_MS);
        break;
      }
    }
    return {
      starved: { count: this.#starved.count, frames: [...this.#starved.frames] },
      cadence: { count: this.#cadence.count, frames: [...this.#cadence.frames] },
      busyMaxMs: round(this.#busyMax),
      busyP95Ms: round(p95),
    };
  }
}
