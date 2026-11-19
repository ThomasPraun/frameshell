import { describe, expect, it } from "vitest";
import { MUSIC_PRESET_DEFAULTS, type MusicPreset } from "@frameshell/schema";
import { detectBeats, onsetEnvelope, prepareSignal } from "../src/media/beats.js";
import { defaultSections, musicGrid, synthesizeMusic } from "../src/sound/music.js";

// Seam under test: detectBeats on `sound.music` takes, whose beats are known exactly. A small in-process slice of
// the real-music corpus (spikes/beats-real-music): each case failed on onset-flux@1 (late kick refinement, drift with
// vinyl clicks and swing, a dotted-quarter tempo). Takes of 8 bars hold too few beats to tell some of these apart.

function measure(preset: MusicPreset, bpm: number, bars = 12) {
  const spec = { preset, bpm, meter: 4, sections: defaultSections(bars), chords: MUSIC_PRESET_DEFAULTS[preset].chords, seed: 7, accents: [] };
  const take = synthesizeMusic(spec);
  const [left, right] = take.channels;
  const mono = new Float32Array(left!.length);
  for (let i = 0; i < mono.length; i++) mono[i] = (left![i]! + right![i]!) / 2 / 8_388_608;
  const signal = prepareSignal(mono, take.sampleRate);
  return { found: detectBeats(signal, onsetEnvelope(signal), { sourceRate: take.sampleRate }), truth: musicGrid(spec).beats };
}

/** Signed gaps (detected minus true, seconds) of every detected beat to its nearest true beat. */
function gaps(beats: number[], truth: number[]): number[] {
  return beats.map((time) => truth.reduce((best, beat) => (Math.abs(beat - time) < Math.abs(best) ? beat - time : best), Infinity)).map((gap) => -gap);
}

const quantile = (values: number[], q: number) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(q * values.length))]!;

function expectOnTheBeats(beats: number[], truth: number[]): void {
  const signed = gaps(beats, truth);
  expect(quantile(signed.map(Math.abs), 0.95)).toBeLessThan(0.015);
  expect(Math.abs(quantile(signed, 0.5))).toBeLessThan(0.005);
  const third = Math.floor(signed.length / 3);
  expect(Math.abs(quantile(signed.slice(-third), 0.5) - quantile(signed.slice(0, third), 0.5))).toBeLessThan(0.01);
}

// Synthesis takes most of each test, about 8 s here: room for a slow CI runner.
const SLOW = 90_000;

describe("detectBeats on generated music", () => {
  it("puts the beats of a synthwave take with a sub-bass kick on the kicks, not a cycle late", () => {
    const { found, truth } = measure("synthwave", 118);
    expect(found.bpm).toBeCloseTo(118, 0);
    expectOnTheBeats(found.beats, truth);
  }, SLOW);

  it("does not drift on a swung lofi take with vinyl clicks", () => {
    const { found, truth } = measure("lofi", 85);
    expect(Math.abs(found.bpm / 85 - 1)).toBeLessThan(0.002);
    expectOnTheBeats(found.beats, truth);
  }, SLOW);

  it("reads a minimal take at its tempo, not the dotted-quarter pulse 2/3 of it", () => {
    const { found, truth } = measure("minimal", 150, 16);
    expect(Math.abs(found.bpm / 150 - 1)).toBeLessThan(0.01);
    expectOnTheBeats(found.beats, truth);
  }, SLOW);
});
