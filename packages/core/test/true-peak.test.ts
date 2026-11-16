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
  // loudnorm's linear pass applies target - input_i (not target_offset), so the peak lands at input_tp + that.
  it("compares the predicted peak (measured true peak plus the gain to the target) with the ceiling", () => {
    expect(limiterEngages({ input_i: "-23.0", input_tp: "-12.0" }, -17, -2.3)).toBe(false);
    expect(limiterEngages({ input_i: "-23.0", input_tp: "-8.0" }, -17, -2.3)).toBe(true);
    expect(limiterEngages({ input_i: "garbage", input_tp: "-8.0" }, -17, -2.3)).toBe(true);
  });

  it("engages on a quiet mix whose target_offset would hide the peak (measured with ffmpeg 9.0.2)", () => {
    // input_tp -8.72, input_i -28.39, target_offset 3.10: the gain to -17 is 11.39 dB, so the peak lands at +2.67 dBTP.
    const measured = { input_i: "-28.39", input_tp: "-8.72" };
    expect(limiterEngages(measured, -17, -2.3)).toBe(true);
    expect(limiterEngages(measured, -17, -1.2)).toBe(true);
  });

  it("treats a peak above loudnorm's own -1 dBTP (dynamic mode) as engaging for every ceiling", () => {
    for (const classes of Object.values(TRUE_PEAK_CEILINGS)) {
      for (const { ceiling } of classes) expect(limiterEngages({ input_i: "-20.0", input_tp: "-3.0" }, -17, ceiling)).toBe(true);
    }
  });
});

describe("settleTrim", () => {
  it("limits the trim to MAX_TRIM_DB in both directions", async () => {
    expect(await settleTrim(-17, async (trimDb) => -30 + trimDb * 0.1)).toBeLessThanOrEqual(MAX_TRIM_DB);
    expect(await settleTrim(-17, async (trimDb) => -5 + trimDb * 0.1)).toBeGreaterThanOrEqual(-MAX_TRIM_DB);
  });

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

  it("uses the measured slope once it has two measurements, so a limiter that eats most of each dB still settles", async () => {
    let calls = 0;
    const measure = async (trim: number) => {
      calls++;
      return -18 + 0.4 * trim;
    };
    const trim = await settleTrim(-17, measure);
    expect(calls).toBeLessThanOrEqual(LOUDNESS_PASSES);
    expect(Math.abs(-17 - (-18 + 0.4 * trim))).toBeLessThanOrEqual(LOUDNESS_TOLERANCE_LU);
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
