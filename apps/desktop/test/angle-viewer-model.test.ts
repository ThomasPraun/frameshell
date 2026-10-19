import type { TimelineView } from "@frameshell/protocol";
import { describe, expect, it } from "vitest";
import { cropViewBox, groupTimeAt, programRows, sameTurns, speakerChoices, speakingAt, turnsKey, viewerModel } from "../src/renderer/src/angles/model.js";

// Seam under test: what the multicam viewer shows at a playhead time (#243): group clock, shot angles, speakers.

const GROUP = {
  id: "g_talk",
  angles: [
    { id: "ana", name: "Ana", asset: "assets/ana.mp4", offset: 0 },
    { id: "ben", name: "Ben", asset: "assets/ben.mp4", offset: 1.5, crop: { left: 0.5, bottom: 0.125 } },
    { id: "cleo", name: "Cleo", asset: "assets/cleo.mp4", offset: 0 },
  ],
};

const shot = (id: string, start: number, end: number, layout: string, angles: string[], source = start) => ({
  id,
  type: "shot",
  start,
  end,
  in: source,
  out: source + (end - start),
  shot: layout,
  angles,
});

function view(shots: ReturnType<typeof shot>[]): TimelineView {
  return {
    timeline: "main",
    path: "timelines/main.json",
    revision: 1,
    fps: 30,
    duration: 20,
    problems: [],
    groups: [GROUP],
    tracks: [{ id: "t_p", kind: "program", name: null, follows: null, group: "g_talk", clips: shots }],
  };
}

const model = (shots: ReturnType<typeof shot>[], time: number, turns: Parameters<typeof viewerModel>[4] = []) => {
  const timeline = view(shots);
  return viewerModel(programRows(timeline), timeline.groups, timeline.fps, time, turns);
};

describe("viewerModel", () => {
  const shots = [shot("c_1", 0, 4, "solo", ["ana"]), shot("c_2", 4, 8, "two-up", ["ana", "cleo"], 10)];

  it("has a tile per angle in group order, numbered for the keys", () => {
    const tiles = model(shots, 1)!.tiles;
    expect(tiles.map((tile) => [tile.number, tile.id, tile.name])).toEqual([
      [1, "ana", "Ana"],
      [2, "ben", "Ben"],
      [3, "cleo", "Cleo"],
    ]);
    expect(tiles.map((tile) => tile.color)).toEqual([0, 1, 2]);
  });

  it("shows only an angle's crop, as a tile of a gallery recording", () => {
    expect(model(shots, 1)!.tiles.map((tile) => tile.viewBox)).toEqual([null, "inset(0% 0% 12.5% 50%)", null]);
    expect(cropViewBox({})).toBeNull();
    expect(cropViewBox({ top: 0.0222, right: 0.5125 })).toBe("inset(2.22% 51.25% 0% 0%)");
  });

  it("outlines the angles of the shot under the playhead", () => {
    expect(model(shots, 1)!.tiles.map((tile) => tile.inShot)).toEqual([true, false, false]);
    expect(model(shots, 5)!.tiles.map((tile) => tile.inShot)).toEqual([true, false, true]);
  });

  it("puts each angle at group time less its offset, never before its file starts", () => {
    const at = model(shots, 5)!;
    expect(at.groupTime).toBeCloseTo(11);
    expect(at.tiles.map((tile) => tile.sourceTime)).toEqual([11, 9.5, 11]);
    expect(model(shots, 1)!.tiles[1]!.sourceTime).toBe(0);
  });

  it("marks every angle whose turn covers the playhead, overlapping speakers included", () => {
    const turns = [
      { angle: "ana", name: "Ana", start: 0, end: 3 },
      { angle: "cleo", name: "Cleo", start: 2, end: 6 },
    ];
    expect(model(shots, 2.5, turns)!.tiles.map((tile) => tile.speaking)).toEqual([true, false, true]);
    expect(model(shots, 3.5, turns)!.tiles.map((tile) => tile.speaking)).toEqual([false, false, true]);
  });

  it("reads speakers on the group clock, not the timeline's", () => {
    const turns = [{ angle: "ben", name: "Ben", start: 10.5, end: 12 }];
    expect(model(shots, 5, turns)!.tiles[1]!.speaking).toBe(true);
    expect(model(shots, 1, turns)!.tiles[1]!.speaking).toBe(false);
  });

  it("shows no angle as in the shot in a gap, and keeps the clock going from the shot before", () => {
    const gap = model([shot("c_1", 0, 4, "solo", ["ana"], 2)], 6)!;
    expect(gap.hasShot).toBe(false);
    expect(gap.tiles.some((tile) => tile.inShot)).toBe(false);
    expect(gap.groupTime).toBeCloseTo(8);
  });

  it("is null without a program track or without its group", () => {
    const plain: TimelineView = { ...view([]), tracks: [] };
    expect(viewerModel(programRows(plain), plain.groups, 30, 0)).toBeNull();
    const orphan: TimelineView = { ...view(shots), groups: [] };
    expect(viewerModel(programRows(orphan), orphan.groups, 30, 0)).toBeNull();
  });
});

describe("groupTimeAt", () => {
  it("is exact on the frame grid, shot start included", () => {
    const row = programRows(view([shot("c_1", 2, 6, "solo", ["ana"], 12)]))[0]!;
    expect(groupTimeAt(row, 2, 30)).toEqual({ groupTime: 12, shot: true });
    expect(groupTimeAt(row, 6, 30).shot).toBe(false);
  });
});

