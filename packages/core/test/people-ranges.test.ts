import { describe, expect, it } from "vitest";
import { type MulticamGroup, type Person, type Timeline, type Transcript } from "@frameshell/schema";
import { type RangesSource, mergeSpans, personRanges } from "../src/index.js";

// Pure placement of a person's words and turns on a timeline (ADR 0020 decision 7): hand-written fixtures, no media.

const person = (parts: Partial<Person>): Person => ({ id: "p_1", name: "Juan", speakers: [], angles: [], faces: [], ...parts });

function transcript(asset: string, words: [string, number, number, string?][], edits: Transcript["edits"] = {}): Transcript {
  return {
    schemaVersion: 1,
    asset,
    assetHash: `sha256:${"a".repeat(64)}`,
    provider: "test",
    model: "test",
    words: words.map(([id, start, end, speaker]) => ({ id, text: id, start, end, ...(speaker ? { speaker } : {}) })),
    edits,
    speakers: [
      { id: "s1", name: "Speaker 1" },
      { id: "s2", name: "Speaker 2" },
    ],
  } as Transcript;
}

const none: RangesSource["turns"] = async () => ({ turns: [], warnings: [] });

describe("mergeSpans", () => {
  it("bridges gaps under 0.5 s, keeps 0.5 s and more, drops empty spans", () => {
    expect(
      mergeSpans([
        { start: 5, end: 6 },
        { start: 1, end: 2 },
        { start: 2.4, end: 3 },
        { start: 3.5, end: 4 },
        { start: 7, end: 7 },
      ]),
    ).toEqual([
      { start: 1, end: 3 },
      { start: 3.5, end: 4 },
      { start: 5, end: 6 },
    ]);
  });
});

describe("speaks from transcript speakers", () => {
  const words: [string, number, number, string?][] = [
    ["w1", 1, 1.4, "s1"],
    ["w2", 1.6, 2, "s1"],
    ["w3", 4, 4.4, "s1"],
    ["w4", 2.2, 2.8, "s2"],
    ["w5", 6, 6.5, "s1"],
    ["w6", 8, 8.4, "s1"],
  ];
  // c1 plays 0-3; a cut leaves 4-5; c3 plays 6-8.5 at double speed from timeline 5.
  const timeline = {
    schemaVersion: 1,
    id: "main",
    revision: 0,
    tracks: [
      {
        id: "t_v",
        kind: "video",
        clips: [
          { id: "c1", type: "media", asset: "assets/a.mp4", start: 0, in: 0, out: 3 },
          { id: "c2", type: "media", asset: "assets/a.mp4", start: 3, in: 4, out: 5 },
          { id: "c3", type: "media", asset: "assets/a.mp4", start: 5, in: 6, out: 8.5, speed: 2 },
        ],
      },
    ],
  } as unknown as Timeline;
  const link = { transcript: "transcripts/a.words.json", speaker: "s1" };
  const source = (edits: Transcript["edits"] = {}): RangesSource => ({
    transcript: (file) => (file === link.transcript ? transcript("assets/a.mp4", words, edits) : null),
    turns: none,
  });

  it("places the speaker's words through cuts and speed, bridging short pauses", async () => {
    const found = await personRanges(person({ speakers: [link] }), "speaks", timeline, source());
    expect(found.spans).toEqual([
      { start: 1, end: 2 },
      { start: 3, end: 3.4 },
      { start: 5, end: 5.25 },
      { start: 6, end: 6.2 },
    ]);
    expect(found.total).toBe(1.85);
    expect(found.warnings).toEqual([]);
  });

  it("counts a word whose speaker a human corrected", async () => {
    const found = await personRanges(person({ speakers: [link] }), "speaks", timeline, source({ w4: { speaker: "s1" } }));
    expect(found.spans[0]).toEqual({ start: 1, end: 3.4 });
  });

  it("takes every word for a link without speaker, and nothing on screen without angles", async () => {
    const all = person({ speakers: [{ transcript: link.transcript }] });
    expect((await personRanges(all, "speaks", timeline, source())).spans[0]).toEqual({ start: 1, end: 3.4 });
    expect((await personRanges(all, "onscreen", timeline, source())).spans).toEqual([]);
  });

  it("warns about a link whose transcript or speaker is gone and goes on", async () => {
    const found = await personRanges(
      person({ speakers: [{ transcript: "transcripts/gone.words.json" }, { transcript: link.transcript, speaker: "s9" }, link] }),
      "speaks",
      timeline,
      source(),
    );
    expect(found.warnings).toHaveLength(2);
    expect(found.spans).toHaveLength(4);
  });
});

