/** Rounding error of a 3-decimal stored time, in seconds. */
const TOLERANCE = 0.0005;

/**
 * Project frame grid (SPEC decision 8): every stored time is a multiple of
 * 1/fps written with 3 decimals. Comparisons go through frame numbers, so
 * 3-decimal rounding never makes adjacent clips "overlap".
 */
export class FrameGrid {
  constructor(readonly fps: number) {}

  /** Frame number nearest to `seconds`. */
  frame(seconds: number): number {
    return Math.round(seconds * this.fps);
  }

  /** Stored seconds of frame `n`. */
  seconds(n: number): number {
    return Math.round((n / this.fps) * 1000) / 1000;
  }

  /** Nearest grid time. */
  snap(seconds: number): number {
    return this.seconds(this.frame(seconds));
  }

  /**
   * Grid time at or before `seconds`. Half a millisecond of slack: stored
   * values are rounded to 3 decimals (frame 1 at 30 fps is 0.033, not 1/30).
   */
  floor(seconds: number): number {
    return this.seconds(Math.floor((seconds + TOLERANCE) * this.fps));
  }

  /** Grid time at or after `seconds`, with the same slack as {@link floor}. */
  ceil(seconds: number): number {
    return this.seconds(Math.ceil((seconds - TOLERANCE) * this.fps));
  }

  /** One frame in seconds, unrounded. */
  get step(): number {
    return 1 / this.fps;
  }
}
