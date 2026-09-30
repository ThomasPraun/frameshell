import type { FrameGrid } from "../timeline/grid.js";

/**
 * Audio energy analysis and pause snapping (ADR 0003). Pure: callers bring
 * samples and a level function; files and caching live in `energy-store.ts`.
 */

/** Envelope resolution: one RMS value per 10 ms. */
export const ENERGY_HOP_S = 0.01;
/** Shortest quiet run that counts as a pause (ADR 0003). */
export const PAUSE_MIN_S = 0.2;
/** Below speech level by this much = quiet (ADR 0003). */
export const SPEECH_RANGE_DB = 40;
/** Default and minimum snap search half-width (ADR 0003: at least ±500 ms). */
export const DEFAULT_SNAP_WINDOW_S = 0.5;
/** Distance kept from a pause's edges: energy edges blur over a few hops. */
const PAUSE_MARGIN_S = 0.05;
/** Fallback ties: levels this close to the minimum count as equal, nearest wins. */
const TIE_DB = 0.5;
/** dB of digital silence (avoids -Infinity in the envelope). */
const SILENCE_DB = -120;

/**
 * Streaming RMS envelope of interleaved s16le PCM: one dBFS value per
 * {@link ENERGY_HOP_S}, index i covering [i·hop, (i+1)·hop). Channels are
 * power-averaged, so opposite-phase channels do not cancel.
 */
export class EnvelopeBuilder {
  readonly #hopFrames: number;
  readonly #channels: number;
  readonly #values: number[] = [];
  #sum = 0;
  #count = 0;
  #carry: Uint8Array = new Uint8Array(0);

  constructor(sampleRate: number, channels = 1) {
    this.#hopFrames = Math.max(1, Math.round(sampleRate * ENERGY_HOP_S));
    this.#channels = Math.max(1, channels);
  }

