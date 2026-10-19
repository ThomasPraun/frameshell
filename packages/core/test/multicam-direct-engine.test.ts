import { ErrorCode, type JournalEntry, RpcError } from "@frameshell/protocol";
import { type DirectorRules, type ProgramTrack, type ShotClip, type Timeline, createTimeline } from "@frameshell/schema";
import { describe, expect, it } from "vitest";
import { type EditContext, type OperationRequest, type SourceInfo, applyOperation, applyPatch, humanShots } from "../src/index.js";

// `multicam.direct` through the engine: which shots give up their group time, the range, kept shots, and the inverse.
const SOURCES: Record<string, SourceInfo> = {
  "assets/ana.mp4": { duration: 40, video: true, audio: true },
  "assets/ben.mp4": { duration: 40, video: true, audio: true },
};

function context(): EditContext {
  let next = 100;
  return {
    fps: 30,
    source: async (asset) => {
      const info = SOURCES[asset];
      if (!info) throw new RpcError(ErrorCode.AssetNotFound, `${asset} not found`, { path: asset });
      return info;
    },
    nestedDuration: async () => 0,
    clipTypes: async () => new Map(),
    newId: (prefix) => `${prefix}_${String(++next).padStart(4, "0")}`,
  };
}

const RULES: DirectorRules = {
  minShot: 0,
  maxShot: null,
  cutLead: 0,
  twoShot: { exchange: null, overlap: null },
  wide: { silence: null, laughter: null, together: 3 },
  cutaway: { to: "listener", length: 2 },
  weights: {},
};

/** Ana speaks on even 5-second blocks of the group clock, Ben on odd ones. */
const TURNS = Array.from({ length: 8 }, (_, i) => ({ angle: i % 2 === 0 ? "ana" : "ben", start: i * 5, end: i * 5 + 5 }));

function talk(shots: ShotClip[]): Timeline {
  return {
    ...createTimeline("main"),
    groups: [
      {
        id: "g_talk",
        angles: [
          { id: "ana", name: "Ana", asset: "assets/ana.mp4", offset: 0 },
          { id: "ben", name: "Ben", asset: "assets/ben.mp4", offset: 0 },
        ],
      },
    ],
    tracks: [{ id: "t_p", kind: "program", group: "g_talk", clips: shots }],
  };
}

const grid = (id: string, start: number, from: number, to: number): ShotClip => ({ id, type: "shot", start, in: from, out: to, shot: "grid", angles: ["ana", "ben"] });

const direct = (args: Record<string, unknown> = {}) =>
  ({ op: "multicam.direct", args: { group: "g_talk", turns: TURNS, rules: RULES, keep: [], ...args } }) as OperationRequest;

const shots = (timeline: Timeline) => (timeline.tracks.find((track) => track.kind === "program") as ProgramTrack).clips;
/** `[start, in, out, layout, angles]` per shot. */
const placed = (timeline: Timeline) => shots(timeline).map((shot) => [shot.start, shot.in, shot.out, shot.shot, shot.angles.join(",")]);

async function rejection(promise: Promise<unknown>): Promise<RpcError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof RpcError) return error;
    throw error;
  }
  throw new Error("expected a rejection");
}

