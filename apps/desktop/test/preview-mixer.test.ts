import { describe, expect, it } from "vitest";
import { EDGE_FADE_SAMPLES, ProgramMixer, QUANTUM, QuantumClock } from "../src/renderer/src/preview/mixer.js";

// Seam under test: the program audio mixer the AudioWorklet runs (ADR 0001: own sample counter, 2 ms edge fades).

/** Render `quanta` quanta; `clock` is what the worklet's global `currentFrame` reports each time. */
function render(mixer: ProgramMixer, quanta: number, clock: (q: number) => number = (q) => q * QUANTUM): Float32Array {
  const out = new Float32Array(quanta * QUANTUM);
  for (let q = 0; q < quanta; q++) {
    const quantum = new Float32Array(QUANTUM);
    mixer.render(quantum, clock(q));
    out.set(quantum, q * QUANTUM);
  }
  return out;
}

const ones = (n: number) => new Float32Array(n).fill(1);

describe("ProgramMixer", () => {
  it("fades 2 ms in and out at a segment's edges, and plays it at exactly its frames", () => {
    expect(EDGE_FADE_SAMPLES).toBe(96);
    const mixer = new ProgramMixer();
    mixer.schedule({ at: 200, data: ones(400), fadeFrom: 200, fadeTo: 600 });
    const out = render(mixer, 6);
    expect(out[199]).toBe(0);
    expect(out[200]).toBe(0);
    expect(out[201]).toBeCloseTo(1 / 96, 6);
    expect(out[248]).toBeCloseTo(48 / 96, 6);
    expect(out[296]).toBe(1);
    expect(out[400]).toBe(1);
    expect(out[599 - 48]).toBeCloseTo(48 / 96, 6);
    expect(out[599]).toBe(0);
    expect(out[600]).toBe(0);
  });

  it("splits a segment across chunks without touching the samples at chunk joins", () => {
    const mixer = new ProgramMixer();
    mixer.schedule({ at: 0, data: ones(300), fadeFrom: 0, fadeTo: 1000 });
    mixer.schedule({ at: 300, data: ones(700), fadeFrom: 0, fadeTo: 1000 });
    const out = render(mixer, 8);
    expect(Array.from(out.subarray(96, 904)).every((v) => v === 1)).toBe(true);
  });

  it("keeps its own clock: a stale global currentFrame never repeats a quantum", () => {
    const mixer = new ProgramMixer();
    const ramp = Float32Array.from({ length: 1024 }, (_, i) => i / 1024);
    mixer.schedule({ at: 0, data: ramp, fadeFrom: -10_000, fadeTo: 10_000 });
    // Chromium reports one quantum behind now and then (ADR 0001); the fourth call here repeats frame 256.
    const out = render(mixer, 8, (q) => (q === 3 ? 256 : q * QUANTUM));
    expect(Array.from(out)).toEqual(Array.from(ramp));
  });

  it("follows currentFrame past quanta the graph skipped: never plays late", () => {
    const mixer = new ProgramMixer();
    const ramp = Float32Array.from({ length: 2048 }, (_, i) => i / 2048);
    mixer.schedule({ at: 0, data: ramp, fadeFrom: -10_000, fadeTo: 10_000 });
    // Chromium renders silence without calling process() while the graph lock is busy, and currentFrame still
    // advances: here quanta 1 and 2 never reach the worklet. Each later quantum must play its own frames.
    const clock = (q: number) => (q === 0 ? 0 : (q + 2) * QUANTUM);
    const out = render(mixer, 6, clock);
    expect(Array.from(out.subarray(0, QUANTUM))).toEqual(Array.from(ramp.subarray(0, QUANTUM)));
    for (let q = 1; q < 6; q++) {
      expect(Array.from(out.subarray(q * QUANTUM, (q + 1) * QUANTUM))).toEqual(Array.from(ramp.subarray(clock(q), clock(q) + QUANTUM)));
    }
    expect(mixer.position).toBe(clock(5) + QUANTUM);
  });

  it("mixes overlapping segments by summing them", () => {
    const mixer = new ProgramMixer();
    mixer.schedule({ at: 0, data: new Float32Array(512).fill(0.25), fadeFrom: -1000, fadeTo: 5000 });
    mixer.schedule({ at: 128, data: new Float32Array(128).fill(0.5), fadeFrom: -1000, fadeTo: 5000 });
    const out = render(mixer, 4);
    expect(out[127]).toBe(0.25);
    expect(out[128]).toBe(0.75);
    expect(out[256]).toBe(0.25);
  });

  it("stops with a 2 ms fade-out in the next quantum and drops everything scheduled", () => {
    const mixer = new ProgramMixer();
    mixer.schedule({ at: 0, data: ones(48_000), fadeFrom: -1000, fadeTo: 100_000 });
    render(mixer, 2);
    mixer.stop();
    const out = render(mixer, 3, (q) => (q + 2) * QUANTUM);
    expect(out[0]).toBeCloseTo(95 / 96, 6);
    expect(out[47]).toBeCloseTo(48 / 96, 6);
    expect(out[95]).toBe(0);
    expect(Array.from(out.subarray(96)).every((v) => v === 0)).toBe(true);
    expect(mixer.pending).toBe(0);
  });

  it("cuts at a future frame: fades out into it and plays chunks scheduled from it", () => {
    const mixer = new ProgramMixer();
    mixer.schedule({ at: 0, data: ones(2048), fadeFrom: -1000, fadeTo: 100_000 });
    mixer.cut(1000);
    mixer.schedule({ at: 1000, data: new Float32Array(1048).fill(0.5), fadeFrom: 1000, fadeTo: 100_000 });
    const out = render(mixer, 16);
    expect(out[903]).toBe(1);
    expect(out[999 - 48]).toBeCloseTo(48 / 96, 6);
    expect(out[999]).toBe(0);
    expect(out[1000]).toBe(0);
    expect(out[1000 + 96]).toBe(0.5);
    expect(out[1500]).toBe(0.5);
  });

  it("reports its position so the page can anchor the program clock", () => {
    const mixer = new ProgramMixer();
    render(mixer, 3, (q) => 1280 + q * QUANTUM);
    expect(mixer.position).toBe(1280 + 3 * QUANTUM);
  });
});

describe("QuantumClock", () => {
  it("counts quanta over a stale currentFrame and catches up with one that ran ahead", () => {
    const clock = new QuantumClock();
    expect(clock.next).toBe(-1);
    // Seeded from the first reading; 256 stale (repeat of the last quantum); 1024 after skipped quanta.
    const frames = [128, 256, 256, 1024, 1152].map((currentFrame) => clock.tick(currentFrame));
    expect(frames).toEqual([128, 256, 384, 1024, 1152]);
    expect(clock.next).toBe(1280);
  });
});
