import { LOW_BEAT_CONFIDENCE } from "@frameshell/schema";
import { fft } from "../fft.js";

/**
 * Beat detector (ADR 0029 decision 3, #458): a straight beat grid of one music
 * asset, measured from its audio. Pure DSP on mono samples; the caller brings
 * the PCM (`beats-store.ts`).
 *
 * Recipe, after the thresholds measured in #458 (HyperFrames' `beats`, Apache-2.0, is a reference only):
 * 1. resample to {@link ANALYSIS_RATE} and take the spectral-flux onset envelope (hop 128, window 2048,
 *    log magnitude, 100 ms of silent pre-roll so a hit at t = 0 has a frame before it);
 * 2. pick its peaks, drop those under 0.12 of the strongest, and refine each to the sample where a 0.5 ms
 *    average of the 30 Hz-high-passed signal leaves the floor (the envelope alone is 20-50 ms late);
 * 3. tempo by autocorrelation of the envelope with interpolated lags, seeded with a hint, folded to the
 *    octave of the hint (or 70-170 BPM); phase by the comb that collects most hit energy at 5 ms steps;
 *    one straight period fitted by least squares over the hits, widening window by window;
 * 4. each beat snaps to a hit within {@link SNAP_S}; the bar starts at the phase with most 20-150 Hz energy;
 * 5. confidence from how many beats found a hit and how periodic the envelope is. Calm music gets a bogus
 *    double-time grid: that shows as low confidence, with the other tempi offered.
 */

/** Detector id written to the beats file; bump the number when a result can change for the same audio. */
export const BEAT_DETECTOR = "onset-flux@1";
/** Rate the analysis runs at; faster sources are resampled to it, slower ones are used as they are. */
export const ANALYSIS_RATE = 22_050;
/** STFT window, in samples at the analysis rate. */
const WINDOW = 2048;
/** STFT hop, in samples at the analysis rate. */
export const HOP = 128;
/** Silence put before the audio so a hit at t = 0 shows up as a rise. */
const PRE_ROLL_S = 0.1;
/** Peaks under this fraction of the strongest are not hits. */
const MIN_PEAK = 0.12;
/** A beat snaps to a hit this close (seconds). */
export const SNAP_S = 0.008;
/** A hit this close to a grid beat belongs to it when fitting and scoring (seconds). */
const MATCH_S = 0.03;
/** Tempo range a measured grid is folded into when there is no hint. */
const MIN_BPM = 70;
const MAX_BPM = 170;
/** Tempo candidates examined before folding. */
const SEARCH_MIN_BPM = 35;
const SEARCH_MAX_BPM = 340;
/** The tempo prior: how many octaves from the centre (the hint, else 120 BPM) halves the score. */
const PRIOR_WIDTH_OCTAVES = 1;
const HINTED_WIDTH_OCTAVES = 0.35;
/** Longest stretch the tempo is searched in; beats are placed over the whole audio. */
const TEMPO_WINDOW_S = 300;
/** Audio longer than this is not music to put on a grid. */
export const MAX_BEAT_AUDIO_S = 600;
/** Confidence ceiling when the audio is under {@link FULL_RATE}: the fallback decode cannot place beats precisely. */
const LOW_RATE_CONFIDENCE = 0.45;
const FULL_RATE = 44_100;

/** Mono samples and their rate. */
export interface Signal {
  samples: Float32Array;
  rate: number;
}

/** What {@link detectBeats} found. */
export interface BeatAnalysis {
  /** Beats per minute of the fitted straight grid. */
  bpm: number;
  meter: number;
  /** Index among `beats` of the first beat that starts a bar. */
  downbeat: number;
  confidence: number;
  /** Largest gap between the straight grid and a hit it matched, ms. */
  residualMs: number;
  /** Source seconds, 4 decimals. */
  beats: number[];
  /** Strong hits, source seconds, 3 decimals. */
  onsets: number[];
  /** The other tempi, best supported first; only when the confidence is low. */
  alternatives: { tempo: "double" | "half"; bpm: number }[];
}

/** Knobs of {@link detectBeats}. */
export interface BeatOptions {
  /** Tempo the person expects, in BPM: the grid is the nearest octave of what is measured. */
  hint?: number | undefined;
  /** Rate of the audio before {@link prepareSignal}; under 44.1 kHz the confidence is capped. */
  sourceRate?: number | undefined;
}

