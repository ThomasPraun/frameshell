import { afterEach, describe, expect, it } from "vitest";
import { spring } from "@frameshell/schema/motion";
import { beatAt, beatTime, beats, frameshellTiming, hasBeats, markers, sinceBeat, springOnBeat } from "../src/index.js";

const page = globalThis as Record<string, unknown>;

/** Timing as the host writes it for a 120 BPM clip that starts in the middle of the music: beats 3 to 10, bar 2 starts on beat 5. */
const TIMING = {
  beats: [3, 4, 5, 6, 7, 8, 9, 10].map((beat) => ({ at: 0.25 + (beat - 3) * 0.5, beat, ...(beat === 5 || beat === 9 ? { bar: beat === 5 ? 2 : 3 } : {}) })),
  tempo: { bpm: 120, meter: 4 },
  markers: [
    { at: 1, id: "m_1", label: "Hook" },
    { at: 2.5, id: "m_2", label: "hook " },
    { at: 3, id: "m_3", label: "Drop", color: "red" },
  ],
};

function withTiming(value: unknown): void {
  page["frameshellTiming"] = value;
}

afterEach(() => {
  delete page["frameshellTiming"];
  delete page["document"];
});

describe("the timeline's grid", () => {
  it("lists the clip's beats with their 0-based index", () => {
    withTiming(TIMING);
    expect(hasBeats()).toBe(true);
    const listed = beats({ bpm: 90 });
    expect(listed).toHaveLength(8);
    expect(listed[0]).toEqual({ at: 0.25, index: 0, beat: 3 });
    expect(listed[2]).toEqual({ at: 1.25, index: 2, beat: 5, bar: 2 });
    expect(frameshellTiming()).toBe(TIMING);
  });

  it("says where t is: index, beat number, bar and phase", () => {
    withTiming(TIMING);
    expect(beatAt(0.25)).toEqual({ index: 0, beat: 3, bar: 1, phase: 0 });
    const mid = beatAt(1.5);
    expect(mid).toMatchObject({ index: 2, beat: 5, bar: 2 });
    expect(mid.phase).toBeCloseTo(0.5, 9);
    expect(beatAt(2.2)).toMatchObject({ index: 3, beat: 6, bar: 2 });
    expect(beatAt(2.25)).toMatchObject({ index: 4, beat: 7, bar: 2 });
    expect(beatAt(3.75)).toMatchObject({ index: 7, beat: 10, bar: 3 });
  });

  it("continues at the nearest period before the first beat and after the last", () => {
    withTiming(TIMING);
    expect(beatTime(-2)).toBeCloseTo(-0.75, 9);
    expect(beatTime(9)).toBeCloseTo(4.75, 9);
    expect(beatAt(0)).toMatchObject({ index: -1, beat: 2, bar: 1 });
    expect(beatAt(0).phase).toBeCloseTo(0.5, 9);
    expect(beatAt(5)).toMatchObject({ index: 9, beat: 12, bar: 3 });
    expect(beatAt(-10).index).toBe(-21);
  });

  it("is null for the bar when no bar start is inside the clip", () => {
    withTiming({ beats: [{ at: 0.5, beat: 7 }, { at: 1, beat: 8 }], tempo: { bpm: 120, meter: 4 } });
    expect(beatAt(0.75)).toMatchObject({ index: 0, beat: 7, bar: null });
  });

  it("measures time since a beat and starts a spring on it", () => {
    withTiming(TIMING);
    expect(sinceBeat(1.5, 2)).toBeCloseTo(0.25, 9);
    expect(sinceBeat(1, 2)).toBeCloseTo(-0.25, 9);
    expect(springOnBeat("snappy", 1, 2)).toBe(0);
    expect(springOnBeat("snappy", 1.5, 2, 10, 20)).toBeCloseTo(spring("snappy", 0.25, 10, 20), 12);
    expect(springOnBeat("snappy", 1.5, 12)).toBe(0);
  });

  it("is a pure function of t: any order of calls gives the same answers", () => {
    withTiming(TIMING);
    const times = [3.1, 0.3, 1.77, 4.4, -0.2, 2.05];
    const first = times.map((t) => beatAt(t));
    const second = [...times].reverse().map((t) => beatAt(t)).reverse();
    expect(second).toEqual(first);
  });

  it("keeps the single beat of a clip counting at the tempo's period", () => {
    withTiming({ beats: [{ at: 1, beat: 9, bar: 3 }], tempo: { bpm: 120, meter: 4 } });
    expect(beatTime(2)).toBeCloseTo(2, 9);
    expect(beatAt(1.6)).toMatchObject({ index: 1, beat: 10, bar: 3 });
    expect(beatAt(2.2)).toMatchObject({ index: 2, beat: 11, bar: 3 });
  });
});

