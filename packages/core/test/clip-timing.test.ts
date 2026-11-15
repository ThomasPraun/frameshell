import { describe, expect, it } from "vitest";
import { RENDER_BEATS_PROBLEMS } from "@frameshell/plugin-api";
import type { AdapterClip, BeatsFile, Timeline } from "@frameshell/schema";
import { type ClipKeyInput, type ClipTimingInput, clipCacheKey, clipTiming } from "../src/index.js";

// Timing of generated clips (ADR 0029 decision 8): the beats and markers inside a clip, in composition seconds, and
// only for clips that ask, so the render key of every other clip stays as it was.
const FPS = 30;
const beatsFile = (overrides: Partial<BeatsFile> = {}): BeatsFile => ({
  schemaVersion: 1,
  asset: "assets/music.wav",
  assetHash: `sha256:${"0".repeat(64)}`,
  detector: "exact",
  bpm: 120,
  meter: 4,
  downbeat: 0,
  confidence: 1,
  beats: Array.from({ length: 40 }, (_, index) => 0.5 + index * 0.5),
  edits: {},
  ...overrides,
});

const card: AdapterClip = { id: "c_card", type: "hyperframes", source: "compositions/hyperframes/drop/index.html", start: 4, in: 1, duration: 2 };

/** A timeline with the music clip `music` (starting at `start`, from source second `in`) followed by the tempo. */
function timeline(music: { start: number; in?: number } | null, extra: Partial<Timeline> = {}): Timeline {
  return {
    schemaVersion: 1,
    id: "main",
    revision: 1,
    tracks: [
      { id: "t_v", kind: "video", clips: [card] },
      {
        id: "t_a",
        kind: "audio",
        clips: music ? [{ id: "c_music", type: "media", asset: "assets/music.wav", start: music.start, in: music.in ?? 0, out: 20 }] : [],
      },
    ],
    ...(music ? { tempo: { clip: "c_music" } } : {}),
    ...extra,
  } as Timeline;
}

const input = (over: Partial<ClipTimingInput> = {}): ClipTimingInput => ({
  clip: card,
  timeline: timeline({ start: 0 }),
  fps: FPS,
  kinds: ["beats"],
  beatsOf: async () => beatsFile(),
  ...over,
});

describe("clipTiming", () => {
  it("is undefined for a clip that asks for nothing, or only for kinds it does not know", async () => {
    expect(await clipTiming(input({ kinds: [] }))).toBeUndefined();
    expect(await clipTiming(input({ kinds: ["bars", "words"] }))).toBeUndefined();
  });

  it("lists the beats inside the clip in composition seconds, numbered as beat:N and bar:N name them", async () => {
    // The clip shows timeline 4..6 s as composition 1..3 s; the music starts at 0, so beats 4.0, 4.5, 5.0, 5.5 s.
    expect(await clipTiming(input())).toEqual({
      beats: [
        { at: 1, beat: 8 },
        { at: 1.5, beat: 9, bar: 3 },
        { at: 2, beat: 10 },
        { at: 2.5, beat: 11 },
      ],
      tempo: { bpm: 120, meter: 4 },
    });
  });

  it("follows the music: moving it moves the beats, and a head trim keeps their numbers", async () => {
    const moved = await clipTiming(input({ timeline: timeline({ start: 0.2 }) }));
    expect(moved?.beats?.map((beat) => beat.at)).toEqual([1.2, 1.7, 2.2, 2.7]);
    // The music clip starts 2 s into the song at timeline 0: the clip now hears the song's 6..8 s.
    const trimmed = await clipTiming(input({ timeline: timeline({ start: 0, in: 2 }) }));
    expect(trimmed?.beats?.[0]).toEqual({ at: 1, beat: 12 });
  });

  it("lists the markers inside the clip, sorted, with their colours", async () => {
    const markers = [
      { id: "m_c", at: 5.5, label: "drop", color: "red" as const },
      { id: "m_a", at: 3.9, label: "before" },
      { id: "m_b", at: 4, label: "hook" },
      { id: "m_d", at: 6, label: "after" },
    ];
    expect(await clipTiming(input({ kinds: ["markers"], timeline: timeline(null, { markers }) }))).toEqual({
      markers: [
        { at: 1, id: "m_b", label: "hook" },
        { at: 2.5, id: "m_c", label: "drop", color: "red" },
      ],
    });
  });

  it("gives no beats, saying why as a stable code, when the grid is missing, broken or LOW confidence", async () => {
    expect(await clipTiming(input({ timeline: timeline(null) }))).toEqual({ beats: [], beatsProblem: "no-tempo" });
    expect(await clipTiming(input({ beatsOf: async () => null }))).toEqual({ beats: [], beatsProblem: "no-beats" });
    const gone = timeline({ start: 0 }, { tempo: { clip: "c_gone" } });
    expect(await clipTiming(input({ timeline: gone }))).toEqual({ beats: [], beatsProblem: "no-music-clip" });
    const brokenBy = (message: string) =>
      clipTiming(
        input({
          beatsOf: async () => {
            throw new Error(message);
          },
        }),
      );
    expect(await brokenBy("beats/music.beats.json is not valid: beats[3]")).toEqual({ beats: [], beatsProblem: "broken-beats" });
    expect(await brokenBy("beats/music.beats.json is not valid: bpm")).toEqual({ beats: [], beatsProblem: "broken-beats" });
    const low = await clipTiming(input({ beatsOf: async () => beatsFile({ detector: "onset-flux@1", confidence: 0.3 }) }));
    expect(low).toEqual({ beats: [], beatsProblem: "low-confidence" });
    // The code, not the words: another LOW confidence or another asset is the same timing, so the same key.
    const lower = await clipTiming(input({ beatsOf: async () => beatsFile({ asset: "assets/other.wav", detector: "onset-flux@1", confidence: 0.2 }) }));
    expect(lower).toEqual(low);
  });

  it("words every problem code for a composition that shows it", () => {
    for (const code of ["no-tempo", "no-music-clip", "no-beats", "broken-beats", "low-confidence"] as const) {
      expect(RENDER_BEATS_PROBLEMS[code]).toMatch(/\.$/);
    }
  });

  it("reads a nominal grid on the timeline clock too", async () => {
    const nominal = await clipTiming(input({ timeline: timeline(null, { tempo: { bpm: 60, offset: 0.5 } }) }));
    expect(nominal?.beats).toEqual([
      { at: 1.5, beat: 5, bar: 2 },
      { at: 2.5, beat: 6 },
    ]);
  });
});