describe("multicam.direct", () => {
  it("replaces the shots with directed ones over the same group time, in one undoable operation", async () => {
    const before = talk([grid("c_all", 0, 0, 20)]);
    const applied = await applyOperation(before, direct(), context());
    expect(placed(applied.timeline)).toEqual([
      [0, 0, 5, "solo", "ana"],
      [5, 5, 10, "solo", "ben"],
      [10, 10, 15, "solo", "ana"],
      [15, 15, 20, "solo", "ben"],
    ]);
    expect(shots(applied.timeline).every((shot) => shot.confidence === 0.95 && shot.reason !== undefined)).toBe(true);
    expect(applied.changes.removed).toEqual(["c_all"]);
    expect(applied.changes.added).toHaveLength(4);
    expect(applyPatch(applied.timeline, applied.inverse.args).tracks).toEqual(before.tracks);
  });

  it("keeps what plays where after a cut: each stretch of the group is directed in place, gaps stay", async () => {
    // A cut removed group 8-12 s: the second shot plays group 12-20 from timeline 8; a gap follows.
    const before = talk([grid("c_a", 0, 0, 8), grid("c_b", 8, 12, 20), grid("c_c", 30, 25, 30)]);
    const applied = await applyOperation(before, direct(), context());
    expect(placed(applied.timeline)).toEqual([
      [0, 0, 5, "solo", "ana"],
      [5, 5, 8, "solo", "ben"],
      [8, 12, 15, "solo", "ana"],
      [11, 15, 20, "solo", "ben"],
      [30, 25, 30, "solo", "ben"],
    ]);
  });

  it("directs back-to-back shots that play on in the group as one stretch", async () => {
    const turns = [{ angle: "ana", start: 0, end: 10 }];
    const applied = await applyOperation(talk([grid("c_a", 0, 0, 4), grid("c_b", 4, 4, 10)]), direct({ turns }), context());
    expect(placed(applied.timeline)).toEqual([[0, 0, 10, "solo", "ana"]]);
  });

  it("leaves kept shots alone and directs around them", async () => {
    const human: ShotClip = { id: "c_mine", type: "shot", start: 5, in: 5, out: 10, shot: "solo", angles: ["ana"] };
    const before = talk([grid("c_a", 0, 0, 5), human, grid("c_b", 10, 10, 20)]);
    const applied = await applyOperation(before, direct({ keep: ["c_mine"] }), context());
    expect(shots(applied.timeline).find((shot) => shot.id === "c_mine")).toEqual(human);
    expect(placed(applied.timeline)).toEqual([
      [0, 0, 5, "solo", "ana"],
      [5, 5, 10, "solo", "ana"],
      [10, 10, 15, "solo", "ana"],
      [15, 15, 20, "solo", "ben"],
    ]);
  });

  it("directs only the range, splitting the shots it cuts through", async () => {
    const before = talk([{ ...grid("c_all", 0, 0, 20), confidence: 0.7, reason: "silence" }]);
    const applied = await applyOperation(before, direct({ from: 4, to: 12 }), context());
    expect(placed(applied.timeline)).toEqual([
      [0, 0, 4, "grid", "ana,ben"],
      [4, 4, 5, "solo", "ana"],
      [5, 5, 10, "solo", "ben"],
      [10, 10, 12, "solo", "ana"],
      [12, 12, 20, "grid", "ana,ben"],
    ]);
    const outside = shots(applied.timeline).filter((shot) => shot.shot === "grid");
    expect(outside.map((shot) => [shot.id, shot.confidence, shot.reason])).toEqual([
      ["c_all", 0.7, "silence"],
      [expect.stringMatching(/^c_/), 0.7, "silence"],
    ]);
  });

  it("fills an empty program track over the whole group", async () => {
    const applied = await applyOperation(talk([]), direct({ turns: [{ angle: "ben", start: 0, end: 40 }] }), context());
    expect(placed(applied.timeline)).toEqual([[0, 0, 40, "solo", "ben"]]);
  });

  it("gives the same shots for the same input", async () => {
    const before = talk([grid("c_all", 0, 0, 40)]);
    const first = await applyOperation(before, direct(), context());
    const second = await applyOperation(before, direct(), context());
    expect(first.timeline).toEqual(second.timeline);
    // Directing directed shots again changes no picture.
    const again = await applyOperation(first.timeline, direct(), context());
    expect(placed(again.timeline)).toEqual(placed(first.timeline));
  });

  it("refuses an unknown group, a reversed range and a range with nothing to direct", async () => {
    expect((await rejection(applyOperation(talk([]), direct({ group: "g_nope" }), context()))).message).toMatch(/no multicam group "g_nope".*g_talk/);
    expect((await rejection(applyOperation(talk([grid("c_a", 0, 0, 20)]), direct({ from: 8, to: 4 }), context()))).message).toMatch(/must be after/);
    const kept = await rejection(applyOperation(talk([grid("c_a", 0, 0, 20)]), direct({ keep: ["c_a"] }), context()));
    expect(kept.message).toMatch(/every shot there is one a person chose/);
    expect(kept.data).toMatchObject({ field: "replaceHuman" });
    expect((await rejection(applyOperation(talk([grid("c_a", 0, 0, 20)]), direct({ from: 25 }), context()))).message).toMatch(/no shot there/);
    // A person's shot elsewhere on the track does not make a range over a gap theirs.
    const gap = await rejection(applyOperation(talk([grid("c_a", 0, 0, 5), grid("c_b", 10, 10, 15)]), direct({ from: 6, to: 9, keep: ["c_b"] }), context()));
    expect(gap.message).toMatch(/no shot there/);
    expect(gap.data).toMatchObject({ field: "from" });
  });
});

