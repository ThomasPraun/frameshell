import { describe, expect, it } from "vitest";
import {
  type CaptionPhrase,
  type Timeline,
  type Transcript,
  SUBTITLE_ENTRY,
  entryEnd,
  entryProgress,
  entryUnits,
  parseTimeline,
  resolveSubtitleStyle,
  subtitleCues,
  subtitleTracks,
  subtitleWords,
} from "../src/index.js";

const HASH = `sha256:${"0".repeat(64)}`;
const NUMBERS = ["uno", "dos", "tres", "cuatro", "cinco", "seis", "siete", "ocho", "nueve", "diez"];
/** `uno` 1.0-1.4 s … `diez` 5.5-5.9 s: from a clip at timeline 0 / source 1 they sit at frames 0, 15, 30 … 135 (12 frames long) at 30 fps. */
const talk: Transcript = {
  schemaVersion: 1,
  asset: "assets/talk.mp4",
  assetHash: HASH,
  provider: "test",
  model: "test",
  words: NUMBERS.map((text, i) => ({ id: `w_${String(i + 1).padStart(6, "0")}`, text, start: 1 + i * 0.5, end: 1.4 + i * 0.5 })),
  edits: {},
};
const lookup = (asset: string) => (asset === talk.asset ? talk : null);
const id = (n: number) => `w_${String(n).padStart(6, "0")}`;

function timeline(clips: object[], track: object = {}): Timeline {
  return {
    schemaVersion: 1,
    id: "main",
    revision: 1,
    tracks: [
      { id: "v1", kind: "video", clips: clips as never },
      { id: "s1", kind: "subtitles", follows: "v1", ...track },
    ],
  };
}
const media = (id: string, start: number, inS: number, out: number) => ({ id, type: "media", asset: talk.asset, start, in: inS, out });
const phrase = (words: number[], chunks: number[], extra: Partial<CaptionPhrase> = {}): CaptionPhrase => ({ asset: talk.asset, words: words.map(id), chunks, ...extra });
const shown = (tl: Timeline) => subtitleTracks(tl, lookup, 30)[0]!;
const text = (cue: { words: { text: string }[] }) => cue.words.map((w) => w.text).join(" ");

describe("hand-chunked captions (#460)", () => {
  const tl = timeline([media("c1", 0, 1, 6)], { phrases: [phrase([1, 2, 3, 4, 5], [2, 3], { keyword: 4 })] });

  it("make one cue per chunk whatever the style's limits, and leave the other words to the style", () => {
    const { cues } = shown(tl);
    expect(cues.map(text)).toEqual(["UNO DOS", "TRES CUATRO CINCO", "SEIS SIETE OCHO", "NUEVE DIEZ"]);
  });

  it("mark the keyword in its cue only", () => {
    const { cues } = shown(tl);
    expect(cues.map((cue) => cue.keyword)).toEqual([undefined, 2, undefined, undefined]);
  });

  it("hold a chunk until the next cue starts, at most 0.35 s past its last word", () => {
    const { cues } = shown(tl);
    // "dos" ends at frame 27; the next chunk starts at 30, nearer than 27 + 11 frames.
    expect(cues[0]).toMatchObject({ start: 0, end: 30 });
    // "cinco" ends at 72; "seis" starts at 75.
    expect(cues[1]).toMatchObject({ start: 30, end: 75 });
    // Nothing follows soon: the last chunk of a phrase before a pause takes the full tail.
    const alone = timeline([media("c1", 0, 1, 2), media("c2", 10, 5, 6)], { phrases: [phrase([1, 2], [2])] });
    expect(shown(alone).cues[0]).toMatchObject({ start: 0, end: 27 + 11 });
  });

  it("are not wanted by chunks that a cut emptied: a removed word leaves its chunk shorter", () => {
    // Cut source 1.5-2.0 ("dos"): the chunk keeps "uno".
    const cut = timeline([media("c1", 0, 1, 1.5), media("c2", 0.5, 2, 6)], { phrases: [phrase([1, 2, 3], [2, 1])] });
    expect(shown(cut).cues.slice(0, 2).map(text)).toEqual(["UNO", "TRES"]);
  });

  it("take a phrase's own entry over the style's", () => {
    const own = timeline([media("c1", 0, 1, 6)], { style: { entry: "line" }, phrases: [phrase([1, 2], [2], { entry: "chars" })] });
    expect(shown(own).cues.slice(0, 2).map((cue) => cue.entry)).toEqual(["chars", "line"]);
  });

  it("hide every cue that overlaps a gap", () => {
    const gap = timeline([media("c1", 0, 1, 6)], { gaps: [{ from: 1.2, to: 2.6 }] });
    // Cues at frames 0-42, 45-87, 90-132, 135-147: the gap (frames 36-78) touches the first two.
    expect(shown(gap).cues.map((cue) => cue.start)).toEqual([90, 135]);
  });

  it("change nothing for a track without phrases or gaps", () => {
    const plain = shown(timeline([media("c1", 0, 1, 6)]));
    expect(plain.cues.every((cue) => cue.entry === "none" && cue.keyword === undefined)).toBe(true);
    expect(plain.cues.map((cue) => [cue.start, cue.end])).toEqual([[0, 42], [45, 87], [90, 132], [135, 147]]);
  });

  it("never end before they start, even for a word cut to one frame", () => {
    const style = resolveSubtitleStyle(undefined).style;
    const words = subtitleWords(timeline([media("c1", 0, 1, 6)]), "s1", lookup, 30);
    const cues = subtitleCues(words, style, 30, { phrases: [phrase([1], [1])] });
    expect(cues[0]!.end).toBeGreaterThan(cues[0]!.start);
  });
});