describe("speakingAt and sameTurns", () => {
  const turns = [{ angle: "ana", name: "Ana", start: 1, end: 2 }];
  it("covers start, not end", () => {
    expect(speakingAt(turns, "ana", 1)).toBe(true);
    expect(speakingAt(turns, "ana", 2)).toBe(false);
    expect(speakingAt(turns, "ben", 1.5)).toBe(false);
  });
  it("compares turns by angle and span", () => {
    expect(sameTurns(turns, [{ ...turns[0]! }])).toBe(true);
    expect(sameTurns(turns, [{ ...turns[0]!, end: 3 }])).toBe(false);
    expect(sameTurns(turns, [])).toBe(false);
  });
});

describe("turnsKey", () => {
  const angles = [
    { id: "ana", asset: "assets/room.mp4", offset: 0 },
    { id: "ben", asset: "assets/room.mp4", offset: 0 },
  ];
  const transcript = (speaker: string, edits = {}) => ({
    path: "transcripts/room.words.json",
    transcript: {
      version: 1,
      asset: "assets/room.mp4",
      assetHash: `sha256:${"a".repeat(64)}`,
      words: [{ id: "w1", text: "hi", start: 0, end: 0.4, speaker }],
      edits,
      speakers: [{ id: "s1", name: "Speaker 1" }, { id: "s2", name: "Speaker 2" }],
    },
  }) as never;
  const hashes = new Map([["assets/room.mp4", `sha256:${"a".repeat(64)}`]]);

  it("changes when a speaker correction lands in a transcript of an angle's asset", () => {
    const before = turnsKey(angles, [transcript("s1")], hashes);
    expect(turnsKey(angles, [transcript("s1")], hashes)).toBe(before);
    expect(turnsKey(angles, [transcript("s1", { w1: { speaker: "s2" } })], hashes)).not.toBe(before);
    expect(turnsKey(angles, [transcript("s2")], hashes)).not.toBe(before);
  });

  it("changes when the asset hash moves, and ignores transcripts of other assets", () => {
    const before = turnsKey(angles, [transcript("s1")], hashes);
    expect(turnsKey(angles, [transcript("s1")], new Map([["assets/room.mp4", null]]))).not.toBe(before);
    const other = { path: "transcripts/x.words.json", transcript: { asset: "assets/x.mp4" } } as never;
    expect(turnsKey(angles, [transcript("s1"), other], hashes)).toBe(before);
  });

  it("follows the transcript of a mic the angles share, and changes when the mics do", () => {
    const cameras = [
      { id: "ana", asset: "assets/ana.mp4", offset: 0, mic: "lav" },
      { id: "ben", asset: "assets/ben.mp4", offset: 0, mic: "lav" },
    ];
    const mics = [{ id: "lav", asset: "assets/room.mp4", offset: 0.5 }];
    const before = turnsKey(cameras, [transcript("s1")], hashes, mics);
    expect(turnsKey(cameras, [transcript("s1", { w1: { speaker: "s2" } })], hashes, mics)).not.toBe(before);
    const moved = [{ ...mics[0]!, offset: 0.6 }];
    expect(turnsKey(cameras, [transcript("s1")], hashes, moved)).not.toBe(before);
    // Without the mic, room.mp4 is no angle's sound: its transcript does not count.
    expect(turnsKey(cameras, [transcript("s1", { w1: { speaker: "s2" } })], hashes)).toBe(turnsKey(cameras, [transcript("s1")], hashes));
  });

  it("changes when a person paints turns, so the lanes measure again", () => {
    const before = turnsKey(angles, [], hashes, [], []);
    expect(turnsKey(angles, [], hashes)).toBe(before);
    const painted = [{ angle: "ana", start: 1, end: 2, speaking: true }];
    expect(turnsKey(angles, [], hashes, [], painted)).not.toBe(before);
    expect(turnsKey(angles, [], hashes, [], [{ ...painted[0]!, speaking: false }])).not.toBe(turnsKey(angles, [], hashes, [], painted));
  });
});

describe("speakerChoices", () => {
  const room = (speakers: { id: string; name: string }[] | undefined) =>
    [{ path: "transcripts/room.words.json", transcript: { asset: "assets/room.mp4", speakers } }] as never;
  const people = [
    { id: "s1", name: "Ana" },
    { id: "s2", name: "Ben" },
  ];

  it("lists the speakers of the transcript of the angle's own file", () => {
    expect(speakerChoices({ asset: "assets/room.mp4" }, undefined, room(people))).toEqual({ asset: "assets/room.mp4", speakers: people, off: null });
  });

  it("looks in the mic's file when the angle is heard through a mic", () => {
    const mics = [{ id: "lav", asset: "assets/room.mp4" }];
    expect(speakerChoices({ asset: "assets/cam.mp4", mic: "lav" }, mics, room(people))).toMatchObject({ asset: "assets/room.mp4", speakers: people, off: null });
    expect(speakerChoices({ asset: "assets/cam.mp4", mic: "lav" }, [], room(people))).toMatchObject({ asset: "assets/cam.mp4", speakers: [], off: "none" });
  });

  it("is off for screens, angles without sound and files without speakers, unless a speaker is set to clear", () => {
    expect(speakerChoices({ asset: "assets/room.mp4", screen: true }, undefined, room(people)).off).toBe("screen");
    expect(speakerChoices({ asset: "assets/room.mp4", mic: null }, undefined, room(people)).off).toBe("no-sound");
    expect(speakerChoices({ asset: "assets/room.mp4" }, undefined, room(undefined)).off).toBe("none");
    expect(speakerChoices({ asset: "assets/room.mp4" }, undefined, []).off).toBe("none");
    expect(speakerChoices({ asset: "assets/room.mp4", speaker: "s3" }, undefined, room(undefined)).off).toBeNull();
  });
});
