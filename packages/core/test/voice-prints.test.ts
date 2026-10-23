import { describe, expect, it } from "vitest";
import { SPEAKER_MARGIN, SPEAKER_MATCH, classifyVoiceCache, cosine, meanPrint, speakerSuggestions, suggestionId, voiceStretches } from "../src/index.js";

let nextId = 1;
function word(start: number, end: number, speaker?: string) {
  return { id: `w_${String(nextId++).padStart(6, "0")}`, text: "x", start, end, ...(speaker ? { speaker } : {}) };
}

/** Unit vector along `axis`, tilted towards `toward` so its cosine with that axis is `similarity`. */
function voice(axis: number, toward?: number, similarity = 1): number[] {
  const vector = new Array<number>(8).fill(0);
  vector[axis] = toward === undefined ? 1 : Math.sqrt(1 - similarity ** 2);
  if (toward !== undefined) vector[toward] = similarity;
  return vector;
}

describe("voiceStretches", () => {
  it("joins a speaker's words across short pauses and cuts where another voice starts", () => {
    const words = [word(0, 0.8, "s1"), word(1.0, 1.9, "s1"), word(2.2, 3.0, "s1"), word(2.9, 3.4, "s2"), word(3.5, 6, "s1")];
    // s1 runs 0-3.0 but s2 starts at 2.9; after s2 (ends 3.4) s1 resumes at 3.5.
    expect(voiceStretches({ words, edits: {} }, "s1")).toEqual([
      { start: 0, end: 2.9 },
      { start: 3.5, end: 6 },
    ]);
  });

  it("drops runs under 1.5 s, splits runs over 10 s evenly, keeps the 20 longest in time order", () => {
    expect(voiceStretches({ words: [word(0, 1.4, "s1"), word(5, 6, "s1")], edits: {} }, "s1")).toEqual([]);
    expect(voiceStretches({ words: [word(0, 25, "s1")], edits: {} }, "s1")).toEqual([
      { start: 0, end: 8.333 },
      { start: 8.333, end: 16.667 },
      { start: 16.667, end: 25 },
    ]);
    // 25 runs of 2 s and longer, separated by another voice: the 5 shortest go.
    const many = Array.from({ length: 25 }, (_, i) => [word(i * 20, i * 20 + 2 + i * 0.1, "s1"), word(i * 20 + 15, i * 20 + 16, "s2")]).flat();
    const kept = voiceStretches({ words: many, edits: {} }, "s1");
    expect(kept).toHaveLength(20);
    expect(kept[0]!.start).toBe(100);
    expect(kept.map((stretch) => stretch.start)).toEqual([...kept.map((stretch) => stretch.start)].sort((a, b) => a - b));
  });

  it("follows human speaker corrections, and takes every word for a whole transcript", () => {
    const a = word(0, 2, "s1");
    const b = word(2.1, 4, "s1");
    const transcript = { words: [a, b], edits: { [b.id]: { speaker: "s2" } } };
    expect(voiceStretches(transcript, "s1")).toEqual([{ start: 0, end: 2 }]);
    expect(voiceStretches(transcript, "s2")).toEqual([{ start: 2.1, end: 4 }]);
    expect(voiceStretches(transcript)).toEqual([{ start: 0, end: 4 }]);
  });
});

describe("meanPrint", () => {
  it("averages normalized embeddings weighted by seconds, then normalizes", () => {
    const print = meanPrint([[2, 0], [0, 1]], [3, 1])!;
    expect(print[0]).toBeCloseTo(3 / Math.sqrt(10));
    expect(print[1]).toBeCloseTo(1 / Math.sqrt(10));
    expect(meanPrint([], [])).toBeNull();
  });
});

describe("speakerSuggestions", () => {
  const juan = { id: "p_juan", name: "Juan", print: voice(0) };
  const ana = { id: "p_ana", name: "Ana", print: voice(1) };
  const speaker = (id: string, print: number[]) => ({ transcript: "transcripts/ep2.words.json", speaker: id, name: `Speaker ${id.slice(1)}`, print });

  it("suggests the closest person above the threshold, with a stable id, a score and why", () => {
    const [suggestion, ...rest] = speakerSuggestions([juan, ana], [speaker("s1", voice(2, 0, 0.9)), speaker("s2", voice(3))]);
    expect(rest).toEqual([]);
    expect(suggestion).toEqual({
      id: suggestionId("speaker", ["p_juan", "transcripts/ep2.words.json", "s1"]),
      kind: "speaker",
      person: { id: "p_juan", name: "Juan" },
      speaker: { transcript: "transcripts/ep2.words.json", speaker: "s1", name: "Speaker 1" },
      score: 0.9,
      reason: "s1 (Speaker 1) in transcripts/ep2.words.json sounds like Juan (0.90).",
    });
    expect(suggestion!.id).toMatch(/^sg_[0-9a-f]{8}$/);
    expect(suggestionId("speaker", ["p_ana", "transcripts/ep2.words.json", "s1"])).not.toBe(suggestion!.id);
  });

  it("suggests nothing under the threshold or when two people sound alike", () => {
    expect(speakerSuggestions([juan], [speaker("s1", voice(2, 0, SPEAKER_MATCH - 0.01))])).toEqual([]);
    expect(speakerSuggestions([juan], [speaker("s1", voice(2, 0, SPEAKER_MATCH + 0.01))])).toHaveLength(1);
    // Halfway between Juan and Ana: both near 0.7, no margin.
    const between = [0.75, 0.66, 0, 0, 0, 0, 0, 0];
    expect(cosine(between, juan.print) - cosine(between, ana.print)).toBeLessThan(SPEAKER_MARGIN);
    expect(speakerSuggestions([juan, ana], [speaker("s1", between)])).toEqual([]);
  });

  it("orders by score", () => {
    const suggestions = speakerSuggestions([juan, ana], [speaker("s1", voice(2, 0, 0.8)), speaker("s2", voice(3, 1, 0.95))]);
    expect(suggestions.map((suggestion) => suggestion.person.name)).toEqual(["Ana", "Juan"]);
  });
});

describe("classifyVoiceCache", () => {
  it("knows its print files and write temps, nothing else", () => {
    expect(classifyVoiceCache("0123456789abcdef.json", false)).toEqual({ kind: "voice", key: "0123456789abcdef" });
    expect(classifyVoiceCache("0123456789abcdef.json.123.ab12cd34.tmp", false)).toEqual({ kind: "temp", key: null });
    expect(classifyVoiceCache("notes.json", false)).toBeNull();
    expect(classifyVoiceCache("0123456789abcdef.json", true)).toBeNull();
  });
});
