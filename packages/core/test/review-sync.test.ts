import { describe, expect, it } from "vitest";
import { type Onset, type SyncInput, syncMetrics, syncWarnings } from "../src/review/sync.js";

// Sync of sounds to picture events (#457): offsets, early and late limits, the chance baseline, and what is left over.

function input(sounds: Onset[], events: number[], extra: Partial<SyncInput> = {}): SyncInput {
  return { source: "takes", sounds, events, cuts: [], range: { from: 0, to: 20 }, spacing: 0, ...extra };
}

const click = (at: number): Onset => ({ at, kind: "click" });

describe("review sync", () => {
  it("reports each sound's offset to the nearest visual event: positive = the sound is late", () => {
    const sync = syncMetrics(input([click(1.02), click(3.0), click(5.2)], [1, 3, 5.1]))!;
    expect(sync.offsets).toEqual([
      { at: 1.02, kind: "click", picture: 1, offset: 0.02, verdict: "on" },
      { at: 3, kind: "click", picture: 3, offset: 0, verdict: "on" },
      { at: 5.2, kind: "click", picture: 5.1, offset: 0.1, verdict: "late" },
    ]);
    expect(sync.hits).toBe(2);
  });

  it("a sound over 45 ms before its picture reads early, one over 75 ms after it late; between is on", () => {
    const early = syncMetrics(input([click(0.94)], [1]))!;
    expect(early.offsets[0]).toMatchObject({ offset: -0.06, verdict: "early" });
    const late = syncMetrics(input([click(1.08)], [1]))!;
    expect(late.offsets[0]).toMatchObject({ offset: 0.08, verdict: "late" });
    expect(syncMetrics(input([click(1.07)], [1]))!.offsets[0]!.verdict).toBe("on");
    expect(syncMetrics(input([click(0.96)], [1]))!.offsets[0]!.verdict).toBe("on");
  });

  it("a sound with no picture event within 0.12 s is listed with verdict none", () => {
    const sync = syncMetrics(input([click(10)], [1, 3]))!;
    expect(sync.offsets).toEqual([{ at: 10, kind: "click", picture: null, offset: null, verdict: "none" }]);
    expect(sync.hits).toBe(0);
  });

  it("the sample spacing widens the limits: an offset under half a sample cannot be told", () => {
    // Events found between samples 0.2 s apart are good to 0.1 s.
    const sync = syncMetrics(input([click(1.09)], [1], { spacing: 0.2 }))!;
    expect(sync.offsets[0]!.verdict).toBe("on");
    expect(sync.spacing).toBe(0.2);
  });

  it("whooshes, risers and ticks are counted as excluded and never scored", () => {
    const sync = syncMetrics(input([{ at: 2, kind: "whoosh" }, { at: 4, kind: "riser" }, { at: 6, kind: "tick" }, click(8)], [8]))!;
    expect(sync.sounds).toBe(1);
    expect(sync.excluded).toBe(3);
    expect(sync.offsets.map((entry) => entry.kind)).toEqual(["click"]);
  });

  it("returns null when the range holds no sound, and ignores sounds outside it", () => {
    expect(syncMetrics(input([], [1]))).toBeNull();
    expect(syncMetrics(input([click(30)], [1]))).toBeNull();
    expect(syncMetrics(input([click(1), click(30)], [1]))!.sounds).toBe(1);
  });

  it("the chance baseline moves the same sounds by fixed offsets: sounds on every event beat it, sounds on a dense picture do not", () => {
    // Events every 4 s, sounds on them: shifted by 0.3 s or more none is near an event.
    const events = [2, 6, 10, 14, 18];
    const placed = syncMetrics(input(events.map(click), events))!;
    expect(placed.near).toBe(1);
    expect(placed.chance).toBe(0);
    // A picture that changes every 0.15 s has an event near everything, so being near one proves nothing.
    const busy = Array.from({ length: 130 }, (_, i) => 0.1 + i * 0.15);
    const crowded = syncMetrics(input([2, 6, 10, 14, 18].map(click), busy))!;
    expect(crowded.near).toBe(1);
    expect(crowded.chance!).toBeGreaterThan(0.8);
    expect(syncWarnings(crowded).map((warning) => warning.message).join()).toContain("random placement");
    expect(syncWarnings(placed)).toEqual([]);
  });

  it("lists cuts with no sound within 0.12 s, inside the range only", () => {
    const sync = syncMetrics(input([click(2.05), click(9)], [2, 9], { cuts: [0, 2, 5, 9.1, 40], source: "takes" }))!;
    expect(sync.silentCuts).toEqual([5]);
  });

  it("warns once per direction with the sounds that are early or late, and not for a few sounds against chance", () => {
    const sync = syncMetrics(input([click(0.9), click(3.1), click(5.11)], [1, 3, 5]))!;
    const warnings = syncWarnings(sync);
    expect(warnings.map((warning) => warning.check)).toEqual(["sync", "sync"]);
    expect(warnings[0]!.message).toMatch(/1 sound lands more than 45 ms before/);
    expect(warnings[1]!.message).toMatch(/2 sounds land more than 75 ms after/);
    // Three sounds are too few to judge against chance.
    expect(warnings.some((warning) => warning.message.includes("random placement"))).toBe(false);
  });
});