/** Why there was nothing to put on a grid. */
export class NoBeatsError extends Error {}

/** Mono `samples` at `rate`, at the analysis rate (resampled by a windowed sinc when faster). */
export function prepareSignal(samples: Float32Array, rate: number): Signal {
  return rate <= ANALYSIS_RATE ? { samples, rate } : { samples: resample(samples, rate, ANALYSIS_RATE), rate: ANALYSIS_RATE };
}

const SINC_ZEROS = 8;
const PHASES = 512;

/** Low-pass resampling by a Hann-windowed sinc, 1/512-sample phase resolution. */
function resample(input: Float32Array, from: number, to: number): Float32Array {
  const ratio = to / from;
  // Cutoff at 97% of the new Nyquist; half the kernel is SINC_ZEROS zero crossings of the low-pass.
  const cutoff = 0.97 * ratio;
  const half = Math.ceil(SINC_ZEROS / cutoff);
  const taps = 2 * half;
  const table = new Float32Array((PHASES + 1) * taps);
  for (let phase = 0; phase <= PHASES; phase++) {
    const fraction = phase / PHASES;
    for (let k = 0; k < taps; k++) {
      const x = k - half + 1 - fraction;
      const sinc = x === 0 ? cutoff : Math.sin(Math.PI * cutoff * x) / (Math.PI * x);
      const hann = 0.5 + 0.5 * Math.cos((Math.PI * x) / half);
      table[phase * taps + k] = sinc * hann;
    }
  }
  const out = new Float32Array(Math.floor(input.length * ratio));
  for (let n = 0; n < out.length; n++) {
    const position = n / ratio;
    const base = Math.floor(position);
    const row = Math.round((position - base) * PHASES) * taps;
    let sum = 0;
    const first = base - half + 1;
    if (first >= 0 && first + taps <= input.length) {
      for (let k = 0; k < taps; k++) sum += input[first + k]! * table[row + k]!;
    } else {
      for (let k = 0; k < taps; k++) {
        const index = first + k;
        if (index >= 0 && index < input.length) sum += input[index]! * table[row + k]!;
      }
    }
    out[n] = sum;
  }
  return out;
}

const hann = (() => {
  const window = new Float64Array(WINDOW);
  for (let i = 0; i < WINDOW; i++) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / WINDOW);
  return window;
})();

/** Frames per second of an onset envelope at `rate`. */
export function envelopeRate(rate: number): number {
  return rate / HOP;
}

/**
 * Spectral-flux onset envelope of `signal`: per hop, the summed rise of the log magnitude
 * spectrum over the previous frame, averaged over bins. Frame `t` is centred on the sample
 * `t * HOP - pre-roll`. This is the part worth caching: it costs most of the analysis.
 * `onProgress` gets 0..1 now and then.
 */
export function onsetEnvelope(signal: Signal, onProgress?: (fraction: number) => void): Float32Array {
  const { samples, rate } = signal;
  const preRoll = Math.round(PRE_ROLL_S * rate);
  const frames = Math.ceil((samples.length + preRoll) / HOP) + 1;
  const bins = WINDOW / 2;
  const flux = new Float32Array(frames);
  const re = new Float64Array(WINDOW);
  const im = new Float64Array(WINDOW);
  const previous = new Float32Array(bins);
  const log = new Float32Array(bins);
  const fill = (target: Float64Array, frame: number) => {
    const start = frame * HOP - WINDOW / 2 - preRoll;
    for (let k = 0; k < WINDOW; k++) {
      const index = start + k;
      target[k] = index >= 0 && index < samples.length ? samples[index]! * hann[k]! : 0;
    }
  };
  const step = (frame: number, real: number, imag: number, k: number) => {
    // `real`+i`imag` is the spectrum of the frame at bin k.
    log[k] = Math.log1p(Math.hypot(real, imag) * 100);
    if (frame > 0 && k > 0) {
      const rise = log[k]! - previous[k]!;
      if (rise > 0) flux[frame] = flux[frame]! + rise;
    }
  };
  // Two real frames per complex FFT: frame t in the real part, t + 1 in the imaginary one.
  for (let frame = 0; frame < frames; frame += 2) {
    if (onProgress && frame % 2048 === 0) onProgress(frame / frames);
    fill(re, frame);
    if (frame + 1 < frames) fill(im, frame + 1);
    else im.fill(0);
    fft(re, im, false);
    for (let k = 0; k < bins; k++) {
      const mirror = (WINDOW - k) & (WINDOW - 1);
      step(frame, (re[k]! + re[mirror]!) / 2, (im[k]! - im[mirror]!) / 2, k);
    }
    previous.set(log);
    if (frame + 1 < frames) {
      for (let k = 0; k < bins; k++) {
        const mirror = (WINDOW - k) & (WINDOW - 1);
        step(frame + 1, (im[k]! + im[mirror]!) / 2, -(re[k]! - re[mirror]!) / 2, k);
      }
      previous.set(log);
    }
  }
  for (let frame = 0; frame < frames; frame++) flux[frame] = flux[frame]! / bins;
  return flux;
}