describe("the nominal fallback", () => {
  it("is the nominal grid when the page has no timing", () => {
    expect(hasBeats()).toBe(false);
    expect(frameshellTiming()).toBeNull();
    const nominal = { bpm: 120, offset: 0.25 };
    expect(beatTime(3, nominal)).toBeCloseTo(1.75, 9);
    expect(beatAt(1.5, nominal)).toMatchObject({ index: 2, beat: 3, bar: 1 });
    expect(beatAt(1.5, nominal).phase).toBeCloseTo(0.5, 9);
    expect(beatAt(2.3, { bpm: 120, meter: 2 })).toMatchObject({ index: 4, bar: 3 });
    expect(sinceBeat(2, 1, nominal)).toBeCloseTo(1.25, 9);
    expect(springOnBeat("default", 1.75, 3, 0, 1, nominal)).toBe(0);
  });

  it("is the clip's own seconds, one beat a second, with no nominal at all", () => {
    expect(beatTime(2)).toBe(2);
    expect(sinceBeat(2.5, 1)).toBe(1.5);
    expect(beatAt(5.5)).toMatchObject({ index: 5, beat: 6, bar: 2 });
  });

  it("ignores a nominal that is not a positive number", () => {
    expect(beatTime(1, { bpm: 0, meter: -3, offset: Number.NaN })).toBe(1);
    expect(beatAt(5, { meter: 0 }).bar).toBe(2);
  });

  it("is used when the grid has a problem or is empty, whatever the beats say", () => {
    for (const timing of [{ beats: [], beatsProblem: "no-tempo" }, { beats: TIMING.beats, beatsProblem: "low-confidence" }, { markers: TIMING.markers }, "text", null]) {
      withTiming(timing);
      expect(hasBeats()).toBe(false);
      expect(beatTime(1, { bpm: 120 })).toBe(0.5);
    }
  });

  it("lists a nominal grid up to the given duration or the root's data-duration, bars marked", () => {
    const listed = beats({ bpm: 120, offset: 0.25, duration: 2.5 });
    expect(listed.map((beat) => beat.at)).toEqual([0.25, 0.75, 1.25, 1.75, 2.25]);
    expect(listed[0]).toEqual({ at: 0.25, index: 0, beat: 1, bar: 1 });
    expect(listed[1]).toEqual({ at: 0.75, index: 1, beat: 2 });
    expect(beats({ bpm: 60, duration: 8 }).filter((beat) => beat.bar !== undefined).map((beat) => [beat.index, beat.bar])).toEqual([[0, 1], [4, 2], [8, 3]]);
    page["document"] = { querySelector: () => ({ getAttribute: (name: string) => ({ "data-width": "100", "data-height": "100", "data-duration": "2" })[name] ?? null }) };
    expect(beats({ bpm: 60 }).map((beat) => beat.at)).toEqual([0, 1, 2]);
    expect(() => beats()).not.toThrow();
  });

  it("needs a stage only for a nominal list without a duration", () => {
    expect(() => beats({ bpm: 60 })).toThrow(/stage\(\)/);
    expect(beats({ bpm: 60, duration: 1 })).toHaveLength(2);
  });
});

describe("markers", () => {
  it("lists the clip's markers, or those with one label (trimmed, any case)", () => {
    withTiming(TIMING);
    expect(markers().map((marker) => marker.id)).toEqual(["m_1", "m_2", "m_3"]);
    expect(markers("hook").map((marker) => marker.id)).toEqual(["m_1", "m_2"]);
    expect(markers("nothing")).toEqual([]);
  });

  it("is empty when the page has no markers timing", () => {
    expect(markers()).toEqual([]);
    withTiming({ beats: TIMING.beats });
    expect(markers("Hook")).toEqual([]);
  });
});
