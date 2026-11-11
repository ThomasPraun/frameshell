import { ENERGY_HOP_S, energyEnvelope } from "../media/energy.js";
import type { Pcm16 } from "../transcripts/window.js";

/**
 * Quiet = this far below the take's loudest 10 ms (#470: -38 dB relative to peak). A synthetic voice has no
 * room noise, so its peak is a steady reference; ADR 0003's percentile threshold is tuned for recordings.
 */
export const TRIM_RANGE_DB = 38;
/** Air kept before the first sound (#470: 20 ms lead). */
export const TRIM_LEAD_S = 0.02;
/** Air kept after the last sound (#470: 30 ms tail). */
export const TRIM_TAIL_S = 0.03;
/** A take whose loudest 10 ms stays under this (dBFS) holds no speech. */
const SILENT_DB = -60;

/** Outcome of {@link trimSilence}. */
export interface TrimmedTake {
  pcm: Pcm16;
  /** Seconds removed from the start. */
  head: number;
  /** Seconds removed from the end. */
  tail: number;
  /** True when the whole take is quieter than speech: kept untrimmed. */
  silent: boolean;
}

/**
 * Cut a take's leading and trailing silence, keeping {@link TRIM_LEAD_S} / {@link TRIM_TAIL_S} of air, on the
 * 10 ms energy envelope cut snapping uses (ADR 0003). Silence inside the take stays.
 */
export function trimSilence(pcm: Pcm16): TrimmedTake {
  const db = energyEnvelope(pcm.samples, pcm.sampleRate);
  const peak = db.reduce((loudest, value) => Math.max(loudest, value), Number.NEGATIVE_INFINITY);
  if (db.length === 0 || peak < SILENT_DB) return { pcm, head: 0, tail: 0, silent: true };
  const threshold = peak - TRIM_RANGE_DB;
  const first = db.findIndex((value) => value > threshold);
  let last = db.length - 1;
  while (db[last]! <= threshold) last--;
  const rate = pcm.sampleRate;
  const from = Math.max(0, Math.round((first * ENERGY_HOP_S - TRIM_LEAD_S) * rate));
  const to = Math.min(pcm.samples.length, Math.round(((last + 1) * ENERGY_HOP_S + TRIM_TAIL_S) * rate));
  return {
    pcm: { sampleRate: rate, samples: pcm.samples.slice(from, to) },
    head: round(from / rate),
    tail: round((pcm.samples.length - to) / rate),
    silent: false,
  };
}

function round(seconds: number): number {
  return Math.round(seconds * 1000) / 1000;
}
