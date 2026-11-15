// True-peak ceiling per audio codec and the loudness re-measure loop of the export limiter (SPEC §3.5 step 4,
// ADR 0038 "as built"). Pure, so the data and the loop are tested without ffmpeg.
import type { ExportPreset } from "@frameshell/schema";

/** One bitrate class of a codec: from `minKbps` up, the limiter holds the mix at `ceiling` dBTP. */
export interface CeilingClass {
  minKbps: number;
  ceiling: number;
}

/**
 * Ceiling of the export's true-peak limiter, dBTP, by codec and bitrate; the first class whose `minKbps` the bitrate
 * reaches applies (an unknown bitrate counts as 0). The goal is a file at or under -1 dBTP after the encode (AES TD1008
 * section 4: -1 dBTP at the codec input of a lossy stream; EBU R128 s1), so lossy codecs get headroom for the overs
 * their encode adds.
 *
 * Source: ffmpeg 9.0.2 (`aac`, `libopus`, `pcm_s16le`), stereo beds of 0.05 and 0.15 under a 1 or 2 ms burst of 0.9 full
 * scale every 250 ms (1.5 and 3 kHz, 3 phases each: 24 files), loudnorm-normalised to -17 LUFS and limited at
 * -1.0 dBTP, then encoded; the `ebur128` true peak of the file minus -1.0 is the overshoot the encode adds:
 * - pcm: up to +0.1 dB (the limiter's own leak and the 16-bit rounding).
 * - opus 64-192 kbps: up to +0.7 dB; 48 kbps: up to +3.7 dB.
 * - aac 160-320 kbps: up to +1.2 dB (not monotonic in bitrate: 192 kbps +0.9, 256 kbps +0.1); 96 and 128 kbps: up to
 *   +3.8 and +3.0 dB.
 * Each ceiling is -1 dBTP minus the worst overshoot of its class minus 0.1 dB (the meter reads to 0.1). Full-scale bursts are the worst case: speech and music overshoot far less, and what the ceiling costs in
 * loudness is added back by the re-measure (see {@link settleTrim}). A burst above 5 kHz can still exceed a ceiling.
 */
export const TRUE_PEAK_CEILINGS: Record<NonNullable<ExportPreset["audio"]>["codec"], readonly CeilingClass[]> = {
  pcm: [{ minKbps: 0, ceiling: -1.2 }],
  opus: [
    { minKbps: 64, ceiling: -1.8 },
    { minKbps: 0, ceiling: -4.9 },
  ],
  aac: [
    { minKbps: 160, ceiling: -2.3 },
    { minKbps: 0, ceiling: -4.9 },
  ],
};

/** The limiter ceiling, dBTP, for `codec` at `bitrateKbps` (absent = unknown); see {@link TRUE_PEAK_CEILINGS}. */
export function truePeakCeiling(codec: keyof typeof TRUE_PEAK_CEILINGS, bitrateKbps?: number): number {
  const classes = TRUE_PEAK_CEILINGS[codec];
  return (classes.find((entry) => (bitrateKbps ?? 0) >= entry.minKbps) ?? classes[classes.length - 1]!).ceiling;
}

/** The limiter lands the integrated loudness within this many LU of the target (SPEC §3.5 step 4). */
export const LOUDNESS_TOLERANCE_LU = 0.15;
/** Measurements the loop makes at most; the best one wins. */
export const LOUDNESS_PASSES = 3;
/** Largest gain, dB, the loop adds before the limiter: past it the limiter eats the gain and loudness cannot follow. */
export const MAX_TRIM_DB = 3;

/**
 * Whether the limiter can touch the mix: loudnorm's measured true peak plus the gain it applies (`target_offset`)
 * reaches `ceiling`. When not, the loudness is what loudnorm made it and nothing needs re-measuring.
 */
export function limiterEngages(measured: { input_tp: string; target_offset: string }, ceiling: number): boolean {
  const predicted = Number(measured.input_tp) + Number(measured.target_offset);
  return !Number.isFinite(predicted) || predicted > ceiling;
}

/**
 * Find the gain, dB, to add before the limiter so the limited mix lands within {@link LOUDNESS_TOLERANCE_LU} of
 * `target` LUFS. `measure(trim)` renders the limited mix with that trim and returns its integrated loudness (null for
 * silence). Each pass adds the remaining error to the trim, at most {@link LOUDNESS_PASSES} measurements and
 * {@link MAX_TRIM_DB}; returns the trim of the closest measurement.
 */
export async function settleTrim(target: number, measure: (trimDb: number) => Promise<number | null>): Promise<number> {
  let trim = 0;
  let best = { trim: 0, error: Number.POSITIVE_INFINITY };
  for (let pass = 0; pass < LOUDNESS_PASSES; pass++) {
    const loudness = await measure(trim);
    if (loudness === null) return best.trim;
    const error = target - loudness;
    if (Math.abs(error) < Math.abs(best.error)) best = { trim, error };
    if (Math.abs(error) <= LOUDNESS_TOLERANCE_LU) break;
    const next = Math.min(MAX_TRIM_DB, trim + error);
    if (next === trim) break;
    trim = next;
  }
  return best.trim;
}