interface Hit {
  /** Source seconds. */
  time: number;
  /** 0..1 against the strongest hit. */
  strength: number;
}

/** Local maxima of `envelope` that stand out of their surroundings, as frame indices with their values. */
function pickPeaks(envelope: Float32Array, rate: number): { frame: number; value: number }[] {
  const perSecond = envelope.length > 0 ? envelopeRate(rate) : 1;
  const around = Math.round(0.023 * perSecond);
  const mean = Math.round(0.25 * perSecond);
  const wait = Math.round(0.035 * perSecond);
  let max = 0;
  const prefix = new Float64Array(envelope.length + 1);
  for (let i = 0; i < envelope.length; i++) {
    prefix[i + 1] = prefix[i]! + envelope[i]!;
    max = Math.max(max, envelope[i]!);
  }
  if (max === 0) return [];
  const delta = 0.03 * max;
  const peaks: { frame: number; value: number }[] = [];
  let last = -Infinity;
  for (let i = 1; i < envelope.length - 1; i++) {
    const value = envelope[i]!;
    if (value <= envelope[i - 1]! || value < envelope[i + 1]!) continue;
    let isMax = true;
    for (let k = Math.max(0, i - around); k <= Math.min(envelope.length - 1, i + around); k++) {
      if (envelope[k]! > value) {
        isMax = false;
        break;
      }
    }
    if (!isMax) continue;
    const from = Math.max(0, i - mean);
    const to = Math.min(envelope.length, i + mean + 1);
    if (value < (prefix[to]! - prefix[from]!) / (to - from) + delta) continue;
    if (i - last < wait) {
      const previous = peaks[peaks.length - 1]!;
      if (value <= previous.value) continue;
      peaks.pop();
    }
    peaks.push({ frame: i, value });
    last = i;
  }
  const strongest = peaks.reduce((best, peak) => Math.max(best, peak.value), 0);
  return peaks.filter((peak) => peak.value >= MIN_PEAK * strongest);
}

/** Smoothed magnitude of the 30 Hz high-passed signal: |y| averaged over 0.5 ms. */
function attackEnvelope(signal: Signal): Float32Array {
  const { samples, rate } = signal;
  const coefficient = 1 / (1 + (2 * Math.PI * 30) / rate);
  const width = Math.max(1, Math.round(0.0005 * rate)) | 1;
  const half = (width - 1) / 2;
  const magnitude = new Float32Array(samples.length);
  let output = 0;
  let previous = 0;
  for (let i = 0; i < samples.length; i++) {
    const input = samples[i]!;
    output = coefficient * (output + input - previous);
    previous = input;
    magnitude[i] = Math.abs(output);
  }
  const smooth = new Float32Array(samples.length);
  let sum = 0;
  for (let i = 0; i < Math.min(half, samples.length); i++) sum += magnitude[i]!;
  for (let i = 0; i < samples.length; i++) {
    if (i + half < samples.length) sum += magnitude[i + half]!;
    if (i - half - 1 >= 0) sum -= magnitude[i - half - 1]!;
    smooth[i] = sum / width;
  }
  return smooth;
}

/**
 * The sample where the hit announced by the envelope peak at `frame` begins: the loudest point near the
 * window edge the new sound entered through, back to the energy minimum before it, then up to where the
 * attack rises 20% of the way from that floor.
 */
