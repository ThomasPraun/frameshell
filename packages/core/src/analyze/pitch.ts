import type { AnalyzePitch } from "@frameshell/protocol";

// Pitch of a voice by the YIN method (de Cheveigné and Kawahara, 2002: difference function, cumulative mean normalisation, absolute threshold).
// Pure: `audio.ts` brings the samples and the spans of the words.

/** Seconds between two pitch readings. */
export const PITCH_HOP_S = 0.02;
/** Lowest and highest fundamental searched, Hz: a speaking voice. */
const F0_MIN = 70;
const F0_MAX = 400;
/** Samples per second the search runs at: half a 16 kHz transcription WAV, plenty under 4 kHz and a quarter of the work. */
const RATE = 8_000;
/** Samples of the window each reading is taken over (30 ms). */
const WINDOW = 240;
/** Normalised difference under which a lag counts as a period. */
const THRESHOLD = 0.15;
/** Largest normalised difference of the best lag for a frame to count as voiced when none is under {@link THRESHOLD}. */
const VOICED_MAX = 0.3;
/** Quietest frame, RMS over full scale, that is read: below it (about -50 dBFS) the frame is noise. */
const MIN_RMS = 0.003;
/** Voiced readings a pitch needs. */
export const PITCH_MIN_FRAMES = 8;
/** Readings the octave-error median runs over. */
const SMOOTH = 5;

/** Samples of `samples` at `rate` brought to {@link RATE} (a mean of each pair at 16 kHz), as floats of -1 to 1. */
function toSearchRate(samples: Int16Array, rate: number): Float32Array {
  const step = Math.max(1, Math.round(rate / RATE));
  const out = new Float32Array(Math.floor(samples.length / step));
  for (let i = 0; i < out.length; i++) {
    let sum = 0;
    for (let k = 0; k < step; k++) sum += samples[i * step + k]!;
    out[i] = sum / step / 32768;
  }
  return out;
}

/** The fundamental frequency, Hz, of the window of {@link WINDOW} samples at `from` in `x`; null when it is unvoiced or too quiet. */
function readPitch(x: Float32Array, from: number): number | null {
  const maxLag = Math.floor(RATE / F0_MIN);
  const minLag = Math.ceil(RATE / F0_MAX);
  let energy = 0;
  for (let j = 0; j < WINDOW; j++) energy += x[from + j]! * x[from + j]!;
  if (Math.sqrt(energy / WINDOW) < MIN_RMS) return null;
  const diff = new Float64Array(maxLag + 2);
  for (let lag = 1; lag <= maxLag + 1; lag++) {
    let sum = 0;
    for (let j = 0; j < WINDOW; j++) {
      const delta = x[from + j]! - x[from + j + lag]!;
      sum += delta * delta;
    }
    diff[lag] = sum;
  }
  // Cumulative mean normalised difference: 1 for no periodicity, near 0 at a period.
  const norm = new Float64Array(maxLag + 2);
  norm[0] = 1;
  let running = 0;
  for (let lag = 1; lag <= maxLag + 1; lag++) {
    running += diff[lag]!;
    norm[lag] = running === 0 ? 1 : (diff[lag]! * lag) / running;
  }
  let best = -1;
  for (let lag = minLag; lag <= maxLag; lag++) {
    if (norm[lag]! < THRESHOLD) {
      while (lag + 1 <= maxLag && norm[lag + 1]! < norm[lag]!) lag++;
      best = lag;
      break;
    }
  }
  if (best < 0) {
    for (let lag = minLag; lag <= maxLag; lag++) if (best < 0 || norm[lag]! < norm[best]!) best = lag;
    if (best < 0 || norm[best]! > VOICED_MAX) return null;
  }
  // Parabolic interpolation around the minimum.
  const a = norm[best - 1]!;
  const b = norm[best]!;
  const c = norm[best + 1]!;
  const denominator = a - 2 * b + c;
  const shift = denominator === 0 ? 0 : (a - c) / (2 * denominator);
  return RATE / (best + Math.max(-1, Math.min(1, shift)));
}

/** The median of `values` (the upper middle of an even count). */
function medianOf(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

/**
 * The fundamental of each reading, one every {@link PITCH_HOP_S}, inside the `spans` (seconds, `[from, to)`): voiced readings only,
 * after a median over {@link SMOOTH} neighbours that drops the octave jumps a period search makes.
 * `samples` are mono 16-bit PCM at `rate`.
 */
export function pitchTrack(samples: Int16Array, rate: number, spans: readonly (readonly [number, number])[]): number[] {
  const x = toSearchRate(samples, rate);
  const hop = Math.round(PITCH_HOP_S * RATE);
  const reach = Math.floor(RATE / F0_MIN) + 1;
  const track: number[] = [];
  for (const [from, to] of spans) {
    const readings: (number | null)[] = [];
    for (let at = Math.round(from * RATE); at + WINDOW + reach < x.length && at < to * RATE; at += hop) readings.push(readPitch(x, at));
    for (let i = 0; i < readings.length; i++) {
      if (readings[i] === null) continue;
      const near: number[] = [];
      for (let k = Math.max(0, i - (SMOOTH >> 1)); k <= Math.min(readings.length - 1, i + (SMOOTH >> 1)); k++) if (readings[k] !== null) near.push(readings[k]!);
      track.push(near.length >= 3 ? medianOf(near) : readings[i]!);
    }
  }
  return track;
}

/** The pitch of the voiced readings `track` (Hz); null under {@link PITCH_MIN_FRAMES}. */
export function pitchOf(track: readonly number[]): AnalyzePitch | null {
  if (track.length < PITCH_MIN_FRAMES) return null;
  const sorted = [...track].sort((a, b) => a - b);
  const at = (share: number) => sorted[Math.min(sorted.length - 1, Math.floor(share * sorted.length))]!;
  const [low, median, high] = [at(0.1), at(0.5), at(0.9)];
  return {
    low: Math.round(low * 10) / 10,
    median: Math.round(median * 10) / 10,
    high: Math.round(high * 10) / 10,
    range: Math.round(12 * Math.log2(high / low) * 10) / 10,
    frames: track.length,
  };
}