describe("multicam angles", () => {
  const group = {
    id: "g_talk",
    angles: [
      { id: "ana", name: "Ana", asset: "assets/ana.mp4", offset: 0, mic: "lav" },
      { id: "ben", name: "Ben", asset: "assets/ben.mp4", offset: 0 },
    ],
    mics: [{ id: "lav", name: "Ana lav", asset: "assets/lav.wav", offset: 0 }],
  } as unknown as MulticamGroup;
  // Shots show group seconds 0-10 and 10-20, then a cut to 30-40 at timeline 20.
  const shot = (id: string, start: number, from: number, to: number, shape: string, angles: string[]) => ({ id, type: "shot", start, in: from, out: to, shot: shape, angles });
  const timeline = {
    schemaVersion: 1,
    id: "main",
    revision: 0,
    groups: [group],
    tracks: [
      {
        id: "t_p",
        kind: "program",
        group: "g_talk",
        clips: [shot("s1", 0, 0, 10, "solo", ["ana"]), shot("s2", 10, 10, 20, "solo", ["ben"]), shot("s3", 20, 30, 40, "two-up", ["ana", "ben"])],
      },
    ],
  } as unknown as Timeline;
  const turns: RangesSource["turns"] = async () => ({
    turns: [
      { angle: "ana", name: "Ana", start: 2, end: 6 },
      { angle: "ana", name: "Ana", start: 8, end: 12 },
      { angle: "ben", name: "Ben", start: 12, end: 18 },
      { angle: "ana", name: "Ana", start: 32, end: 35 },
    ],
    warnings: ["one note"],
  });
  const source: RangesSource = { transcript: () => null, turns };
  const ana = person({ id: "p_a", name: "Ana", angles: [{ timeline: "main", group: "g_talk", angle: "ana" }] });
  const ben = person({ id: "p_b", name: "Ben", angles: [{ timeline: "main", group: "g_talk", angle: "ben" }] });

  it("speaks: the angle's turns inside each shot, through the cut", async () => {
    const found = await personRanges(ana, "speaks", timeline, source);
    expect(found.spans).toEqual([
      { start: 2, end: 6 },
      { start: 8, end: 12 },
      { start: 22, end: 25 },
    ]);
    expect(found.warnings).toEqual(["one note"]);
    expect((await personRanges(ben, "speaks", timeline, source)).spans).toEqual([{ start: 12, end: 18 }]);
  });

  it("onscreen: the shots that show the angle, whoever speaks", async () => {
    expect((await personRanges(ana, "onscreen", timeline, source)).spans).toEqual([
      { start: 0, end: 10 },
      { start: 20, end: 30 },
    ]);
    expect((await personRanges(ben, "onscreen", timeline, source)).spans).toEqual([{ start: 10, end: 30 }]);
  });

  it("speaks: a mic's whole transcript is heard through the shots", async () => {
    const lav = person({ speakers: [{ transcript: "transcripts/lav.words.json" }] });
    const found = await personRanges(lav, "speaks", timeline, {
      transcript: () => transcript("assets/lav.wav", [["w1", 2, 3], ["w2", 12, 13], ["w3", 32, 33], ["w4", 25, 26]]),
      turns: none,
    });
    // Group seconds 25-26 are not in any shot.
    expect(found.spans).toEqual([
      { start: 2, end: 3 },
      { start: 12, end: 13 },
      { start: 22, end: 23 },
    ]);
  });

  it("an angle that is gone or a group the timeline does not show gives nothing", async () => {
    const lost = person({
      angles: [
        { timeline: "main", group: "g_talk", angle: "zed" },
        { timeline: "main", group: "g_other", angle: "ana" },
      ],
    });
    const found = await personRanges(lost, "onscreen", timeline, source);
    expect(found.spans).toEqual([]);
    expect(found.warnings).toHaveLength(1);
  });
});
