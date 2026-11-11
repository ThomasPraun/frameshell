import { describe, expect, it } from "vitest";
import {
  MATTE_MODEL_PIN,
  SELFIE,
  boxMean,
  classifyMatte,
  coarseAlpha,
  contrast,
  emaWeight,
  etaSeconds,
  formatEta,
  guidedFilter,
  matteKey,
  modelInput,
  refineFrame,
  resizeBilinear,
  smoothForwardBackward,
  standInMatte,
} from "../src/index.js";

const plane = (width: number, height: number, value: (x: number, y: number) => number) =>
  Float32Array.from({ length: width * height }, (_, i) => value(i % width, Math.floor(i / width)));

describe("matte refinement", () => {
  it("box means divide by the pixels inside the picture at its border", () => {
    const size = { width: 5, height: 3 };
    expect([...boxMean(plane(5, 3, () => 0.4), size, 2)].every((v) => Math.abs(v - 0.4) < 1e-6)).toBe(true);
    // One hot pixel in a corner, radius 1: the 2x2 corner window holds it once in 4 pixels.
    const hot = plane(5, 3, (x, y) => (x === 0 && y === 0 ? 1 : 0));
    const mean = boxMean(hot, size, 1);
    expect(mean[0]).toBeCloseTo(1 / 4, 6);
    expect(mean[1]).toBeCloseTo(1 / 6, 6);
    expect(mean[2]).toBeCloseTo(0, 6);
  });

  it("resizes bilinearly with pixel centers aligned: flat stays flat, a ramp stays a ramp", () => {
    const flat = resizeBilinear(plane(4, 2, () => 0.7), { width: 4, height: 2 }, { width: 9, height: 5 });
    expect([...flat].every((v) => Math.abs(v - 0.7) < 1e-6)).toBe(true);
    const ramp = resizeBilinear(plane(2, 1, (x) => x), { width: 2, height: 1 }, { width: 4, height: 1 });
    expect([...ramp].map((v) => Math.round(v * 100) / 100)).toEqual([0, 0.25, 0.75, 1]);
  });

  it("guided filter moves a blurred edge onto the guide's sharp edge and keeps flat input flat", () => {
    const size = { width: 64, height: 8 };
    const guide = plane(64, 8, (x) => (x < 32 ? 0.1 : 0.9));
    // The coarse alpha: a ramp 16 px wide centered on the edge.
    const blurred = plane(64, 8, (x) => Math.min(1, Math.max(0, (x - 24) / 16)));
    const out = guidedFilter(guide, blurred, size, 8, 1e-4);
    const row = (data: Float32Array, x: number) => data[4 * 64 + x]!;
    // Two pixels either side of the edge: much closer to 0 and 1 than the input was.
    expect(row(out, 29)).toBeLessThan(row(blurred, 29) - 0.1);
    expect(row(out, 34)).toBeGreaterThan(row(blurred, 34) + 0.1);
    const flat = guidedFilter(guide, plane(64, 8, () => 0.5), size);
    expect([...flat].every((v) => Math.abs(v - 0.5) < 1e-3)).toBe(true);
  });

  it("contrast steepens around 0.5 by 1.6 and clamps", () => {
    expect(contrast(0.5)).toBe(0.5);
    expect(contrast(0.6)).toBeCloseTo(0.66, 6);
    expect(contrast(0.9)).toBe(1);
    expect(contrast(0.1)).toBe(0);
  });

  it("smooths over the same time at any frame rate", () => {
    // After 0.18 s of a constant input, one pass has covered 1 - 1/e of a step, whatever the fps.
    for (const fps of [24, 30, 60]) {
      const steps = Math.round(0.18 * fps);
      expect(1 - (1 - emaWeight(fps)) ** steps).toBeCloseTo(1 - Math.exp(-1), 1);
    }
  });

  it("forward-backward smoothing has no lag: a step stays centered, flicker shrinks, a constant is kept", () => {
    const step = Array.from({ length: 41 }, (_, t) => Float32Array.of(t < 20 ? 0 : 1));
    const smooth = smoothForwardBackward(step, emaWeight(30));
    // Zero phase: the half-way point stays where the step is (between frames 19 and 20).
    expect(smooth[19]![0]).toBeLessThan(0.5);
    expect(smooth[20]![0]).toBeGreaterThan(0.5);
    expect(smooth[19]![0]! + smooth[20]![0]!).toBeCloseTo(1, 1);
    const flicker = Array.from({ length: 30 }, (_, t) => Float32Array.of(t % 2 === 0 ? 0.4 : 0.6));
    const calm = smoothForwardBackward(flicker, emaWeight(30));
    const swing = (frames: Float32Array[]) => Math.max(...frames.slice(5, 25).map((f) => Math.abs(f[0]! - 0.5)));
    expect(swing(calm)).toBeLessThan(swing(flicker) / 4);
    for (const frame of smoothForwardBackward([Float32Array.of(0.3), Float32Array.of(0.3)], 0.2)) expect(frame[0]).toBeCloseTo(0.3, 6);
  });

  it("refines a frame into luma bytes: subject 255, background 0", () => {
    const size = { width: 32, height: 16 };
    const gray = plane(32, 16, (x) => (x < 16 ? 0 : 1));
    const coarse = plane(8, 4, (x) => (x < 4 ? 0 : 1));
    const luma = refineFrame(coarse, { width: 8, height: 4 }, gray, size);
    expect(luma).toHaveLength(32 * 16);
    expect(luma[8 * 32 + 2]).toBe(0);
    expect(luma[8 * 32 + 29]).toBe(255);
  });
});

