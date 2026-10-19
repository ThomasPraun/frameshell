import { SYNC_LOW_CONFIDENCE } from "@frameshell/protocol";
import { describe, expect, it } from "vitest";
import { correlateProfiles, energyEnvelope, energyProfile, planOffsets } from "../src/index.js";

// Pure sync maths on in-memory audio: a shared burst pattern heard at different offsets, and files that share nothing.

const RATE = 16_000;
/** Burst pattern (start s, length s, Hz): irregular on purpose, so only one alignment fits. */
const BURSTS = [
  [1.0, 0.3, 440],
  [2.7, 0.15, 660],
  [5.2, 0.5, 330],
  [7.9, 0.2, 550],
  [11.3, 0.4, 440],
] as const;

/** Mono samples of `seconds`, whose time 0 is `shift` seconds into the pattern; faint noise between bursts. */
function recording(seconds: number, shift: number, bursts: readonly (readonly [number, number, number])[] = BURSTS, gain = 0.4): Int16Array {
  const out = new Int16Array(Math.round(seconds * RATE));
  let seed = 7;
  for (let i = 0; i < out.length; i++) {
    const t = i / RATE + shift;
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    const burst = bursts.find(([start, length]) => t >= start && t < start + length);
    const value = burst ? gain * Math.sin(2 * Math.PI * burst[2] * t) : 0.001 * ((seed / 2 ** 32) * 2 - 1);
    out[i] = Math.round(value * 32767);
  }
  return out;
}

const profile = (samples: Int16Array) => energyProfile(energyEnvelope(samples, RATE));

describe("correlateProfiles", () => {
  it.each([2.34, -1.5, 0, 4.015])("finds a file that started %s s after the reference, within a few ms", (late) => {
    const reference = profile(recording(14, 0));
    // The other recording starts `late` s later: it hears a sound at t - late.
    const other = profile(recording(14, late));
    const estimate = correlateProfiles(reference, other);
    expect(estimate.lag).toBeCloseTo(-late, 2);
    expect(estimate.confidence).toBeGreaterThan(0.6);
  });

  it("finds a single shared tone burst, with full confidence", () => {
    const clap = [[3.0, 0.25, 1000]] as const;
    const estimate = correlateProfiles(profile(recording(10, 0, clap)), profile(recording(10, 1.234, clap)));
    expect(estimate.lag).toBeCloseTo(-1.234, 2);
    expect(estimate.confidence).toBeGreaterThan(0.9);
  });

  it("is not fooled by a different level or a longer, differently cut file", () => {
    const reference = profile(recording(14, 0));
    const quiet = profile(recording(9, 3.2, BURSTS, 0.05));
    const estimate = correlateProfiles(reference, quiet);
    expect(estimate.lag).toBeCloseTo(-3.2, 2);
    expect(estimate.confidence).toBeGreaterThan(0.6);
  });

  it("gives low confidence to a file with other sound, and to featureless sound", () => {
    const reference = profile(recording(14, 0));
    const other = profile(recording(14, 0, [[0.4, 0.9, 300], [3.3, 0.2, 500], [4.1, 0.6, 350], [9.5, 0.3, 450], [12.2, 0.7, 320]]));
    expect(correlateProfiles(reference, other).confidence).toBeLessThan(SYNC_LOW_CONFIDENCE);
    const hum = profile(recording(14, 0, [[0, 14, 440]]));
    expect(correlateProfiles(reference, hum).confidence).toBeLessThan(SYNC_LOW_CONFIDENCE);
  });

  it("has no answer for an empty envelope", () => {
    expect(correlateProfiles(profile(recording(14, 0)), profile(new Int16Array(0)))).toEqual({ lag: 0, confidence: 0 });
  });
});

describe("planOffsets", () => {
  it("starts the earliest file at 0 and measures the others from it", () => {
    // File 2 started 2.5 s after the reference; file 3 started 1 s before it.
    const plan = planOffsets([
      { lag: -2.5, confidence: 0.9 },
      { lag: 1, confidence: 0.7 },
    ]);
    expect(plan.map((entry) => entry.offset)).toEqual([1, 3.5, 0]);
    expect(plan.map((entry) => entry.confidence)).toEqual([null, 0.9, 0.7]);
    expect(plan.every((entry) => entry.synced)).toBe(true);
  });

  it("leaves an untrusted file where the reference starts, whatever lag it measured", () => {
    const plan = planOffsets([{ lag: -7.77, confidence: 0.2 }, { lag: -2, confidence: 0.9 }]);
    expect(plan.map((entry) => entry.offset)).toEqual([0, 0, 2]);
    expect(plan.map((entry) => entry.synced)).toEqual([true, false, true]);
  });
});
