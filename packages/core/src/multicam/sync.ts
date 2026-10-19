import { SYNC_LOW_CONFIDENCE } from "@frameshell/protocol";
import { ENERGY_HOP_S, type EnergyProfile } from "../media/energy.js";

/**
 * Audio sync of multicam files (ADR 0016 decision 1): the offset between two
 * recordings of the same session, found by cross-correlating their energy
 * envelopes (the ones cut snapping caches, `media/energy-store.ts`). Pure:
 * callers bring profiles.
 */

/** Longest stretch of each file that is matched; also bounds the offsets that can be found. */
export const SYNC_WINDOW_S = 600;
/** Lags with less overlap than this (or than the shorter file) are not considered: tiny overlaps correlate by chance. */
const MIN_OVERLAP_S = 5;
/** A second peak this close to the best one is a rival, not part of its lobe. */
const LOBE_S = 1;
/** Width of the moving average removed from the envelope. */
const LOCAL_MEAN_S = 2;
/** Correlation at the best lag that counts as a full match; weaker matches scale the confidence down. */
const FULL_MATCH = 0.1;

/** Where a file sits against the reference, and how sure that is. */
export interface SyncEstimate {
  /** Seconds: a sound at reference time t is heard at t + lag in the other file. 0 when no match was found. */
  lag: number;
  /** 0 (nothing shared) to 1 (unmistakable). */
  confidence: number;
}

/**
 * Lag of `other` against `reference`. The envelope is clamped at the quiet
 * threshold, so silence and room noise carry no weight and loud events
 * (speech, a clap) decide. Correlation normalised by the files' energy;
 * the confidence is how far the best lag stands above the best rival
 * (periodic or featureless audio has none), scaled down for weak matches.
 */
export function correlateProfiles(reference: EnergyProfile, other: EnergyProfile): SyncEstimate {
  const a = features(reference);
  const b = features(other);
  const none: SyncEstimate = { lag: 0, confidence: 0 };
  if (a.length === 0 || b.length === 0) return none;
  const size = nextPowerOfTwo(a.length + b.length);
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  const reB = new Float64Array(size);
  const imB = new Float64Array(size);
  re.set(a);
  reB.set(b);
  fft(re, im, false);
  fft(reB, imB, false);
  // conj(A) * B: its inverse is c[k] = sum over n of a[n] * b[n + k].
  for (let i = 0; i < size; i++) {
    const x = re[i]! * reB[i]! + im[i]! * imB[i]!;
    const y = re[i]! * imB[i]! - im[i]! * reB[i]!;
    re[i] = x;
    im[i] = y;
  }
  fft(re, im, true);

  // Normalised by the whole files' energy, not the overlap's: a lag matching one burst of many scores low,
  // while the true alignment of files that only partly overlap still stands out.
  const norm = Math.sqrt(sumSquares(a) * sumSquares(b));
  if (!(norm > 1e-9)) return none;
  const minOverlap = Math.min(Math.round(MIN_OVERLAP_S / ENERGY_HOP_S), a.length, b.length);
  const lo = -(a.length - minOverlap);
  const hi = b.length - minOverlap;
  const score = new Float64Array(hi - lo + 1);
  let best = lo;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (let k = lo; k <= hi; k++) {
    const r = re[k >= 0 ? k : size + k]! / norm;
    score[k - lo] = r;
    if (r > bestScore) [best, bestScore] = [k, r];
  }
  if (!(bestScore > 0)) return none;

  const lobe = Math.round(LOBE_S / ENERGY_HOP_S);
  let rival = 0;
  for (let k = lo; k <= hi; k++) if (Math.abs(k - best) > lobe && score[k - lo]! > rival) rival = score[k - lo]!;
  const confidence = Math.min(1, Math.max(0, 1 - rival / bestScore)) * Math.min(1, bestScore / FULL_MATCH);
  // Parabola through the peak and its neighbours: finer than one hop.
  const left = score[best - 1 - lo];
  const right = score[best + 1 - lo];
  let shift = 0;
  if (left !== undefined && right !== undefined) {
    const curve = left - 2 * bestScore + right;
    if (curve < 0) shift = Math.max(-0.5, Math.min(0.5, (0.5 * (left - right)) / curve));
  }
  return { lag: (best + shift) * ENERGY_HOP_S, confidence };
}

