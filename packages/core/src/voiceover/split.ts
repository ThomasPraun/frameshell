import { energyEnvelope } from "../media/energy.js";
import type { Pcm16 } from "../transcripts/window.js";

/** RMS resolution of the split (#470: 5 ms), finer than the 10 ms envelope of cut snapping (ADR 0003). */
export const SPLIT_HOP_S = 0.005;
/** Quiet = this far below the take's loudest 5 ms (#470: -38 dB relative to peak); the same range as the trim. */
export const SPLIT_RANGE_DB = 38;
/** A quiet run this long ends a phrase (#470: 60 ms); shorter ones are the gaps between words. */
export const SPLIT_MIN_SILENCE_S = 0.06;
/** Air kept before a phrase's first sound (#470: 20 ms). */
export const SPLIT_LEAD_S = 0.02;
/** Air kept after a phrase's last sound (#470: 30 ms). */
export const SPLIT_TAIL_S = 0.03;
/** Fade a phrase clip gets at both ends (#470: 12 ms), so a trimmed edge never clicks. */
export const PHRASE_FADE_S = 0.012;
/** A take whose loudest 5 ms stays under this (dBFS) holds no speech: one phrase, the whole take. */
const SILENT_DB = -60;

/** One phrase of a take: a range of its seconds. */
export interface Phrase {
  /** Start, take seconds (3 decimals). */
  from: number;
  /** End, take seconds (3 decimals). */
  to: number;
}

/**
 * Cut a take into phrases at its silences (ADR 0034 decision 17): on the 5 ms RMS envelope, a hop is quiet when it
 * is {@link SPLIT_RANGE_DB} below the loudest one; a quiet run of at least {@link SPLIT_MIN_SILENCE_S} separates two
 * phrases. Each phrase keeps {@link SPLIT_LEAD_S} before and {@link SPLIT_TAIL_S} after its sound, which fit inside
 * the shortest silence, so phrases never overlap. A take with no speech in it is one phrase.
 */
export function splitPhrases(pcm: Pcm16): Phrase[] {
  const duration = pcm.samples.length / pcm.sampleRate;
  const whole = [{ from: 0, to: round(duration) }];
  const db = energyEnvelope(pcm.samples, pcm.sampleRate, SPLIT_HOP_S);
  const peak = db.reduce((loudest, value) => Math.max(loudest, value), Number.NEGATIVE_INFINITY);
  if (db.length === 0 || peak < SILENT_DB) return whole;
  const threshold = peak - SPLIT_RANGE_DB;
  // The envelope's real hop in seconds: a whole number of samples, so a few ppm off SPLIT_HOP_S at odd rates.
  const hop = Math.max(1, Math.round(pcm.sampleRate * SPLIT_HOP_S)) / pcm.sampleRate;
  const minQuiet = Math.round(SPLIT_MIN_SILENCE_S / SPLIT_HOP_S);

  const runs: { first: number; last: number }[] = [];
  let quiet = 0;
  for (let i = 0; i < db.length; i++) {
    if (db[i]! <= threshold) {
      quiet++;
      continue;
    }
    const open = runs.at(-1);
    if (open && quiet < minQuiet) open.last = i;
    else runs.push({ first: i, last: i });
    quiet = 0;
  }
  return runs.map(({ first, last }) => ({
    from: round(Math.max(0, first * hop - SPLIT_LEAD_S)),
    to: round(Math.min(duration, (last + 1) * hop + SPLIT_TAIL_S)),
  }));
}

function round(seconds: number): number {
  return Math.round(seconds * 1000) / 1000;
}