function refine(attack: Float32Array, frame: number, rate: number, preRoll: number): number {
  const edge = frame * HOP - preRoll + WINDOW / 2;
  const from = Math.max(0, edge - Math.round(0.09 * rate));
  const to = Math.min(attack.length - 1, edge + Math.round(0.012 * rate));
  if (to <= from) return Math.max(0, Math.min(attack.length - 1, edge));
  let top = from;
  for (let i = from; i <= to; i++) if (attack[i]! > attack[top]!) top = i;
  const look = Math.round(0.003 * rate);
  let floor = top;
  for (let i = top; i >= from; i--) {
    if (attack[i]! <= attack[floor]!) floor = i;
    else if (i < floor - look) break;
  }
  const level = attack[floor]! + 0.2 * (attack[top]! - attack[floor]!);
  let onset = floor;
  while (onset < top && attack[onset]! < level) onset++;
  return onset;
}

/** Hits of `signal`: envelope peaks refined to the sample the sound begins. */
function findHits(signal: Signal, envelope: Float32Array): Hit[] {
  const peaks = pickPeaks(envelope, signal.rate);
  if (peaks.length === 0) return [];
  const attack = attackEnvelope(signal);
  const preRoll = Math.round(PRE_ROLL_S * signal.rate);
  const strongest = peaks.reduce((best, peak) => Math.max(best, peak.value), 0);
  const hits: Hit[] = [];
  for (const peak of peaks) {
    const sample = refine(attack, peak.frame, signal.rate, preRoll);
    hits.push({ time: sample / signal.rate, strength: peak.value / strongest });
  }
  hits.sort((a, b) => a.time - b.time);
  // Two peaks refined to one onset are one hit.
  return hits.filter((hit, index) => index === 0 || hit.time - hits[index - 1]!.time > 0.01);
}

/** Envelope with its local mean (0.5 s either side) removed and negatives cut: what repeats is left. */
function periodicPart(envelope: Float32Array, perSecond: number): Float64Array {
  const half = Math.round(0.5 * perSecond);
  const prefix = new Float64Array(envelope.length + 1);
  for (let i = 0; i < envelope.length; i++) prefix[i + 1] = prefix[i]! + envelope[i]!;
  const out = new Float64Array(envelope.length);
  for (let i = 0; i < envelope.length; i++) {
    const from = Math.max(0, i - half);
    const to = Math.min(envelope.length, i + half + 1);
    out[i] = Math.max(0, envelope[i]! - (prefix[to]! - prefix[from]!) / (to - from));
  }
  return out;
}

/** Normalised autocorrelation of `values` at the fractional `lag` (in samples), linearly interpolated. */
function autocorrelation(values: Float64Array, lag: number, zero: number): number {
  const whole = Math.floor(lag);
  const fraction = lag - whole;
  const count = values.length - whole - 1;
  if (count < 8) return 0;
  let sum = 0;
  for (let i = 0; i < count; i++) sum += values[i]! * (values[i + whole]! * (1 - fraction) + values[i + whole + 1]! * fraction);
  return sum / count / zero;
}

interface Tempo {
  bpm: number;
  /** Autocorrelation at the tempo's period against at lag 0: how periodic the envelope is. */
  strength: number;
}

