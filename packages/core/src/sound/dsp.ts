// Primitives of the sound synth (ADR 0038): a seeded generator and a biquad filter. Only exact IEEE operations and
// V8's own sin/cos/exp/tanh are used, so one seed gives one file on every machine running the same V8.
import { createHash } from "node:crypto";
import { SOUND_SAMPLE_RATE } from "@frameshell/schema";

/** Sample rate of every synthesized sound. */
export const SR = SOUND_SAMPLE_RATE;

/** Two pi. */
export const TAU = Math.PI * 2;

/** A pseudo-random source of numbers in [0, 1). */
export type Rng = () => number;

/** Mulberry32: 32 bits of state, enough for noise and jitter. */
export function mulberry32(seed: number): Rng {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A generator that depends on `parts` alone, so a take's noise and jitter follow from its parameters. */
export function rngOf(...parts: readonly (string | number)[]): Rng {
  return mulberry32(createHash("sha256").update(parts.join("\0")).digest().readUInt32LE(0));
}

/** White noise in [-1, 1). */
export function noise(rng: Rng): number {
  return rng() * 2 - 1;
}

/** Samples in `seconds`, at least one. */
export function frames(seconds: number): number {
  return Math.max(1, Math.round(seconds * SR));
}

/** Highest cut-off a filter takes: just under Nyquist, where the coefficients stay stable. */
const MAX_FREQ = SR * 0.45;

/** Second-order filter (RBJ cookbook). Cut-off and Q are clamped, so a sweep never makes it unstable. */
export class Biquad {
  #b0 = 1;
  #b1 = 0;
  #b2 = 0;
  #a1 = 0;
  #a2 = 0;
  #z1 = 0;
  #z2 = 0;

  /** Set the response; the state is kept, so a sweep does not click. `bandpass` has a peak gain of 1. */
  set(type: "lowpass" | "highpass" | "bandpass", frequency: number, q: number): this {
    const freq = Math.min(MAX_FREQ, Math.max(20, frequency));
    const w = (TAU * freq) / SR;
    const cos = Math.cos(w);
    const alpha = Math.sin(w) / (2 * Math.min(20, Math.max(0.1, q)));
    const a0 = 1 + alpha;
    if (type === "lowpass") {
      this.#b0 = (1 - cos) / 2 / a0;
      this.#b1 = (1 - cos) / a0;
      this.#b2 = this.#b0;
    } else if (type === "highpass") {
      this.#b0 = (1 + cos) / 2 / a0;
      this.#b1 = -(1 + cos) / a0;
      this.#b2 = this.#b0;
    } else {
      this.#b0 = alpha / a0;
      this.#b1 = 0;
      this.#b2 = -alpha / a0;
    }
    this.#a1 = (-2 * cos) / a0;
    this.#a2 = (1 - alpha) / a0;
    return this;
  }

  /** Filter one sample. */
  process(x: number): number {
    const y = this.#b0 * x + this.#z1;
    this.#z1 = this.#b1 * x - this.#a1 * y + this.#z2;
    this.#z2 = this.#b2 * x - this.#a2 * y;
    return y;
  }
}

/** Soft clip that keeps the unit peak: `tanh(drive * x) / tanh(drive)`. */
export function saturate(x: number, drive: number): number {
  return Math.tanh(drive * x) / Math.tanh(drive);
}

/** Largest absolute value over all channels. */
export function peakOf(channels: readonly ArrayLike<number>[]): number {
  let peak = 0;
  for (const channel of channels) for (let i = 0; i < channel.length; i++) peak = Math.max(peak, Math.abs(channel[i]!));
  return peak;
}