describe("matte models", () => {
  it("feeds the selfie model a 256x256 NCHW frame in 0..1, each pixel the mean of the frame pixels it covers", () => {
    const frame = { width: 512, height: 256 };
    const rgb = new Uint8Array(512 * 256 * 3);
    // Red left half, blue right half; every other row of the left half dark.
    for (let y = 0; y < 256; y++) {
      for (let x = 0; x < 512; x++) {
        const i = (y * 512 + x) * 3;
        if (x < 256) rgb[i] = y % 2 === 0 ? 255 : 0;
        else rgb[i + 2] = 255;
      }
    }
    const { data, size } = modelInput(SELFIE, rgb, frame);
    expect(size).toEqual({ width: 256, height: 256 });
    const at = (channel: number, x: number, y: number) => data[channel * 256 * 256 + y * 256 + x]!;
    // Two frame columns and one frame row per input pixel vertically: the dark rows average in.
    expect(at(0, 10, 10)).toBeCloseTo(1, 5);
    expect(at(0, 10, 11)).toBeCloseTo(0, 5);
    expect(at(2, 200, 10)).toBeCloseTo(1, 5);
    expect(at(1, 200, 10)).toBe(0);
  });

  it("clamps the model output and refuses one of the wrong size", () => {
    expect([...coarseAlpha([-0.01, 0.5, 1.02, 1], { width: 2, height: 2 })]).toEqual([0, 0.5, 1, 1]);
    expect(() => coarseAlpha([0, 1], { width: 2, height: 2 })).toThrow(/not the pinned model/);
  });

  it("names the pin by model id and revision", () => {
    expect(MATTE_MODEL_PIN).toBe("mediapipe-selfie@be49485c8e02");
  });

  it("stand-in takes what is brighter than mid-gray as the subject", async () => {
    const frame = { width: 256, height: 144 };
    const rgb = new Uint8Array(256 * 144 * 3);
    for (let y = 0; y < 144; y++) for (let x = 128; x < 256; x++) rgb.fill(230, (y * 256 + x) * 3, (y * 256 + x) * 3 + 3);
    const { alpha, size } = await standInMatte(rgb, frame);
    expect(size).toEqual({ width: 128, height: 72 });
    expect(alpha[10 * 128 + 10]).toBe(0);
    expect(alpha[10 * 128 + 100]).toBe(1);
  });
});

describe("matte cache", () => {
  const hash = `sha256:${"ab".repeat(32)}`;

  it("keys by content, model, fps and version, and gc recognizes its files and temps only", () => {
    const key = matteKey(hash, MATTE_MODEL_PIN, 30);
    expect(key).toMatch(/^abababababababababab-m1-[0-9a-f]{8}$/);
    expect(matteKey(hash, MATTE_MODEL_PIN, 30)).toBe(key);
    expect(matteKey(hash, "stand-in", 30)).not.toBe(key);
    expect(matteKey(hash, MATTE_MODEL_PIN, 25)).not.toBe(key);
    expect(matteKey(hash, MATTE_MODEL_PIN, 29.97)).toBe(matteKey(hash, MATTE_MODEL_PIN, 30000 / 1001));
    expect(classifyMatte(`${key}.mp4`, false)).toEqual({ kind: "matte", key });
    expect(classifyMatte(`${key}.json`, false)).toEqual({ kind: "matte", key });
    expect(classifyMatte(`${key}.123-456.partial`, false)).toEqual({ kind: "temp", key: null });
    expect(classifyMatte(`${key}.123-456.coarse`, false)).toEqual({ kind: "temp", key: null });
    expect(classifyMatte(`${key}.json.123.ab12.tmp`, false)).toEqual({ kind: "temp", key: null });
    expect(classifyMatte("notes.txt", false)).toBeNull();
    expect(classifyMatte(key, true)).toBeNull();
  });

  it("estimates time left from the share done", () => {
    expect(etaSeconds(10_000, 0)).toBeNull();
    expect(etaSeconds(10_000, 0.25)).toBe(30);
    expect(etaSeconds(10_000, 1)).toBe(0);
    expect([formatEta(40), formatEta(180), formatEta(3900)]).toEqual(["40 s", "3 min", "1 h 5 min"]);
  });
});