/** Tempo of the envelope: the autocorrelation peak that the prior (hint, else 120 BPM) prefers, folded to one octave. */
function estimateTempo(envelope: Float32Array, rate: number, hint: number | undefined): Tempo | null {
  const perSecond = envelopeRate(rate);
  let part = periodicPart(envelope, perSecond);
  const limit = Math.round(TEMPO_WINDOW_S * perSecond);
  if (part.length > limit) {
    const start = Math.floor((part.length - limit) / 2);
    part = part.subarray(start, start + limit);
  }
  let zero = 0;
  for (const value of part) zero += value * value;
  zero /= part.length;
  if (zero === 0) return null;
  const centre = hint ?? 120;
  const width = hint !== undefined ? HINTED_WIDTH_OCTAVES : PRIOR_WIDTH_OCTAVES;
  const prior = (bpm: number) => Math.exp(-0.5 * (Math.log2(bpm / centre) / width) ** 2);
  const score = (bpm: number) => autocorrelation(part, (60 * perSecond) / bpm, zero) * prior(bpm);
  const step = 1.0015;
  const coarse: { bpm: number; score: number }[] = [];
  for (let bpm = SEARCH_MIN_BPM; bpm <= SEARCH_MAX_BPM; bpm *= step) coarse.push({ bpm, score: score(bpm) });
  const top: { bpm: number; score: number }[] = [];
  const peaks = coarse
    .filter((entry, i) => entry.score > 0 && entry.score >= (coarse[i - 1]?.score ?? 0) && entry.score >= (coarse[i + 1]?.score ?? 0))
    .sort((a, b) => b.score - a.score);
  // A plateau is one peak: the next candidate must be a different tempo.
  for (const peak of peaks) if (top.length < 3 && top.every((kept) => Math.abs(Math.log(peak.bpm / kept.bpm)) > 0.03)) top.push(peak);
  if (top.length === 0) return null;
  let best = { bpm: top[0]!.bpm, score: top[0]!.score };
  for (const entry of top) {
    for (let k = -40; k <= 40; k++) {
      const bpm = entry.bpm * 1.00005 ** k;
      const value = score(bpm);
      if (value > best.score) best = { bpm, score: value };
    }
  }
  let bpm = best.bpm;
  const strength = autocorrelation(part, (60 * perSecond) / bpm, zero);
  if (hint !== undefined) {
    for (const octave of [0.25, 0.5, 2, 4]) if (Math.abs(Math.log2((bpm * octave) / hint)) < Math.abs(Math.log2(bpm / hint))) bpm *= octave;
  } else {
    while (bpm < MIN_BPM) bpm *= 2;
    while (bpm > MAX_BPM) bpm /= 2;
  }
  return { bpm, strength };
}

/** Phase in [0, period) where the hits cluster: the comb position at 5 ms steps with most hit energy, then the weighted mean offset of the hits near it. */
function findPhase(hits: Hit[], period: number): number {
  const steps = Math.max(1, Math.floor(period / 0.005));
  let best = 0;
  let bestScore = -1;
  for (let step = 0; step < steps; step++) {
    const phase = (step * period) / steps;
    let score = 0;
    for (const hit of hits) {
      let distance = Math.abs(((hit.time - phase) % period) + period) % period;
      distance = Math.min(distance, period - distance);
      if (distance < MATCH_S) score += hit.strength * (1 - distance / MATCH_S);
    }
    if (score > bestScore) {
      bestScore = score;
      best = phase;
    }
  }
  let weighted = 0;
  let weights = 0;
  for (const hit of hits) {
    let offset = (((hit.time - best) % period) + period) % period;
    if (offset > period / 2) offset -= period;
    if (Math.abs(offset) < MATCH_S) {
      weighted += offset * hit.strength;
      weights += hit.strength;
    }
  }
  const phase = weights > 0 ? best + weighted / weights : best;
  return ((phase % period) + period) % period;
}

interface Grid {
  period: number;
  phase: number;
}

/** One straight period through the hits near the grid, fitted over a window that widens until it covers the audio. */
function fitGrid(hits: Hit[], first: Grid, duration: number): Grid {
  let { period, phase } = first;
  const initial = period;
  for (let end = Math.min(duration, Math.max(8, 16 * period)); ; end = Math.min(duration, end * 1.7)) {
    const matched = new Map<number, { index: number; time: number; weight: number; error: number }>();
    for (const hit of hits) {
      if (hit.time > end) break;
      const index = Math.round((hit.time - phase) / period);
      const error = Math.abs(hit.time - (phase + index * period));
      if (error > MATCH_S) continue;
      const known = matched.get(index);
      if (!known || error < known.error) matched.set(index, { index, time: hit.time, weight: hit.strength, error });
    }
    const points = [...matched.values()];
    if (points.length >= 4) {
      let sw = 0;
      let sx = 0;
      let sy = 0;
      for (const p of points) {
        sw += p.weight;
        sx += p.weight * p.index;
        sy += p.weight * p.time;
      }
      const mx = sx / sw;
      const my = sy / sw;
      let sxx = 0;
      let sxy = 0;
      for (const p of points) {
        sxx += p.weight * (p.index - mx) ** 2;
        sxy += p.weight * (p.index - mx) * (p.time - my);
      }
      if (sxx > 0) {
        const fitted = sxy / sxx;
        // The grid is a straight line, but a hand-played part can wander: not by more than 3%.
        if (Math.abs(fitted / initial - 1) < 0.03) {
          period = fitted;
          phase = my - fitted * mx;
        }
      }
    }
    if (end >= duration) break;
  }
  return { period, phase };
}

