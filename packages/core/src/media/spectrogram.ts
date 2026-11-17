// Spectrogram of a sound as data, for the audition dialog (ADR 0038 "Audition page as built"): rows on a log-frequency
// scale, columns in time, values in dB relative to a full-scale sine, through the one FFT of core.
import { fft } from "../fft.js";

/** Sample rate the sound is decoded at for a spectrogram: the top row is just under its Nyquist frequency. */
export const SPECTROGRAM_RATE = 32_000;
/** FFT length, samples at {@link SPECTROGRAM_RATE}: 32 ms, 31 Hz a bin. Short enough that a 50 ms tick is one column, not a smear. */
const WINDOW = 1024;
/** Rows, lowest frequency first. */
export const SPECTROGRAM_ROWS = 64;
/** Columns at most: a long track gets one column per 1/400 of its length. */
export const SPECTROGRAM_MAX_COLUMNS = 400;
/** Shortest column, seconds: a 0.3 s click gets 60 columns, not 400 copies of the same window. */
const MIN_COLUMN_SECONDS = 0.005;
/** Frames averaged into one column at most: a long column is sampled, not read whole (a 3 min track is 1 600 FFTs). */
const FRAMES_PER_COLUMN = 4;
/** Lower edge of the first row, Hz: below a kick's fundamental. */
export const SPECTROGRAM_LOW_HZ = 40;
/** Upper edge of the last row, Hz. */
export const SPECTROGRAM_HIGH_HZ = 16_000;
/** Quietest value, dB: 16-bit dither sits around here. */
export const SPECTROGRAM_FLOOR_DB = -96;
/** Seconds of a file a spectrogram covers at most (the beat detector's cap: an audition is of music, not a lecture). */
export const SPECTROGRAM_MAX_SECONDS = 600;

/** A spectrogram as data: `columns[c][r]` is the level of row `r` (low to high frequency) in column `c` (in time order). */
export interface Spectrogram {
  /** Lower edge of row 0, Hz. */
  lowHz: number;
  /** Upper edge of the last row, Hz; rows split [lowHz, highHz] into equal ratios. */
  highHz: number;
  rows: number;
  /** Seconds each column spans; column `c` starts at `c * columnSeconds`. */
  columnSeconds: number;
  /** The value of silence, dB. */
  floorDb: number;
  /** Whole dB relative to a full-scale sine (0 dB), at least {@link floorDb}. */
  columns: number[][];
}

const hann = (() => {
  const window = new Float64Array(WINDOW);
  for (let i = 0; i < WINDOW; i++) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / WINDOW);
  return window;
})();
/** |X|² of a full-scale sine on a bin centre through the Hann window (its amplitude sum is N/2, half of it per side). */
const FULL_SCALE_POWER = (WINDOW / 4) ** 2;

/**
 * The spectrogram of mono `samples` at `rate`. Each column is the mean power of up to {@link FRAMES_PER_COLUMN} Hann
 * windows spread over its span; each row is the loudest bin whose centre falls in its band, or the power read between the
 * two nearest bins when the band is narrower than a bin (the low rows). Empty `samples` give no columns.
 */
export function spectrogram(samples: Float32Array, rate: number): Spectrogram {
  const highHz = Math.min(SPECTROGRAM_HIGH_HZ, rate / 2);
  const base = { lowHz: SPECTROGRAM_LOW_HZ, highHz, rows: SPECTROGRAM_ROWS, floorDb: SPECTROGRAM_FLOOR_DB };
  const duration = samples.length / rate;
  if (samples.length === 0) return { ...base, columnSeconds: 0, columns: [] };
  const count = Math.max(1, Math.min(SPECTROGRAM_MAX_COLUMNS, Math.ceil(duration / MIN_COLUMN_SECONDS)));
  const span = samples.length / count;
  const binHz = rate / WINDOW;
  const edges = Array.from({ length: SPECTROGRAM_ROWS + 1 }, (_, i) => SPECTROGRAM_LOW_HZ * (highHz / SPECTROGRAM_LOW_HZ) ** (i / SPECTROGRAM_ROWS));
  const re = new Float64Array(WINDOW);
  const im = new Float64Array(WINDOW);
  const power = new Float64Array(WINDOW / 2 + 1);
  const columns: number[][] = [];
  for (let column = 0; column < count; column++) {
    power.fill(0);
    const frames = Math.max(1, Math.min(FRAMES_PER_COLUMN, Math.round(span / (WINDOW / 2))));
    for (let frame = 0; frame < frames; frame++) {
      const centre = Math.round(column * span + ((frame + 0.5) * span) / frames);
      const first = centre - WINDOW / 2;
      for (let i = 0; i < WINDOW; i++) {
        const at = first + i;
        re[i] = at >= 0 && at < samples.length ? samples[at]! * hann[i]! : 0;
        im[i] = 0;
      }
      fft(re, im, false);
      for (let bin = 0; bin <= WINDOW / 2; bin++) power[bin] = power[bin]! + (re[bin]! * re[bin]! + im[bin]! * im[bin]!) / FULL_SCALE_POWER / frames;
    }
    const values: number[] = [];
    for (let row = 0; row < SPECTROGRAM_ROWS; row++) {
      const lo = edges[row]!;
      const hi = edges[row + 1]!;
      let loudest = -1;
      for (let bin = Math.ceil(lo / binHz); bin * binHz < hi && bin <= WINDOW / 2; bin++) loudest = Math.max(loudest, power[bin]!);
      if (loudest < 0) {
        const at = Math.sqrt(lo * hi) / binHz;
        const below = Math.min(WINDOW / 2, Math.floor(at));
        const above = Math.min(WINDOW / 2, below + 1);
        loudest = power[below]! + (power[above]! - power[below]!) * (at - below);
      }
      values.push(Math.max(SPECTROGRAM_FLOOR_DB, Math.round(10 * Math.log10(loudest + 1e-20))));
    }
    columns.push(values);
  }
  return { ...base, columnSeconds: duration / count, columns };
}
