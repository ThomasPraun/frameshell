import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RENDER_BEATS_PROBLEMS, RENDER_WORDS_PROBLEMS } from "@frameshell/plugin-api";
import { type AdapterClip, type BeatsFile, type Timeline, type Transcript, flattenTimeline } from "@frameshell/schema";
import { type ClipKeyInput, type ClipTimingInput, clipCacheKey, clipTiming } from "../src/index.js";
import { readTimelineWords } from "../src/transcripts/timeline-words.js";
import { tempDir } from "./helpers.js";

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
    expect(await clipTiming(input({ kinds: ["bars", "tempo"] }))).toBeUndefined();
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

// Words (ADR 0029 "Words in timing as built"): the transcript words the timeline plays, as `word:` references read
// them (`readTimelineWords`), that start inside the clip.
describe("clipTiming words", () => {
  const HASH = `sha256:${"1".repeat(64)}`;
  const SAID: [string, number, number][] = [
    ["so", 1, 1.4],
    ["here", 3.5, 3.9],
    ["is", 4, 4.2],
    ["the", 4.5, 4.7],
    ["hook", 5.5, 6.1],
    ["after", 6, 6.4],
  ];
  const transcript = (edits: Transcript["edits"] = {}): Transcript => ({
    schemaVersion: 1,
    asset: "assets/talk.mp4",
    assetHash: HASH,
    provider: "test",
    model: "test",
    language: "en",
    words: SAID.map(([text, start, end], index) => ({ id: `w_${String(index + 1).padStart(6, "0")}`, text, start, end })),
    edits,
  });
  /** A project holding the talk's transcript; `hash` is the asset's current hash (another one makes it stale). */
  const project = (edits: Transcript["edits"] = {}) => {
    const root = tempDir();
    mkdirSync(join(root, "transcripts"), { recursive: true });
    writeFileSync(join(root, "transcripts", "talk.words.json"), JSON.stringify(transcript(edits)));
    return root;
  };
  const talk = (extra: Record<string, unknown> = {}) => ({ id: "c_talk", type: "media", asset: "assets/talk.mp4", start: 0, in: 0, out: 10, ...extra });
  const on = (clips: unknown[], extra: Partial<Timeline> = {}): Timeline =>
    ({ schemaVersion: 1, id: "main", revision: 1, tracks: [{ id: "t_v", kind: "video", clips: [card] }, { id: "t_a", kind: "audio", clips }], ...extra }) as Timeline;
  const wordsIn = (root: string, timeline: Timeline, over: Partial<ClipTimingInput> = {}, hash: string | null = HASH) =>
    clipTiming(
      input({
        kinds: ["words"],
        timeline,
        wordsOf: () => readTimelineWords(root, timeline, FPS, async () => hash),
        ...over,
      }),
    );

  it("lists the words that start inside the clip, in composition seconds, with their ids", async () => {
    // The card shows timeline 4..6 s as composition 1..3 s: "is", "the" and "hook" start inside; "after" ends past it.
    expect(await wordsIn(project(), on([talk()]))).toEqual({
      words: [
        { at: 1, end: 1.2, text: "is", id: "w_000003" },
        { at: 1.5, end: 1.7, text: "the", id: "w_000004" },
        { at: 2.5, end: 3.1, text: "hook", id: "w_000005" },
      ],
    });
  });

  it("follows the footage: a trim, a move or a speed change of the talk moves the words; a trim of the card shifts them", async () => {
    const root = project();
    // The talk starts 0.5 s later: "here" (3.5 s in the file) now starts at timeline 4 s.
    const moved = await wordsIn(root, on([talk({ start: 0.5 })]));
    expect(moved?.words?.map((word) => [word.text, word.at])).toEqual([
      ["here", 1],
      ["is", 1.5],
      ["the", 2],
    ]);
    // At double speed file second 8..12 plays at timeline 4..6: no word is said there.
    expect(await wordsIn(root, on([talk({ out: 20, speed: 2 })]))).toEqual({ words: [] });
    const fast = await wordsIn(root, on([talk({ start: 3, speed: 2 })]));
    // Timeline second = 3 + file second / 2: "here" at 4.75, "is" at 5, "the" at 5.25, "hook" at 5.75, "after" at 6.
    expect(fast?.words?.map((word) => [word.text, word.at])).toEqual([
      ["here", 1.75],
      ["is", 2],
      ["the", 2.25],
      ["hook", 2.75],
    ]);
    // A head trim of the card (in 1.5 instead of 1): the same timeline words, half a second later in the composition.
    const trimmed = await wordsIn(root, on([talk()]), { clip: { ...card, in: 1.5 } });
    expect(trimmed?.words?.map((word) => word.at)).toEqual([1.5, 2, 3]);
  });

  it("carries the text as the person corrected it", async () => {
    const corrected = await wordsIn(project({ w_000005: { text: "Hook!" } }), on([talk()]));
    expect(corrected?.words?.find((word) => word.id === "w_000005")?.text).toBe("Hook!");
  });

  it("gives no words and a stable code for a stale transcript or a timeline with no transcribed word, never an error", async () => {
    const root = project();
    expect(await wordsIn(root, on([talk()]), {}, `sha256:${"2".repeat(64)}`)).toEqual({ words: [], wordsProblem: "stale-transcript" });
    expect(await wordsIn(tempDir(), on([talk()]))).toEqual({ words: [], wordsProblem: "no-transcript" });
    expect(await wordsIn(root, on([]))).toEqual({ words: [], wordsProblem: "no-transcript" });
    expect(await clipTiming(input({ kinds: ["words"] }))).toEqual({ words: [], wordsProblem: "no-transcript" });
    // Speech elsewhere on the timeline: nothing said during the card is no problem.
    expect(await wordsIn(root, on([talk({ out: 2 })]))).toEqual({ words: [] });
    for (const code of ["no-transcript", "stale-transcript"] as const) expect(RENDER_WORDS_PROBLEMS[code]).toMatch(/\.$/);
  });

  it("reads words only when the clip asks for them", async () => {
    let reads = 0;
    const counting = () => {
      reads++;
      return Promise.resolve({ words: [], unchecked: [] });
    };
    await clipTiming(input({ kinds: ["beats", "markers"], wordsOf: counting }));
    expect(reads).toBe(0);
    await clipTiming(input({ kinds: ["words"], wordsOf: counting }));
    expect(reads).toBe(1);
  });

  it("hears the host's words for a clip inside a nested timeline, keyed in the flattened timeline", async () => {
    const inner = { schemaVersion: 1, id: "inner", revision: 0, tracks: [{ id: "t_in", kind: "video", clips: [{ ...card, id: "c_inner", start: 0.5, in: 0 }] }] } as Timeline;
    const host = {
      schemaVersion: 1,
      id: "main",
      revision: 1,
      tracks: [
        { id: "t_v", kind: "video", clips: [{ id: "c_nest", type: "timeline", source: "timelines/inner.json", start: 3.5, duration: 3 }] },
        { id: "t_a", kind: "audio", clips: [talk()] },
      ],
    } as Timeline;
    const flat = flattenTimeline(host, (source) => (source === "timelines/inner.json" ? inner : null));
    const nested = flat.tracks.flatMap((track): readonly { id: string }[] => ("clips" in track ? track.clips : [])).find((clip) => clip.id === "c_nest/c_inner") as AdapterClip;
    // The inner card plays at timeline 4..6 s from composition 0: "is", "the", "hook".
    const heard = await wordsIn(project(), flat, { clip: nested });
    expect(heard?.words?.map((word) => [word.text, word.at])).toEqual([
      ["is", 0],
      ["the", 0.5],
      ["hook", 1.5],
    ]);
  });
});