/** The nearest of the sorted `hits` to `time`, or null. */
function nearest(hits: Hit[], time: number): Hit | null {
  let low = 0;
  let high = hits.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (hits[mid]!.time < time) low = mid + 1;
    else high = mid;
  }
  const before = hits[low - 1];
  const after = hits[low];
  if (!before) return after ?? null;
  if (!after) return before;
  return time - before.time <= after.time - time ? before : after;
}

/**
 * Share of the beats between the first and the last that found a hit, the largest gap among those, and
 * the indices of that first and last beat.
 */
function coverage(times: number[], hits: Hit[]): { share: number; residual: number; first: number; last: number } {
  let first = -1;
  let last = -1;
  let found = 0;
  let residual = 0;
  times.forEach((time, index) => {
    const hit = nearest(hits, time);
    if (!hit || Math.abs(hit.time - time) > MATCH_S) return;
    if (first < 0) first = index;
    last = index;
    found++;
    residual = Math.max(residual, Math.abs(hit.time - time));
  });
  return { share: found === 0 ? 0 : found / (last - first + 1), residual, first, last };
}

/** Bar start: of the `meter` phases, the one whose beats carry most 20-150 Hz energy in the 0.25 s after them. */
function findDownbeat(signal: Signal, beats: number[], meter: number): number {
  const { samples, rate } = signal;
  const high = 1 / (1 + (2 * Math.PI * 20) / rate);
  const low = 1 - Math.exp((-2 * Math.PI * 150) / rate);
  const energy = new Float64Array(samples.length + 1);
  let highPassed = 0;
  let previous = 0;
  let a = 0;
  let b = 0;
  for (let i = 0; i < samples.length; i++) {
    const input = samples[i]!;
    highPassed = high * (highPassed + input - previous);
    previous = input;
    a += low * (highPassed - a);
    b += low * (a - b);
    energy[i + 1] = energy[i]! + b * b;
  }
  const window = Math.round(0.25 * rate);
  const sums = new Float64Array(meter);
  const counts = new Float64Array(meter);
  beats.forEach((time, index) => {
    const from = Math.min(samples.length, Math.max(0, Math.round(time * rate)));
    const to = Math.min(samples.length, from + window);
    sums[index % meter] = sums[index % meter]! + (energy[to]! - energy[from]!);
    counts[index % meter] = counts[index % meter]! + 1;
  });
  let best = 0;
  let bestMean = -1;
  for (let phase = 0; phase < meter; phase++) {
    const mean = counts[phase]! > 0 ? sums[phase]! / counts[phase]! : 0;
    if (mean > bestMean * 1.0000001) {
      bestMean = mean;
      best = phase;
    }
  }
  return best;
}

const round = (value: number, decimals: number) => Math.round(value * 10 ** decimals) / 10 ** decimals;

/**
 * Measure the beat grid of `signal`, given its onset `envelope` ({@link onsetEnvelope}). Throws
 * {@link NoBeatsError} when there are too few hits to hold a grid.
 */