describe("render keys with timing", () => {
  const base: ClipKeyInput = {
    plugin: { name: "@frameshell/hyperframes", version: "0.1.0" },
    clip: card,
    inputs: [{ path: card.source!, hash: "sha256:aaa" }],
    format: { fps: FPS, width: 1920, height: 1080 },
  };
  const keyFor = async (over: Partial<ClipTimingInput>) => {
    const timing = await clipTiming(input(over));
    return clipCacheKey({ ...base, ...(timing ? { timing } : {}) });
  };

  it("stays the same for a clip that does not ask, wherever the music and the markers go", async () => {
    const plain = clipCacheKey(base);
    expect(await keyFor({ kinds: [] })).toBe(plain);
    expect(await keyFor({ kinds: [], timeline: timeline({ start: 0.25 }, { markers: [{ id: "m_a", at: 5, label: "hook" }] }) })).toBe(plain);
  });

  it("changes for a clip that asks when the beats move, and only then", async () => {
    const asked = await keyFor({});
    expect(asked).not.toBe(clipCacheKey(base));
    expect(await keyFor({})).toBe(asked);
    expect(await keyFor({ timeline: timeline({ start: 0.25 }) })).not.toBe(asked);
    // A marker the clip did not ask for leaves its key alone.
    expect(await keyFor({ timeline: timeline({ start: 0 }, { markers: [{ id: "m_a", at: 5, label: "hook" }] }) })).toBe(asked);
    expect(await keyFor({ kinds: ["beats", "markers"], timeline: timeline({ start: 0 }, { markers: [{ id: "m_a", at: 5, label: "hook" }] }) })).not.toBe(asked);
  });

  it("without a usable grid, changes only when the reason does, never with the words of a refusal", async () => {
    const broken = (message: string) => keyFor({ beatsOf: async () => Promise.reject(new Error(message)) });
    const unreadable = await broken("beats/music.beats.json is not valid: beats[3]");
    expect(await broken("beats/music.beats.json is not valid: bpm: expected a number")).toBe(unreadable);
    const low = await keyFor({ beatsOf: async () => beatsFile({ detector: "onset-flux@1", confidence: 0.3 }) });
    expect(await keyFor({ beatsOf: async () => beatsFile({ asset: "assets/b.wav", detector: "onset-flux@1", confidence: 0.25 }) })).toBe(low);
    expect(new Set([unreadable, low, await keyFor({ beatsOf: async () => null }), await keyFor({ timeline: timeline(null) })]).size).toBe(4);
  });
});
