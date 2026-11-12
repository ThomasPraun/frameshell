import { describe, expect, it } from "vitest";
import { BEATS_SCHEMA_URL, effectiveBeatGrid, isLowConfidence, nominalBeatFrame, parseBeatsFile } from "../src/index.js";

const hash = `sha256:${"ab".repeat(32)}`;
const eight = [0.2, 0.7, 1.2, 1.7, 2.2, 2.7, 3.2, 3.7];
const measured = {
  schemaVersion: 1,
  asset: "assets/music/theme.mp3",
  assetHash: hash,
  detector: "onset-flux@1",
  sampleRate: 48_000,
  bpm: 120,
  confidence: 0.93,
  residualMs: 4.2,
  beats: eight,
};

describe("beats file (beats/*.beats.json)", () => {
  it("accepts a measured grid and fills meter, downbeat and edits", () => {
    const parsed = parseBeatsFile(measured);
    expect(parsed).toMatchObject({ ok: true, value: { meter: 4, downbeat: 0, edits: {}, bpm: 120 } });
    expect(BEATS_SCHEMA_URL).toBe("https://frameshell.dev/schema/v1/beats.json");
  });

  it("admits the detector `exact` for a grid a generator wrote, without measurement facts", () => {
    const exact = { schemaVersion: 1, asset: "assets/music/gen.wav", assetHash: hash, detector: "exact", bpm: 100, confidence: 1, beats: [0, 0.6, 1.2] };
    expect(parseBeatsFile(exact).ok).toBe(true);
    expect(parseBeatsFile({ ...exact, detector: "guess" }).ok).toBe(false);
    expect(parseBeatsFile({ ...exact, detector: "Onset Flux" }).ok).toBe(false);
  });

  it("rejects unordered beats, a downbeat outside the bar, a bad hash and unknown keys", () => {
    expect(parseBeatsFile({ ...measured, beats: [0.2, 0.2, 0.7] })).toMatchObject({ ok: false, error: expect.stringContaining("strictly increasing") });
    expect(parseBeatsFile({ ...measured, downbeat: 4 })).toMatchObject({ ok: false, error: expect.stringContaining("below meter") });
    expect(parseBeatsFile({ ...measured, onsets: [1, 0.5] })).toMatchObject({ ok: false, error: expect.stringContaining("onsets must be increasing") });
    expect(parseBeatsFile({ ...measured, assetHash: "abc" }).ok).toBe(false);
    expect(parseBeatsFile({ ...measured, beats: [1] }).ok).toBe(false);
    expect(parseBeatsFile({ ...measured, tempo: 120 }).ok).toBe(false);
    expect(parseBeatsFile({ ...measured, edits: { tempo: "triple" } }).ok).toBe(false);
  });
});

describe("effectiveBeatGrid", () => {
  const grid = (edits: object, extra: object = {}) => {
    const parsed = parseBeatsFile({ ...measured, ...extra, edits });
    if (!parsed.ok) throw new Error(parsed.error);
    return effectiveBeatGrid(parsed.value);
  };

  it("is the measured grid when nobody edited it, with bar starts every `meter` beats from the downbeat", () => {
    const plain = grid({}, { downbeat: 1 });
    expect(plain).toMatchObject({ bpm: 120, meter: 4, downbeat: 1, beats: eight, downbeats: [0.7, 2.7] });
  });

  it("doubles by adding midpoints, none after the last beat, and halves by keeping every other beat", () => {
    const doubled = grid({ tempo: "double" });
    expect(doubled.bpm).toBe(240);
    expect(doubled.beats).toEqual([0.2, 0.45, 0.7, 0.95, 1.2, 1.45, 1.7, 1.95, 2.2, 2.45, 2.7, 2.95, 3.2, 3.45, 3.7]);
    const halved = grid({ tempo: "half" });
    expect(halved.bpm).toBe(60);
    expect(halved.beats).toEqual([0.2, 1.2, 2.2, 3.2]);
    // The measured bar start moves with its beat: beat 2 of the measured grid is beat 1 of the halved one.
    expect(grid({ tempo: "half" }, { downbeat: 2 }).downbeat).toBe(1);
    expect(grid({ tempo: "double" }, { downbeat: 2 }).downbeat).toBe(4);
  });

  it("applies the offset, then a hand-set downbeat on the effective beats", () => {
    const nudged = grid({ offset: -0.25, downbeat: 3 });
    // The beat that would land before 0 is dropped.
    expect(nudged.beats).toEqual([0.45, 0.95, 1.45, 1.95, 2.45, 2.95, 3.45]);
    expect(nudged.downbeat).toBe(3);
    expect(nudged.downbeats).toEqual([nudged.beats[3]!]);
  });
});

describe("isLowConfidence", () => {
  it("is low under 0.5 until a human edit vouches for the grid", () => {
    expect(isLowConfidence({ confidence: 0.35, edits: {} })).toBe(true);
    expect(isLowConfidence({ confidence: 0.35, edits: { tempo: "half" } })).toBe(false);
    expect(isLowConfidence({ confidence: 0.5, edits: {} })).toBe(false);
  });
});

describe("nominalBeatFrame", () => {
  it("rounds each beat once from its index: no drift at 128 BPM and 30 fps", () => {
    const frames = Array.from({ length: 33 }, (_, index) => nominalBeatFrame(index, 128, 30));
    // 30 * 60 / 128 = 14.0625 frames a beat: adding the rounded step (14) would put beat 32 on frame 448, two early.
    expect(frames[32]).toBe(450);
    const accumulated = 32 * Math.round((30 * 60) / 128);
    expect(frames[32]! - accumulated).toBe(2);
    frames.forEach((frame, index) => expect(Math.abs(frame - (index * 30 * 60) / 128)).toBeLessThanOrEqual(0.5));
    expect(frames.slice(0, 5)).toEqual([0, 14, 28, 42, 56]);
  });

  it("starts at the offset", () => {
    expect(nominalBeatFrame(0, 120, 30, 1.5)).toBe(45);
    expect(nominalBeatFrame(4, 120, 30, 1.5)).toBe(105);
  });
});