/** Result of {@link planOffsets} for one file. */
export interface PlannedOffset {
  /** Group-clock second at which the file's time 0 plays; 3 decimals, never negative, earliest file 0. */
  offset: number;
  /** Null for the reference. */
  confidence: number | null;
  /** False when the confidence is too low to trust the lag: the file then starts with the reference. */
  synced: boolean;
}

/**
 * Offsets of every file from their estimates against the first one
 * (`estimates[i]` is for file i + 1). A file whose confidence is below
 * {@link SYNC_LOW_CONFIDENCE} starts together with the first file, then
 * everything shifts so the earliest start is 0.
 */
export function planOffsets(estimates: readonly SyncEstimate[]): PlannedOffset[] {
  const starts = [0];
  const trusted = [true];
  for (const estimate of estimates) {
    const ok = estimate.confidence >= SYNC_LOW_CONFIDENCE;
    trusted.push(ok);
    // Heard at t + lag there means that file's time 0 is lag seconds before the reference's.
    starts.push(ok ? -estimate.lag : 0);
  }
  const earliest = Math.min(...starts);
  return starts.map((start, i) => ({
    offset: Math.max(0, Math.round((start - earliest) * 1000) / 1000),
    confidence: i === 0 ? null : estimates[i - 1]!.confidence,
    synced: trusted[i]!,
  }));
}

/**
 * Envelope of the first {@link SYNC_WINDOW_S}, clamped at the quiet threshold and
 * high-passed (minus its {@link LOCAL_MEAN_S} moving average), so only changes
 * correlate: a steady hum or constant room level matches nothing.
 */
function features(profile: EnergyProfile): Float64Array {
  const length = Math.min(profile.db.length, Math.round(SYNC_WINDOW_S / ENERGY_HOP_S));
  const clamped = new Float64Array(length);
  const prefix = new Float64Array(length + 1);
  for (let i = 0; i < length; i++) {
    clamped[i] = Math.max(profile.db[i]!, profile.threshold) - profile.threshold;
    prefix[i + 1] = prefix[i]! + clamped[i]!;
  }
  const half = Math.round(LOCAL_MEAN_S / ENERGY_HOP_S / 2);
  const out = new Float64Array(length);
  for (let i = 0; i < length; i++) {
    const from = Math.max(0, i - half);
    const to = Math.min(length, i + half + 1);
    out[i] = clamped[i]! - (prefix[to]! - prefix[from]!) / (to - from);
  }
  return out;
}

function sumSquares(values: Float64Array): number {
  let sum = 0;
  for (const value of values) sum += value * value;
  return sum;
}

function nextPowerOfTwo(n: number): number {
  let size = 1;
  while (size < n) size *= 2;
  return size;
}

/** In-place iterative radix-2 FFT; `inverse` also divides by the length. */
function fft(re: Float64Array, im: Float64Array, inverse: boolean): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j]!, re[i]!];
      [im[i], im[j]] = [im[j]!, im[i]!];
    }
  }
  for (let length = 2; length <= n; length <<= 1) {
    const angle = ((inverse ? 2 : -2) * Math.PI) / length;
    const wRe = Math.cos(angle);
    const wIm = Math.sin(angle);
    for (let start = 0; start < n; start += length) {
      let curRe = 1;
      let curIm = 0;
      for (let k = 0; k < length / 2; k++) {
        const a = start + k;
        const b = a + length / 2;
        const tRe = re[b]! * curRe - im[b]! * curIm;
        const tIm = re[b]! * curIm + im[b]! * curRe;
        re[b] = re[a]! - tRe;
        im[b] = im[a]! - tIm;
        re[a] = re[a]! + tRe;
        im[a] = im[a]! + tIm;
        [curRe, curIm] = [curRe * wRe - curIm * wIm, curRe * wIm + curIm * wRe];
      }
    }
  }
  if (inverse) {
    for (let i = 0; i < n; i++) {
      re[i] = re[i]! / n;
      im[i] = im[i]! / n;
    }
  }
}
