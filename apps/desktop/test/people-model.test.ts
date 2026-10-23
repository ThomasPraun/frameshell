import type { PersonInfo, TimelineView } from "@frameshell/protocol";
import { describe, expect, it } from "vitest";
import {
  agentOf,
  clock,
  confirmedBy,
  faceViewBox,
  inverseOf,
  linkChoices,
  linkedPerson,
  personColour,
  personWords,
  toRanges,
} from "../src/renderer/src/people/model.js";
import { buildTranscriptModel } from "../src/renderer/src/transcript/model.js";

// Seam under test: the People panel's model (ADR 0020): undo by comparing lists, link choices, picked words.

const person = (id: string, name: string, links: Partial<Pick<PersonInfo, "speakers" | "angles" | "faces">> = {}): PersonInfo => ({
  id,
  name,
  speakers: [],
  angles: [],
  faces: [],
  ...links,
});
const speaker = (transcript: string, id?: string, by?: string) => ({ transcript, ...(id ? { speaker: id } : {}), ...(by ? { by } : {}), missing: false });
const snap = (people: PersonInfo[], dismissed: string[] = []) => ({ people, dismissed });

describe("inverseOf", () => {
  it("removes a person that was added", () => {
    const { entry } = inverseOf(snap([]), snap([person("p_1", "Juan")]));
    expect(entry).toEqual({ steps: [{ kind: "remove", person: "p_1" }], change: { kind: "add", name: "Juan" } });
  });

  it("renames back", () => {
    const { entry } = inverseOf(snap([person("p_1", "Juan")]), snap([person("p_1", "Juan Pérez")]));
    expect(entry).toEqual({ steps: [{ kind: "rename", person: "p_1", name: "Juan" }], change: { kind: "rename", name: "Juan Pérez", from: "Juan" } });
  });

  it("unlinks a link that was added and links one that was removed, ignoring who confirmed it", () => {
    const linked = person("p_1", "Juan", { speakers: [speaker("transcripts/a.words.json", "s1", "agent:claude:x")] });
    const bare = person("p_1", "Juan");
    expect(inverseOf(snap([bare]), snap([linked])).entry?.steps).toEqual([
      { kind: "unlink", person: "p_1", target: { speaker: { transcript: "transcripts/a.words.json", speaker: "s1" } } },
    ]);
    expect(inverseOf(snap([linked]), snap([bare])).entry).toEqual({
      steps: [{ kind: "link", person: "p_1", target: { speaker: { transcript: "transcripts/a.words.json", speaker: "s1" } } }],
      change: { kind: "unlink", name: "Juan" },
    });
    const confirmed = person("p_1", "Juan", { speakers: [speaker("transcripts/a.words.json", "s1")] });
    expect(inverseOf(snap([confirmed]), snap([linked]))).toEqual({ entry: null, changed: false });
  });

  it("adds a removed person again and links their links by name, in one entry", () => {
    const juan = person("p_1", "Juan", {
      speakers: [speaker("transcripts/a.words.json")],
      angles: [{ timeline: "main", group: "g", angle: "juan", missing: false }],
      faces: [{ asset: "assets/a.mp4", at: 2, x: 0.5, y: 0.4, missing: false }],
    });
    const { entry } = inverseOf(snap([juan, person("p_2", "Ana")]), snap([person("p_2", "Ana")]));
    expect(entry?.change).toEqual({ kind: "remove", name: "Juan" });
    expect(entry?.steps).toEqual([
      { kind: "add", name: "Juan" },
      { kind: "link", person: "Juan", target: { speaker: { transcript: "transcripts/a.words.json" } } },
      { kind: "link", person: "Juan", target: { angle: { timeline: "main", group: "g", angle: "juan" } } },
      { kind: "link", person: "Juan", target: { face: { asset: "assets/a.mp4", at: 2, x: 0.5, y: 0.4 } } },
    ]);
  });

  it("undoes a confirmation that added a person and linked two things: unlink first, then remove", () => {
    const after = person("p_9", "Ana", { speakers: [speaker("transcripts/b.words.json", "s2")], faces: [{ asset: "assets/b.mp4", at: 1, x: 0.5, y: 0.5, missing: false }] });
    const steps = inverseOf(snap([person("p_1", "Juan")]), snap([person("p_1", "Juan"), after])).entry?.steps;
    expect(steps).toEqual([{ kind: "remove", person: "p_9" }]);
  });

  it("tells a dismissed suggestion (nothing to put back) from no change", () => {
    expect(inverseOf(snap([], []), snap([], ["sg_1"]))).toEqual({ entry: null, changed: true });
    expect(inverseOf(snap([], ["sg_1"]), snap([], ["sg_1"]))).toEqual({ entry: null, changed: false });
  });
});

describe("agent marks", () => {
  it("reads the agent label from `by`", () => {
    expect(agentOf("agent:claude:s1")).toBe("claude");
    expect(agentOf("agent")).toBeNull();
    expect(agentOf(undefined)).toBeNull();
    expect(confirmedBy(person("p_1", "Juan", { speakers: [speaker("t", "s1", "agent:codex:2")] }))).toBe("codex");
    expect(confirmedBy(person("p_1", "Juan", { speakers: [speaker("t", "s1")] }))).toBeNull();
  });

  it("gives a person one colour slot from their id", () => {
    expect(personColour("p_3fa2c1")).toBe(personColour("p_3fa2c1"));
    for (const id of ["p_a", "p_b", "p_juan", "p_3fa2c1"]) expect(personColour(id)).toBeLessThan(6);
  });
});