export function detectBeats(signal: Signal, envelope: Float32Array, options: BeatOptions = {}): BeatAnalysis {
  const duration = signal.samples.length / signal.rate;
  const hits = findHits(signal, envelope);
  if (hits.length < 4) throw new NoBeatsError("there are too few hits to hold a beat grid (silence, or no rhythm)");
  const tempo = estimateTempo(envelope, signal.rate, options.hint);
  if (!tempo) throw new NoBeatsError("the sound has no repeating rhythm");
  const initial = 60 / tempo.bpm;
  const grid = fitGrid(hits, { period: initial, phase: findPhase(hits, initial) }, duration);
  const { period, phase } = grid;
  const first = Math.ceil(-phase / period - 1e-6);
  const grid0: number[] = [];
  for (let index = first; phase + index * period < duration; index++) grid0.push(phase + index * period);
  const reach = coverage(grid0, hits);
  if (reach.share === 0) throw new NoBeatsError("no hit falls on the beat grid");
  // The grid stands where there is rhythm: beats before the first and after the last hit would be guesses.
  const times = grid0.slice(reach.first, reach.last + 1);
  if (times.length < 2) throw new NoBeatsError("the audio holds fewer than two beats");
  const { share, residual } = reach;
  const beats = times.map((time) => {
    const hit = nearest(hits, time);
    return hit && Math.abs(hit.time - time) <= SNAP_S ? hit.time : time;
  });
  const meter = 4;
  const downbeat = findDownbeat(signal, beats, meter);
  const periodic = Math.min(1, Math.max(0, tempo.strength / 0.3));
  let confidence = share ** 1.5 * (0.6 + 0.4 * periodic);
  if ((options.sourceRate ?? signal.rate) < FULL_RATE) confidence = Math.min(confidence, LOW_RATE_CONFIDENCE);
  const bpm = round(60 / period, 2);
  const alternatives: BeatAnalysis["alternatives"] = [];
  if (confidence < LOW_BEAT_CONFIDENCE) {
    const doubled = times.flatMap((time, index) => (index < times.length - 1 ? [time, (time + times[index + 1]!) / 2] : [time]));
    const halved = times.filter((_, index) => index % 2 === 0);
    alternatives.push(
      { tempo: "double", bpm: round(bpm * 2, 2) },
      { tempo: "half", bpm: round(bpm / 2, 2) },
    );
    const support = new Map([
      ["double", coverage(doubled, hits).share],
      ["half", coverage(halved, hits).share],
    ]);
    alternatives.sort((a, b) => support.get(b.tempo)! - support.get(a.tempo)!);
  }
  return {
    bpm,
    meter,
    downbeat,
    confidence: round(confidence, 3),
    residualMs: round(residual * 1000, 1),
    beats: beats.map((time) => round(time, 4)),
    onsets: hits.map((hit) => round(hit.time, 3)),
    alternatives,
  };
}

/** Frames {@link onsetEnvelope} makes of `signal`: what a cached envelope must have to be used. */
export function envelopeFrames(signal: Signal): number {
  return Math.ceil((signal.samples.length + Math.round(PRE_ROLL_S * signal.rate)) / HOP) + 1;
}

/** Mono float samples of interleaved signed 16-bit little-endian PCM: the channels averaged. */
export function monoFromPcm(pcm: Uint8Array, channels: number): Float32Array {
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const frames = Math.floor(pcm.byteLength / (2 * channels));
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) sum += view.getInt16((i * channels + c) * 2, true);
    out[i] = sum / channels / 32768;
  }
  return out;
}

/** Input of {@link analysePcm}. */
export interface PcmAnalysis {
  /** Interleaved signed 16-bit little-endian PCM. */
  pcm: Uint8Array;
  channels: number;
  rate: number;
  hint?: number | undefined;
  /** A cached {@link onsetEnvelope} of this audio; used when it has the frames this audio needs. */
  envelope?: Float32Array | null | undefined;
}

/** Outcome of {@link analysePcm}: the grid and the envelope behind it, or why there is none. */
export type PcmAnalysisResult =
  | { ok: true; analysis: BeatAnalysis; envelope: Float32Array; analysisRate: number }
  | { ok: false; reason: string };

/**
 * Everything from raw PCM to a beat grid, the work of a worker thread: mono, resample, envelope (unless a
 * cached one fits), detection. `onProgress` gets 0..1.
 */
export function analysePcm(input: PcmAnalysis, onProgress: (fraction: number) => void = () => {}): PcmAnalysisResult {
  const signal = prepareSignal(monoFromPcm(input.pcm, input.channels), input.rate);
  onProgress(0.05);
  const cached = input.envelope && input.envelope.length === envelopeFrames(signal) ? input.envelope : null;
  const envelope = cached ?? onsetEnvelope(signal, (fraction) => onProgress(0.05 + 0.85 * fraction));
  onProgress(0.9);
  try {
    return { ok: true, analysis: detectBeats(signal, envelope, { hint: input.hint, sourceRate: input.rate }), envelope, analysisRate: signal.rate };
  } catch (error) {
    if (error instanceof NoBeatsError) return { ok: false, reason: error.message };
    throw error;
  }
}