describe("humanShots", () => {
  const entry = (op: string, author: string, args: Record<string, unknown>, clips: { id: string; clip: ShotClip | null }[]): JournalEntry => ({
    id: "op_00000001",
    op,
    args,
    author,
    tx: "tx_00000001",
    txLabel: null,
    revisionBefore: 0,
    revision: 1,
    at: "2026-10-19T00:00:00.000Z",
    hashBefore: "a",
    hash: "b",
    inverse: { op: "timeline.patch", args: { clips: clips.map((change) => ({ track: "t_p", ...change })) } },
  });
  const solo = (id: string, extra: Partial<ShotClip> = {}): ShotClip => ({ id, type: "shot", start: 0, in: 0, out: 5, shot: "solo", angles: ["ana"], ...extra });

  it("finds shots the app set and pieces split off them, while they carry no director confidence", () => {
    const track: ProgramTrack = {
      id: "t_p",
      kind: "program",
      group: "g_talk",
      clips: [solo("c_ui"), solo("c_piece"), solo("c_agent"), solo("c_redone", { confidence: 0.9, reason: "ana speaks" }), solo("c_moved")],
    };
    const journal = [
      entry("shot.set", "ui", { clip: "c_ui" }, [{ id: "c_ui", clip: solo("c_ui") }]),
      entry("clip.split", "cli:term-1", { clip: "c_ui", at: 2 }, [{ id: "c_ui", clip: solo("c_ui") }, { id: "c_piece", clip: null }]),
      entry("shot.set", "agent:claude:term-1", { clip: "c_agent" }, [{ id: "c_agent", clip: solo("c_agent") }]),
      entry("shot.set", "ui", { clip: "c_redone" }, [{ id: "c_redone", clip: solo("c_redone") }]),
      entry("clip.move", "ui", { clip: "c_moved", start: 9 }, [{ id: "c_moved", clip: solo("c_moved") }]),
    ];
    expect(humanShots(journal, track)).toEqual(["c_ui", "c_piece"]);
  });

  it("passes nothing on to pieces of a shot a ripple cut only moved", () => {
    // Split grid G at 10 s, the app set G2, then a 5-8 s cut inside G moved G2 and left G's right piece G3.
    const track: ProgramTrack = {
      id: "t_p",
      kind: "program",
      group: "g_talk",
      clips: [grid("c_g", 0, 0, 5), grid("c_g3", 5, 8, 10), solo("c_g2", { start: 7, in: 10, out: 20, angles: ["ben"] })],
    };
    const journal = [
      entry("clip.split", "cli:term-1", { clip: "c_g", at: 10 }, [{ id: "c_g", clip: grid("c_g", 0, 0, 20) }, { id: "c_g2", clip: null }]),
      entry("shot.set", "ui", { clip: "c_g2" }, [{ id: "c_g2", clip: grid("c_g2", 10, 10, 20) }]),
      entry("cut", "cli:term-1", { from: 5, to: 8 }, [
        { id: "c_g", clip: grid("c_g", 0, 0, 10) },
        { id: "c_g2", clip: solo("c_g2", { start: 10, in: 10, out: 20, angles: ["ben"] }) },
        { id: "c_g3", clip: null },
      ]),
    ];
    expect(humanShots(journal, track)).toEqual(["c_g2"]);
  });

  it("hands shots back to the director after --replace-human and an agent's shot set", () => {
    const track: ProgramTrack = {
      id: "t_p",
      kind: "program",
      group: "g_talk",
      clips: [solo("c_d1"), solo("c_d2", { start: 5, in: 5, out: 10, confidence: 0.9, reason: "ben speaks" }), solo("c_back", { start: 10, in: 10, out: 15 })],
    };
    const directed = (id: string, start: number) => solo(id, { start, in: start, out: start + 5, confidence: 0.9, reason: "speaks" });
    const journal = [
      entry("shot.set", "ui", { clip: "c_h" }, [{ id: "c_h", clip: grid("c_h", 0, 0, 10) }]),
      entry("shot.set", "ui", { clip: "c_back" }, [{ id: "c_back", clip: solo("c_back", { start: 10, in: 10, out: 15 }) }]),
      entry("multicam.direct", "cli:term-1", { group: "g_talk", keep: [] }, [
        { id: "c_h", clip: solo("c_h", { out: 10, shot: "two-up", angles: ["ana", "ben"] }) },
        { id: "c_d1", clip: null },
        { id: "c_d2", clip: null },
      ]),
      entry("shot.set", "agent:claude:term-1", { clip: "c_d1" }, [{ id: "c_d1", clip: directed("c_d1", 0) }]),
      entry("shot.set", "agent:claude:term-1", { clip: "c_back" }, [{ id: "c_back", clip: solo("c_back", { start: 10, in: 10, out: 15, shot: "grid" }) }]),
    ];
    expect(humanShots(journal, track)).toEqual([]);
  });
});
