import { describe, expect, it } from "vitest";
import { LOUDNESS_PASSES, LOUDNESS_TOLERANCE_LU, MAX_TRIM_DB, TRUE_PEAK_CEILINGS, limiterEngages, settleTrim, truePeakCeiling } from "../src/export/true-peak.js";

describe("truePeakCeiling", () => {
  it("gives lossy codecs more headroom than PCM, and low bitrates the most", () => {
    expect(truePeakCeiling("pcm")).toBeLessThan(-1);
    for (const codec of ["aac", "opus"] as const) {
      expect(truePeakCeiling(codec, 320)).toBeLessThan(truePeakCeiling("pcm"));
      expect(truePeakCeiling(codec, 32)).toBeLessThan(truePeakCeiling(codec, 320));
      expect(truePeakCeiling(codec)).toBe(truePeakCeiling(codec, 32));
    }
    expect(truePeakCeiling("aac", 160)).toBe(truePeakCeiling("aac", 320));
    expect(truePeakCeiling("aac", 128)).toBe(truePeakCeiling("aac", 96));
    expect(truePeakCeiling("opus", 64)).toBe(truePeakCeiling("opus", 192));
  });

  it("keeps every class list ordered from the highest bitrate down and ending at 0 kbps", () => {
    for (const classes of Object.values(TRUE_PEAK_CEILINGS)) {
      expect(classes[classes.length - 1]!.minKbps).toBe(0);
      expect(classes.map((entry) => entry.minKbps)).toEqual([...classes.map((entry) => entry.minKbps)].sort((a, b) => b - a));
      for (const entry of classes) expect(entry.ceiling).toBeLessThanOrEqual(-1);
    }
  });
});

describe("limiterEngages", () => {
  it("compares the predicted peak (measured true peak plus the loudnorm gain) with the ceiling", () => {
    expect(limiterEngages({ input_tp: "-6.0", target_offset: "3.0" }, -2.3)).toBe(false);
    expect(limiterEngages({ input_tp: "-6.0", target_offset: "4.0" }, -2.3)).toBe(true);
    expect(limiterEngages({ input_tp: "garbage", target_offset: "1" }, -2.3)).toBe(true);
  });
});

describe("settleTrim", () => {
  it("measures once and adds nothing when the loudness is already within the tolerance", async () => {
    let calls = 0;
    const trim = await settleTrim(-17, async () => {
      calls++;
      return -17.1;
    });
    expect([trim, calls]).toEqual([0, 1]);
  });

  it("adds the loss back and lands within the tolerance", async () => {
    // A limiter that costs 0.6 LU whatever the gain.
    const measure = async (trim: number) => -17.6 + trim;
    const trim = await settleTrim(-17, measure);
    expect(trim).toBeCloseTo(0.6, 5);
    expect(Math.abs(-17 - (await measure(trim)))).toBeLessThanOrEqual(LOUDNESS_TOLERANCE_LU);
  });

  it("follows a limiter that eats part of every dB it is given, within the measurement budget", async () => {
    let calls = 0;
    const measure = async (trim: number) => {
      calls++;
      return -17.6 + 0.7 * trim;
    };
    const trim = await settleTrim(-17, measure);
    expect(calls).toBeLessThanOrEqual(LOUDNESS_PASSES);
    expect(Math.abs(-17 - (-17.6 + 0.7 * trim))).toBeLessThanOrEqual(LOUDNESS_TOLERANCE_LU);
  });

  it("stops at the trim cap when the loudness cannot be reached", async () => {
    const trim = await settleTrim(-17, async (trimDb) => -25 + 0.1 * trimDb);
    expect(trim).toBe(MAX_TRIM_DB);
  });

  it("keeps the trim of the best measurement when a later one is worse", async () => {
    const readings = [-17.5, -19, -18];
    let call = 0;
    expect(await settleTrim(-17, async () => readings[call++]!)).toBe(0);
  });

  it("adds nothing for silence", async () => {
    expect(await settleTrim(-17, async () => null)).toBe(0);
  });
});
