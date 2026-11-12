import { ENERGY_HOP_S } from "../media/energy.js";

/**
 * The final hit of a music track (ADR 0037 decision 7), found on the 10 ms energy envelope that cut snapping and ducking
 * already use (`media/energy-store.ts`). Pure: callers bring the envelope and, when the project has a beat grid of the
 * file, its measured hits to place the result to a few milliseconds.
 */

/** Hops (envelope values) looked back at to know what the level was before a jump. */
const BEFORE_HOPS = 3;
/** Smallest jump in level, dB, that is a hit. */
const MIN_RISE_DB = 6;
/** A hit is within this many dB of the loud part of the track (its 95th percentile). */
const LOUD_WITHIN_DB = 14;
/** The loud part must stand this far over the quiet part, dB, or the sound has no hits (a drone, a noise bed). */
const MIN_RANGE_DB = 10;
/** Jumps closer than this are one hit (a flam, a snare on a kick). */
const MERGE_HOPS = 10;
/** Where after the hit the fall-away is measured: 0.5 s to 1.5 s. */
const POST_FROM_HOPS = 50;
const POST_TO_HOPS = 150;
/** A jump with this much rise counts as fully sharp. */
const SHARP_RISE_DB = 18;
/** Fall-away, dB under the hit, that counts as fully ringing out (silence or a long tail after it). */
const FALL_DB = 24;
const FALL_FROM_DB = 6;
/** Seconds between the hit and the end of the played part under which the track plainly ends on it. */
const CLOSE_S = 10;
const FAR_S = 30;
/** Fall-away score of a hit with under 0.7 s of sound left after it: the track stops on it, which is what a final hit does. */
const ENDS_ON_HIT = 0.7;
/** A measured beat-grid hit this close, seconds, places the envelope's. */
const ONSET_REACH_S = 0.04;
/** How many of the last hits are listed as choices. */
const LISTED = 5;

/** A strong jump in level. */
export interface HitCandidate {
  /** Source seconds. */
  at: number;
  /** dB the level jumps by. */
  rise: number;
  /** dB against the track's loud level (its 95th percentile): 0 = as loud, positive = louder. */
  level: number;
}

/** The final hit of a stretch of a track, with how sure we are. */
export interface FinalHit extends HitCandidate {
  /** 0 to 1; see {@link finalHit}. */
  confidence: number;
  /** The last {@link HitCandidate}s, latest last; the final hit is the last. */
  candidates: HitCandidate[];
}

/**
 * The last strong hit in source window [`from`, `to`) of an envelope (dBFS per {@link ENERGY_HOP_S}, from source 0), or
 * null when the sound has none (silence, a steady drone, under 0.3 s of sound).
 *
 * A hit is a jump of at least 6 dB over the loudest of the 30 ms before it, to within 14 dB of the track's loud level. The
 * latest one is the final hit. Its confidence is the geometric mean of how sharp the jump is (6 dB: 0, 18 dB or more: 1) and
 * how far the sound falls away 0.5 to 1.5 s after it (6 dB under: 0, 24 dB or more: 1), times how close it is to the end of the
 * window (full inside 10 s, none from 30 s): a fade out or a track that goes on after its last accent scores low. When
 * `onsets` (source seconds of measured hits, from the beat grid) has one within 40 ms, the hit is placed on it.
 */
export function finalHit(db: Float32Array, window: { from: number; to: number }, onsets?: readonly number[]): FinalHit | null {
  const first = Math.max(0, Math.floor(window.from / ENERGY_HOP_S + 1e-9));
  const last = Math.min(db.length, Math.ceil(window.to / ENERGY_HOP_S - 1e-9));
  if (last - first < 30) return null;
  const sorted = Float32Array.from(db.subarray(first, last)).sort();
  const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))]!;
  const loud = at(0.95);
  if (loud - at(0.1) < MIN_RANGE_DB) return null;

  const jumps: { hop: number; rise: number; level: number }[] = [];
  for (let i = first + BEFORE_HOPS; i < last - 1; i++) {
    const after = Math.max(db[i]!, db[i + 1]!);
    const before = Math.max(db[i - 1]!, db[i - 2]!, db[i - 3]!);
    const rise = after - before;
    if (rise < MIN_RISE_DB || after < loud - LOUD_WITHIN_DB) continue;
    // The jump shows one hop early (the hit starts inside the hop before its loud one): the first loud hop is the hit.
    const hop = db[i]! >= before + MIN_RISE_DB ? i : i + 1;
    const previous = jumps.at(-1);
    if (previous && hop - previous.hop < MERGE_HOPS) {
      if (rise > previous.rise) jumps[jumps.length - 1] = { hop: previous.hop, rise, level: after - loud };
      continue;
    }
    jumps.push({ hop, rise, level: after - loud });
  }
  const finalJump = jumps.at(-1);
  if (!finalJump) return null;

  const place = (hop: number) => {
    const time = hop * ENERGY_HOP_S;
    let nearest: number | undefined;
    for (const onset of onsets ?? []) if (Math.abs(onset - time) <= ONSET_REACH_S && (nearest === undefined || Math.abs(onset - time) < Math.abs(nearest - time))) nearest = onset;
    return round(nearest ?? time, 3);
  };
  const candidates = jumps.slice(-LISTED).map((jump): HitCandidate => ({ at: place(jump.hop), rise: round(jump.rise, 1), level: round(jump.level, 1) }));

  const hit = finalJump.hop;
  const sharp = clamp01((finalJump.rise - MIN_RISE_DB) / (SHARP_RISE_DB - MIN_RISE_DB));
  const peak = Math.max(...Array.from(db.subarray(hit, Math.min(last, hit + 6))));
  const ring = Array.from(db.subarray(Math.min(last, hit + POST_FROM_HOPS), Math.min(last, hit + POST_TO_HOPS)));
  const falls = ring.length >= 20 ? clamp01((peak - ring.reduce((sum, value) => sum + value, 0) / ring.length - FALL_FROM_DB) / (FALL_DB - FALL_FROM_DB)) : ENDS_ON_HIT;
  const toEnd = (last - hit) * ENERGY_HOP_S;
  const close = toEnd <= CLOSE_S ? 1 : clamp01(1 - (toEnd - CLOSE_S) / (FAR_S - CLOSE_S));
  const confidence = round(Math.sqrt(sharp * falls) * close, 2);
  const placed = candidates.at(-1)!;
  return { ...placed, confidence, candidates };
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
const round = (value: number, decimals: number) => Math.round(value * 10 ** decimals) / 10 ** decimals;