const TRANSCRIPT = (asset: string, speakers: { id: string; name: string }[], words: [string, number, string?][]) => ({
  schemaVersion: 1,
  asset,
  assetHash: `sha256:${"0".repeat(64)}`,
  provider: "test",
  model: "test",
  language: "en",
  nextWordId: 10,
  speakers,
  nextSpeakerId: speakers.length + 1,
  words: words.map(([text, start, who], i) => ({ id: `w_00000${i}`, text, start, end: start + 0.5, confidence: 0.9, ...(who ? { speaker: who } : {}) })),
  edits: {},
});

const sources = [
  {
    path: "transcripts/ep1.words.json",
    transcript: TRANSCRIPT("assets/ep1.mp4", [{ id: "s1", name: "Speaker 1" }, { id: "s2", name: "Speaker 2" }], [["hi", 0, "s1"], ["there", 1, "s2"], ["you", 2, "s1"]]),
  },
  { path: "transcripts/mic.words.json", transcript: TRANSCRIPT("assets/mic.wav", [], [["solo", 0]]) },
];

const view = {
  timeline: "main",
  path: "timelines/main.json",
  revision: 1,
  fps: 30,
  duration: 10,
  tracks: [
    { id: "t_v", kind: "video", name: null, follows: null, clips: [{ id: "c_1", type: "media", asset: "assets/ep1.mp4", start: 0, end: 2.4, in: 0, out: 2.4, speed: 1 }] },
  ],
  groups: [{ id: "g_talk", angles: [{ id: "ana", name: "Ana", asset: "assets/ana.mp4", offset: 0 }, { id: "ben", name: "Ben", asset: "assets/ben.mp4", offset: 0 }] }],
  problems: [],
} as unknown as TimelineView;

describe("linkChoices", () => {
  it("offers every speaker, a whole transcript with no speakers, and every angle, minus what is taken", () => {
    const all = linkChoices(sources as never, view, []);
    expect(all.map((choice) => choice.key)).toEqual([
      "voice:transcripts/ep1.words.json:s1",
      "voice:transcripts/ep1.words.json:s2",
      "voice:transcripts/mic.words.json",
      "angle:g_talk:ana",
      "angle:g_talk:ben",
    ]);
    const taken = [
      person("p_1", "Juan", {
        speakers: [speaker("transcripts/ep1.words.json", "s1")],
        angles: [{ timeline: "main", group: "g_talk", angle: "ben", missing: false }],
      }),
    ];
    expect(linkChoices(sources as never, view, taken).map((choice) => choice.key)).toEqual([
      "voice:transcripts/ep1.words.json:s2",
      "voice:transcripts/mic.words.json",
      "angle:g_talk:ana",
    ]);
  });

  it("offers nothing of a transcript someone holds whole", () => {
    const whole = [person("p_1", "Juan", { speakers: [speaker("transcripts/ep1.words.json")] })];
    expect(linkChoices(sources as never, null, whole).map((choice) => choice.key)).toEqual(["voice:transcripts/mic.words.json"]);
  });
});

describe("personWords", () => {
  const model = buildTranscriptModel(view, sources as never);

  it("selects the words of the linked speakers that the timeline plays", () => {
    const words = personWords(person("p_1", "Juan", { speakers: [speaker("transcripts/ep1.words.json", "s1")] }), model);
    expect(words.map((word) => [word.transcript, word.word, word.text])).toEqual([
      ["transcripts/ep1.words.json", "w_000000", "hi"],
      ["transcripts/ep1.words.json", "w_000002", "you"],
    ]);
    expect(words[0]).toMatchObject({ asset: "assets/ep1.mp4", start: 0, end: 0.5 });
  });

  it("takes every word of a transcript linked whole, and ignores links that are missing", () => {
    expect(personWords(person("p_1", "Juan", { speakers: [speaker("transcripts/ep1.words.json")] }), model)).toHaveLength(3);
    expect(personWords(person("p_1", "Juan", { speakers: [{ ...speaker("transcripts/ep1.words.json", "s1"), missing: true }] }), model)).toEqual([]);
  });
});

describe("helpers", () => {
  it("turns daemon spans into selection ranges, dropping empty ones", () => {
    expect(toRanges([{ start: 1, end: 2 }, { start: 3, end: 3 }])).toEqual([{ from: 1, to: 2 }]);
  });

  it("crops a face thumbnail around the anchor and keeps it inside the picture", () => {
    expect(faceViewBox({ x: 0.5, y: 0.5 }, 16 / 9)).toBe("inset(23.3% 35% 23.3% 35%)");
    expect(faceViewBox({ x: 0, y: 1 }, 16 / 9)).toBe("inset(46.7% 70% 0% 0%)");
  });

  it("finds the person a transcript speaker is, never through a whole-transcript link", () => {
    const juan = person("p_1", "Juan", { speakers: [speaker("transcripts/a.words.json", "s1")] });
    const ana = person("p_2", "Ana", { speakers: [speaker("transcripts/b.words.json")] });
    expect(linkedPerson(snap([juan, ana]), "transcripts/a.words.json", "s1")?.id).toBe("p_1");
    expect(linkedPerson(snap([juan, ana]), "transcripts/a.words.json", "s2")).toBeUndefined();
    expect(linkedPerson(snap([juan, ana]), "transcripts/b.words.json", "s1")).toBeUndefined();
    expect(linkedPerson(null, "transcripts/a.words.json", "s1")).toBeUndefined();
  });

  it("writes seconds as minutes and seconds", () => {
    expect(clock(0)).toBe("0:00");
    expect(clock(200)).toBe("3:20");
  });
});