  /** Add raw s16le bytes; chunks may split samples. */
  push(chunk: Uint8Array): void {
    let bytes = chunk;
    if (this.#carry.length > 0) {
      bytes = new Uint8Array(this.#carry.length + chunk.length);
      bytes.set(this.#carry);
      bytes.set(chunk, this.#carry.length);
    }
    const whole = bytes.length - (bytes.length % 2);
    const view = new DataView(bytes.buffer, bytes.byteOffset, whole);
    const perHop = this.#hopFrames * this.#channels;
    for (let offset = 0; offset < whole; offset += 2) {
      const sample = view.getInt16(offset, true) / 32768;
      this.#sum += sample * sample;
      if (++this.#count === perHop) this.#flush();
    }
    this.#carry = bytes.slice(whole);
  }

  /** Envelope so far, including a trailing partial hop. */
  finish(): Float32Array {
    if (this.#count > 0) this.#flush();
    return Float32Array.from(this.#values);
  }

  #flush(): void {
    const power = this.#sum / this.#count;
    this.#values.push(power > 0 ? Math.max(SILENCE_DB, 10 * Math.log10(power)) : SILENCE_DB);
    this.#sum = 0;
    this.#count = 0;
  }
}

/** {@link EnvelopeBuilder} over mono samples already in memory. */
export function energyEnvelope(samples: Int16Array, sampleRate: number): Float32Array {
  const builder = new EnvelopeBuilder(sampleRate, 1);
  builder.push(new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength));
  return builder.finish();
}

/** An envelope with its quiet threshold. */
export interface EnergyProfile {
  /** dBFS per {@link ENERGY_HOP_S}, from source time 0. */
  db: Float32Array;
  /** dBFS; below it a hop is quiet. */
  threshold: number;
}

/**
 * Quiet threshold of an envelope: `speech level - 40 dB` (ADR 0003), never
 * closer than 10 dB to the noise floor. Floor = 10th percentile; speech
 * level = 90th percentile of hops louder than floor + 10 dB, so mostly
 * silent material still finds its speech level.
 */
export function energyProfile(db: Float32Array): EnergyProfile {
  if (db.length === 0) return { db, threshold: SILENCE_DB };
  const sorted = Float32Array.from(db).sort();
  const floor = percentile(sorted, 10);
  const loud = sorted.filter((value) => value > floor + 10);
  const speech = loud.length > 0 ? percentile(loud, 90) : floor;
  return { db, threshold: Math.max(floor + 10, speech - SPEECH_RANGE_DB) };
}

/**
 * dB above the quiet threshold at source time `t`: negative = quiet.
 * +Infinity outside the envelope (no material to cut in).
 */
export function profileLevel(profile: EnergyProfile, t: number): number {
  const index = Math.floor(t / ENERGY_HOP_S + 1e-9);
  if (index < 0 || index >= profile.db.length) return Number.POSITIVE_INFINITY;
  return profile.db[index]! - profile.threshold;
}

/** Input of {@link snapToPause}. */
export interface SnapRequest {
  /** Requested time, seconds. */
  time: number;
  /** Search half-width, seconds. */
  window: number;
  /** Frame grid of the result: the returned time is on it. */
  grid: FrameGrid;
  /** dB above the quiet threshold at time t (negative = quiet), on the same clock as `time`. */
  level(t: number): number;
  /** Earliest allowed result. */
  min?: number;
  /** Latest allowed result. */
  max?: number;
  /** Shortest pause on this clock. Default {@link PAUSE_MIN_S}; shorter when the source plays faster. */
  pauseMin?: number;
}

/** Outcome of {@link snapToPause}. */
export interface SnapResult {
  /** On the grid. */
  time: number;
  /** True when inside a pause; false = lowest-energy frame, speech may be clipped. */
  clean: boolean;
}

/**
 * Move a cut into the interior of the nearest pause (quiet run of at least
 * {@link PAUSE_MIN_S}) within `time ± window` (ADR 0003). Word timestamps
 * pick the gap; this picks the point. A time already inside a pause only
 * moves to the grid. No pause in reach: the lowest-energy grid frame in the
 * window (ties go to the nearest), reported unclean.
 */
export function snapToPause(request: SnapRequest): SnapResult {
  const { time, window, grid, level } = request;
  const fps = grid.fps;
  const lo = Math.max(request.min ?? Number.NEGATIVE_INFINITY, time - window);
  const hi = Math.min(request.max ?? Number.POSITIVE_INFINITY, time + window);
  const frameLo = Math.ceil(lo * fps - 1e-6);
  const frameHi = Math.floor(hi * fps + 1e-6);
  if (frameLo > frameHi) return { time: grid.snap(Math.min(Math.max(time, lo), hi)), clean: false };
  const target = Math.round(time * fps);
  const pauseMin = request.pauseMin ?? PAUSE_MIN_S;

  // Scan past the window by one pause length: a pause cut by the window edge still measures whole.
  const scanFrom = Math.floor((time - window - pauseMin) / ENERGY_HOP_S) * ENERGY_HOP_S;
  const hops = Math.ceil((time + window + pauseMin - scanFrom) / ENERGY_HOP_S);
  let best: number | null = null;
  let runStart = -1;
  for (let i = 0; i <= hops; i++) {
    const quiet = i < hops && level(scanFrom + (i + 0.5) * ENERGY_HOP_S) < 0;
    if (quiet) {
      if (runStart < 0) runStart = i;
      continue;
    }
    if (runStart < 0) continue;
    const a = scanFrom + runStart * ENERGY_HOP_S;
    const b = scanFrom + i * ENERGY_HOP_S;
    runStart = -1;
    if (b - a < pauseMin - 1e-9) continue;
    const margin = Math.min(PAUSE_MARGIN_S, (b - a) / 2);
    const first = Math.max(frameLo, Math.ceil((a + margin) * fps - 1e-6));
    const last = Math.min(frameHi, Math.floor((b - margin) * fps + 1e-6));
    if (first > last) continue;
    const frame = Math.min(Math.max(target, first), last);
    if (best === null || Math.abs(frame - target) < Math.abs(best - target)) best = frame;
  }
  if (best !== null) return { time: grid.seconds(best), clean: true };

  const levels: { frame: number; level: number }[] = [];
  for (let frame = frameLo; frame <= frameHi; frame++) levels.push({ frame, level: level(frame / fps) });
  const lowest = Math.min(...levels.map((entry) => entry.level));
  let chosen = frameLo;
  let distance = Number.POSITIVE_INFINITY;
  for (const { frame, level: value } of levels) {
    if (value <= lowest + TIE_DB && Math.abs(frame - target) < distance) [chosen, distance] = [frame, Math.abs(frame - target)];
  }
  return { time: grid.seconds(chosen), clean: false };
}

/** p-th percentile (0-100) of an ascending array. */
function percentile(sorted: Float32Array, p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))]!;
}
