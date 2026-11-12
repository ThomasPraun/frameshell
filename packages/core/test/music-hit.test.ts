import { describe, expect, it } from "vitest";
import { energyEnvelope } from "../src/media/energy.js";
import { finalHit } from "../src/music/hit.js";
import { type MusicHit, kicks, music, toInt16 } from "./music-fixture.js";

// `finalHit` on synthetic music: a quiet bed, kicks every half second, and an ending built per case.
const RATE = 16_000;
const envelope = (seconds: number, hits: MusicHit[], bed?: number) => energyEnvelope(toInt16(music(seconds, hits, { rate: RATE, ...(bed === undefined ? {} : { bed }) })), RATE);

describe("finalHit", () => {
  it("finds the crash that ends the track, to within a hop, with high confidence", () => {
    const db = envelope(26, [...kicks(19.5), { at: 20.345, amplitude: 0.9, decay: 2.5 }]);
    const found = finalHit(db, { from: 0, to: 26 })!;
    expect(found.at).toBeGreaterThan(20.32);
    expect(found.at).toBeLessThan(20.36);
    expect(found.rise).toBeGreaterThan(12);
    expect(found.confidence).toBeGreaterThanOrEqual(0.8);
    expect(found.candidates.at(-1)!.at).toBe(found.at);
    expect(found.candidates.length).toBeGreaterThan(1);
  });

  it("trusts a track that stops on its last hit", () => {
    const db = envelope(20.4, [...kicks(19.5), { at: 20, amplitude: 0.9, decay: 0.4 }]);
    const found = finalHit(db, { from: 0, to: 20.4 })!;
    expect(found.at).toBeGreaterThan(19.98);
    expect(found.at).toBeLessThan(20.02);
    expect(found.confidence).toBeGreaterThan(0.5);
  });

  it("looks only at the part the clip plays", () => {
    const db = envelope(26, [...kicks(19.5), { at: 20.345, amplitude: 0.9, decay: 2.5 }]);
    const found = finalHit(db, { from: 0, to: 15 })!;
    expect(found.at).toBeLessThanOrEqual(15);
    expect(found.at).toBeGreaterThan(14);
  });

  it("doubts the last accent of a track that fades out", () => {
    // Kicks that grow quieter for 20 s: no final accent stands out.
    const fading = Array.from({ length: 40 }, (_, i): MusicHit => ({ at: 0.5 * (i + 1), amplitude: 0.5 * 0.9 ** i, decay: 0.2 }));
    const found = finalHit(envelope(24, fading), { from: 0, to: 24 });
    expect(found === null || found.confidence < 0.5).toBe(true);
  });

  it("places the hit on a measured onset within 40 ms, and ignores one farther", () => {
    const db = envelope(26, [...kicks(19.5), { at: 20.345, amplitude: 0.9, decay: 2.5 }]);
    expect(finalHit(db, { from: 0, to: 26 }, [3, 20.341, 25])!.at).toBe(20.341);
    const far = finalHit(db, { from: 0, to: 26 }, [20.5])!;
    expect(far.at).not.toBe(20.5);
  });

  it("finds nothing in silence, in a steady tone, or in under a third of a second", () => {
    expect(finalHit(envelope(10, [], 0), { from: 0, to: 10 })).toBeNull();
    expect(finalHit(envelope(10, [], 0.2), { from: 0, to: 10 })).toBeNull();
    expect(finalHit(envelope(10, [{ at: 0.1, amplitude: 0.9, decay: 0.2 }]), { from: 0, to: 0.2 })).toBeNull();
  });
});