describe("render keys with words", () => {
  const base: ClipKeyInput = {
    plugin: { name: "@frameshell/hyperframes", version: "0.1.0" },
    clip: card,
    inputs: [{ path: card.source!, hash: "sha256:aaa" }],
    format: { fps: FPS, width: 1920, height: 1080 },
  };
  const words = (texts: [string, number][]) => ({ words: texts.map(([text, at], index) => ({ id: `w_${index}`, text, asset: "assets/talk.mp4", clip: "c_talk", track: "t_a", language: "en", at, end: at + 0.2 })), unchecked: [] });
  const keyFor = async (kinds: string[], read: ReturnType<typeof words>) => {
    const timing = await clipTiming(input({ kinds, timeline: timeline(null), wordsOf: async () => read }));
    return clipCacheKey({ ...base, ...(timing ? { timing } : {}) });
  };

  it("keeps the key of a clip that does not ask, whatever is said", async () => {
    const plain = clipCacheKey(base);
    expect(await keyFor([], words([["is", 4]]))).toBe(plain);
    expect(await keyFor([], words([["was", 4.5]]))).toBe(plain);
  });

  it("changes for a clip that asks when a word inside it changes or moves, not for a word outside it", async () => {
    const asked = await keyFor(["words"], words([["is", 4], ["later", 9]]));
    expect(asked).not.toBe(clipCacheKey(base));
    expect(await keyFor(["words"], words([["is", 4], ["much later", 9.5]]))).toBe(asked);
    expect(await keyFor(["words"], words([["was", 4], ["later", 9]]))).not.toBe(asked);
    expect(await keyFor(["words"], words([["is", 4.1], ["later", 9]]))).not.toBe(asked);
  });
});