describe("subtitle style tokens", () => {
  it("default to the preset's keyword accent, no entry, and take valid overrides only", () => {
    expect(resolveSubtitleStyle(undefined).style).toMatchObject({ keywordColor: "#ffd426", keywordScale: 1.12, entry: "none" });
    expect(resolveSubtitleStyle({ keywordColor: null, keywordScale: 1.3, entry: "words" }).style).toMatchObject({ keywordColor: null, keywordScale: 1.3, entry: "words" });
    expect(resolveSubtitleStyle({ keywordColor: "red", keywordScale: 5, entry: "wobble" as never }).style).toMatchObject({ keywordColor: "#ffd426", keywordScale: 1.12, entry: "none" });
  });
});

describe("cue entries", () => {
  const cue = shown(timeline([media("c1", 0, 1, 6)], { style: { entry: "words" }, phrases: [phrase([1, 2, 3], [3], { keyword: 1 })] })).cues[0]!;

  it("give words their spoken time as delay, chars a stagger, a line none", () => {
    expect(entryUnits(cue, 30).map((unit) => [unit.text, unit.delay, unit.keyword])).toEqual([["UNO", 0, false], ["DOS", 0.5, true], ["TRES", 1, false]]);
    const chars = entryUnits({ ...cue, entry: "chars" }, 30);
    expect(chars.map((unit) => unit.text).join("")).toBe("UNODOSTRES");
    expect(chars[1]!.delay).toBeCloseTo(SUBTITLE_ENTRY.charStagger);
    expect(entryUnits({ ...cue, entry: "line" }, 30).every((unit) => unit.delay === 0)).toBe(true);
  });

  it("ease out from hidden to settled over 0.4 s with no overshoot", () => {
    expect(entryProgress(0, 0)).toBe(0);
    expect(entryProgress(0.2, 0)).toBeCloseTo(Math.sqrt(0.5));
    expect(entryProgress(0.4, 0)).toBe(1);
    expect(entryProgress(2, 0)).toBe(1);
    expect(entryProgress(0.1, 0.5)).toBe(0);
  });

  it("end when the last unit has settled; never for none", () => {
    expect(entryEnd(cue, 30)).toBeCloseTo(1.4);
    expect(entryEnd({ ...cue, entry: "none" }, 30)).toBe(0);
  });
});

describe("caption fields of a timeline file", () => {
  const parse = (track: object) => parseTimeline(timeline([media("c1", 0, 1, 6)], track));

  it("accept phrases and gaps", () => {
    expect(parse({ phrases: [phrase([1, 2], [1, 1], { keyword: 1 })], gaps: [{ from: 1, to: 2 }] }).ok).toBe(true);
  });

  it("refuse chunks that do not add up, a keyword past the end, a word in two phrases and an empty gap", () => {
    for (const bad of [
      { phrases: [phrase([1, 2], [1])] },
      { phrases: [phrase([1, 2], [2], { keyword: 2 })] },
      { phrases: [phrase([1, 2], [2]), phrase([2, 3], [2])] },
      { gaps: [{ from: 2, to: 2 }] },
    ]) {
      expect(parse(bad).ok).toBe(false);
    }
  });
});
