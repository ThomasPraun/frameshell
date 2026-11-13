// Loudness of a generated track without ffmpeg (ADR 0038): ITU-R BS.1770 integrated loudness at 48 kHz, a look-ahead
// peak limiter, and the loop that brings a mix to a target loudness under a peak ceiling. Pure arithmetic, so the
// same mix gives the same file everywhere; tests check the meter against ffmpeg's `ebur128`.
import { SR } from "./dsp.js";

/** BS.1770 K-weighting at 48 kHz: a high shelf, then a high-pass (coefficients from the standard, `[b0, b1, b2, a1, a2]`). */
const K_WEIGHTING = [
  [1.53512485958697, -2.69169618940638, 1.19839281085285, -1.69065929318241, 0.73248077421585],
  [1.0, -2.0, 1.0, -1.99004745483398, 0.99007225036621],
] as const;

/** Mean square of the K-weighted `channel` over 400 ms blocks every 100 ms. */
function blockPowers(channel: ArrayLike<number>): Float64Array {
  const weighted = new Float64Array(channel.length);
  for (let i = 0; i < channel.length; i++) weighted[i] = channel[i]!;
  for (const [b0, b1, b2, a1, a2] of K_WEIGHTING) {
    let x1 = 0;
    let x2 = 0;
    let y1 = 0;
    let y2 = 0;
    for (let i = 0; i < weighted.length; i++) {
      const x = weighted[i]!;
      const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      x2 = x1;
      x1 = x;
      y2 = y1;
      y1 = y;
      weighted[i] = y;
    }
  }
  const block = Math.round(0.4 * SR);
  const hop = Math.round(0.1 * SR);
  const count = weighted.length < block ? 0 : Math.floor((weighted.length - block) / hop) + 1;
  // Running sum of squares, so each block costs two lookups.
  const sums = new Float64Array(weighted.length + 1);
  for (let i = 0; i < weighted.length; i++) sums[i + 1] = sums[i]! + weighted[i]! * weighted[i]!;
  const powers = new Float64Array(count);
  for (let j = 0; j < count; j++) powers[j] = (sums[j * hop + block]! - sums[j * hop]!) / block;
  return powers;
}

const loudnessOf = (power: number) => -0.691 + (10 * Math.log(power)) / Math.LN10;

/** Integrated loudness of 48 kHz `channels` (left and right weigh 1), LUFS; -Infinity when nothing passes the -70 LUFS gate. */
export function integratedLoudness(channels: readonly ArrayLike<number>[]): number {
  const perChannel = channels.map(blockPowers);
  const count = perChannel[0]?.length ?? 0;
  const blocks = Array.from({ length: count }, (_, j) => perChannel.reduce((sum, powers) => sum + powers[j]!, 0));
  const gated = (threshold: number) => blocks.filter((power) => power > 0 && loudnessOf(power) > threshold);
  const absolute = gated(-70);
  if (absolute.length === 0) return Number.NEGATIVE_INFINITY;
  const relative = loudnessOf(absolute.reduce((sum, power) => sum + power, 0) / absolute.length) - 10;
  const kept = gated(Math.max(-70, relative));
  return loudnessOf(kept.reduce((sum, power) => sum + power, 0) / kept.length);
}

/**
 * Hold every sample of `channels` at or under `ceiling` (linear) with one gain curve for all channels: the gain each
 * sample needs, its minimum over the next 5 ms, averaged over 5 ms (so the gain is down before the peak arrives and
 * moves smoothly), then let go at most 1/(60 ms) a sample. Every step keeps the gain at a peak at or under what that
 * peak needs, so the ceiling holds. Returns new arrays.
 */
export function limitPeaks(channels: readonly Float64Array[], ceiling: number): Float64Array[] {
  const n = channels[0]?.length ?? 0;
  const look = Math.round(0.005 * SR);
  const need = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let peak = 0;
    for (const channel of channels) peak = Math.max(peak, Math.abs(channel[i]!));
    need[i] = peak > ceiling ? ceiling / peak : 1;
  }
  // Minimum over [i, i + look] with a monotonic queue.
  const ahead = new Float64Array(n);
  const queue = new Int32Array(n);
  let head = 0;
  let tail = 0;
  for (let i = n - 1; i >= 0; i--) {
    while (tail > head && need[queue[tail - 1]!]! >= need[i]!) tail--;
    queue[tail++] = i;
    while (queue[head]! > i + look) head++;
    ahead[i] = need[queue[head]!]!;
  }
  // Mean over [i - look, i]: every value in it covers sample i, so the mean is at most need[i].
  const gain = new Float64Array(n);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    sum += ahead[i]!;
    if (i > look) sum -= ahead[i - look - 1]!;
    gain[i] = sum / Math.min(i + 1, look + 1);
  }
  const release = 1 / (0.06 * SR);
  let current = 1;
  for (let i = 0; i < n; i++) {
    current = Math.min(gain[i]!, current + release);
    gain[i] = current;
  }
  return channels.map((channel) => {
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) out[i] = channel[i]! * gain[i]!;
    return out;
  });
}

/** Largest absolute sample over `channels`. */
function peakOfMix(channels: readonly Float64Array[]): number {
  let peak = 0;
  for (const channel of channels) for (let i = 0; i < channel.length; i++) peak = Math.max(peak, Math.abs(channel[i]!));
  return peak;
}

/**
 * Bring `channels` to `targetLufs` with the sample peak at most `ceilingDb` dBFS: a gain, the limiter, then the
 * loudness measured again and the gain corrected, at most three passes or until within 0.15 LU. Returns the result,
 * its loudness (LUFS) and its peak (dBFS).
 */
export function normaliseLoudness(channels: readonly Float64Array[], targetLufs: number, ceilingDb: number): { channels: Float64Array[]; lufs: number; peakDb: number } {
  const ceiling = Math.exp((ceilingDb / 20) * Math.LN10);
  const measured = integratedLoudness(channels);
  if (!Number.isFinite(measured)) return { channels: channels.map((channel) => channel.slice()), lufs: measured, peakDb: Number.NEGATIVE_INFINITY };
  let gainDb = targetLufs - measured;
  let out: Float64Array[] = [];
  let lufs = measured;
  for (let pass = 0; pass < 3; pass++) {
    const gain = Math.exp((gainDb / 20) * Math.LN10);
    out = limitPeaks(
      channels.map((channel) => {
        const scaled = new Float64Array(channel.length);
        for (let i = 0; i < channel.length; i++) scaled[i] = channel[i]! * gain;
        return scaled;
      }),
      ceiling,
    );
    lufs = integratedLoudness(out);
    if (Math.abs(lufs - targetLufs) <= 0.15) break;
    gainDb += targetLufs - lufs;
  }
  const peak = peakOfMix(out);
  return { channels: out, lufs, peakDb: peak > 0 ? (20 * Math.log(peak)) / Math.LN10 : Number.NEGATIVE_INFINITY };
}
