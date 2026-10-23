import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { FBANK_BINS, fbank, subtractMean } from "../src/index.js";

const reference = JSON.parse(readFileSync(new URL("./fixtures/fbank-reference.json", import.meta.url), "utf8")) as {
  samples: number;
  frames: number;
  rows: Record<string, number[]>;
};

/** 50 ms of digital silence (log floor), then two tones and LCG noise: the signal the reference rows were computed from. */
function syntheticSignal(n: number): Float32Array {
  const samples = new Float32Array(n);
  let x = 12345;
  for (let i = 800; i < n; i++) {
    x = (Math.imul(x, 1103515245) + 12345) & 0x7fffffff;
    const noise = x / 0x3fffffff - 1;
    samples[i] = 0.3 * Math.sin((2 * Math.PI * 440 * i) / 16000) + 0.2 * Math.sin((2 * Math.PI * 3100 * i) / 16000 + 0.5) + 0.05 * noise;
  }
  return samples;
}

describe("fbank", () => {
  it("matches kaldi-native-fbank with sherpa-onnx's settings, edge frames and the silence floor included", () => {
    const features = fbank(syntheticSignal(reference.samples));
    expect(features.frames).toBe(reference.frames);
    for (const [frame, row] of Object.entries(reference.rows)) {
      const ours = Array.from(features.data.subarray(Number(frame) * FBANK_BINS, (Number(frame) + 1) * FBANK_BINS));
      // float32 in kaldi against float64 here: log energies agree to about 1e-4 (2e-4 seen in the noisiest bins).
      ours.forEach((value, bin) => expect(Math.abs(value - row[bin]!), `frame ${frame} bin ${bin}`).toBeLessThan(1e-3));
    }
  });

  it("frames every 10 ms, rounding the sample count to the nearest frame (snip_edges false)", () => {
    expect(fbank(new Float32Array(0)).frames).toBe(0);
    expect(fbank(new Float32Array(79)).frames).toBe(0);
    expect(fbank(new Float32Array(80)).frames).toBe(1);
    expect(fbank(new Float32Array(16_000)).frames).toBe(100);
    expect(fbank(new Float32Array(16_079)).frames).toBe(100);
    expect(fbank(new Float32Array(16_080)).frames).toBe(101);
  });

  it("subtracts each bin's mean over the frames", () => {
    const features = subtractMean(fbank(syntheticSignal(8000)));
    for (const bin of [0, 40, 79]) {
      let sum = 0;
      for (let frame = 0; frame < features.frames; frame++) sum += features.data[frame * FBANK_BINS + bin]!;
      expect(Math.abs(sum / features.frames)).toBeLessThan(1e-4);
    }
  });
});
