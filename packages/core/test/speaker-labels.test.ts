import { describe, expect, it } from "vitest";
import type { Transcript, TranscriptFileWord } from "@frameshell/schema";
import { carrySpeakers, labelSpeakers, parseDiarization, wordLabels } from "../src/index.js";

const word = (n: number, start: number, end: number, speaker?: string): TranscriptFileWord => ({
  id: `w_${String(n).padStart(6, "0")}`,
  text: `word${n}`,
  start,
  end,
  ...(speaker ? { speaker } : {}),
});

describe("parseDiarization", () => {
  it("reads `start -- end label` lines of sherpa-onnx's stdout and skips its config echo", () => {
    const stdout = [
      "OfflineSpeakerDiarizationConfig(segmentation=..., min_duration_off=0.5)",
      "Started",
      "0.318 -- 3.997 speaker_00",
      "4.402 -- 6.865 speaker_01",
      "7 -- 7 speaker_00",
      "",
    ].join("\n");
    expect(parseDiarization(stdout)).toEqual([
      { start: 0.318, end: 3.997, label: "speaker_00" },
      { start: 4.402, end: 6.865, label: "speaker_01" },
    ]);
  });
});

describe("wordLabels", () => {
  const segments = [
    { start: 0, end: 2, label: "a" },
    { start: 2.1, end: 4, label: "b" },
    { start: 6, end: 7, label: "a" },
  ];

  it("takes the segment overlapping a word most, a point word's enclosing one, else the nearest within 0.5 s", () => {
    const words = [word(1, 0.2, 0.5), word(2, 1.8, 2.6), word(3, 3, 3), word(4, 4.3, 4.6), word(5, 5, 5.2)];
    expect(wordLabels(words, segments)).toEqual(["a", "b", "b", "b", undefined]);
  });
});

describe("labelSpeakers", () => {
  it("numbers new voices s1, s2 by first appearance, with default names", () => {
    const words = [word(1, 0, 1), word(2, 1, 2), word(3, 2, 3)];
    const result = labelSpeakers(words, ["speaker_03", "speaker_00", undefined], null);
    expect(result.words.map((w) => w.speaker)).toEqual(["s1", "s2", undefined]);
    expect(result.speakers).toEqual([
      { id: "s1", name: "Speaker 1" },
      { id: "s2", name: "Speaker 2" },
    ]);
  });

  it("gives each voice the id and name of the earlier speaker it shares most words with", () => {
    const previous: Pick<Transcript, "words" | "edits" | "speakers"> = {
      words: [word(1, 0, 1, "s1"), word(2, 1, 2, "s1"), word(3, 2, 3, "s2"), word(4, 3, 4, "s2")],
      edits: {},
      speakers: [
        { id: "s1", name: "Ana" },
        { id: "s2", name: "Ben" },
      ],
    };
    // The labels come back swapped and a third voice appears: ids follow the people, not the labels.
    const result = labelSpeakers(previous.words, ["x1", "x1", "x0", "x9"], previous);
    expect(result.words.map((w) => w.speaker)).toEqual(["s1", "s1", "s2", "s3"]);
    expect(result.speakers).toEqual([
      { id: "s1", name: "Ana" },
      { id: "s2", name: "Ben" },
      { id: "s3", name: "Speaker 3" },
    ]);
  });

  it("keeps speakers that only a human correction still names, and never reuses their ids", () => {
    const previous: Pick<Transcript, "words" | "edits" | "speakers"> = {
      words: [word(1, 0, 1, "s1"), word(2, 1, 2, "s2")],
      edits: { w_000002: { speaker: "s2" } },
      speakers: [
        { id: "s1", name: "Ana" },
        { id: "s2", name: "Ben" },
      ],
    };
    const result = labelSpeakers(previous.words, ["x", "x"], previous);
    expect(result.words.map((w) => w.speaker)).toEqual(["s1", "s1"]);
    expect(result.speakers).toEqual([
      { id: "s1", name: "Ana" },
      { id: "s2", name: "Ben" },
    ]);
  });

  it("never gives a dropped speaker's id to a voice found by a later run", () => {
    const words = [word(1, 0, 1), word(2, 1, 2), word(3, 2, 3)];
    const first = labelSpeakers(words, ["a", "b", "c"], null);
    expect(first.nextSpeakerId).toBe(4);
    const run1 = { words: first.words, edits: {}, speakers: [...first.speakers.slice(0, 2), { id: "s3", name: "Carla" }], nextSpeakerId: first.nextSpeakerId };
    const second = labelSpeakers(run1.words, ["a", "b", "b"], run1);
    expect(second.speakers.map((speaker) => speaker.id)).toEqual(["s1", "s2"]);
    expect(second.nextSpeakerId).toBe(4);
    const run2 = { words: second.words, edits: {}, speakers: second.speakers, nextSpeakerId: second.nextSpeakerId };
    const third = labelSpeakers(run2.words, ["a", "b", "c"], run2);
    expect(third.words.map((w) => w.speaker)).toEqual(["s1", "s2", "s4"]);
    expect(third.speakers.at(-1)).toEqual({ id: "s4", name: "Speaker 4" });
    expect(third.nextSpeakerId).toBe(5);
  });
});

describe("carrySpeakers", () => {
  it("gives re-transcribed words the speaker of the old words they overlap", () => {
    const previous = { words: [word(1, 0, 1, "s1"), word(2, 1.2, 2, "s2")], speakers: [{ id: "s1", name: "Ana" }, { id: "s2", name: "Ben" }] };
    const fresh = [word(1, 0, 0.9), word(3, 1.1, 1.6), word(4, 9, 9.5)];
    const speakers = carrySpeakers(fresh, {}, previous);
    expect(fresh.map((w) => w.speaker)).toEqual(["s1", "s2", undefined]);
    expect(speakers).toEqual(previous.speakers);
  });

  it("leaves a transcript that never had speakers without them", () => {
    const fresh = [word(1, 0, 1)];
    expect(carrySpeakers(fresh, {}, { words: [word(1, 0, 1)] })).toBeUndefined();
    expect(fresh[0]).not.toHaveProperty("speaker");
  });
});
