import { ErrorCode, RpcError, parseParams } from "@frameshell/protocol";
import { type MulticamGroup, type ProgramTrack, type ShotClip, type Timeline, createTimeline } from "@frameshell/schema";
import { describe, expect, it } from "vitest";
import { type EditContext, type EditPoint, type OperationRequest, type SourceInfo, applyOperation, applyPatch, diffTimelines } from "../src/index.js";

// Program tracks through the engine (ADR 0016): the same operations as any clip track, with shots on the group clock.

const SOURCES: Record<string, SourceInfo> = {
  "assets/ana.mp4": { duration: 20, video: true, audio: true },
  "assets/ben.mp4": { duration: 18, video: true, audio: true },
  "assets/mic.wav": { duration: 20, video: false, audio: true },
  "assets/talk.mp4": { duration: 30, video: true, audio: true },
  "assets/short.mp4": { duration: 10, video: true, audio: true },
};

function context(overrides: Partial<EditContext> = {}): EditContext {
  let next = 0;
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
    ...overrides,
  };
}

function op(name: OperationRequest["op"], args: Record<string, unknown>): OperationRequest {
  if (name === "timeline.patch") return { op: name, args } as OperationRequest;
  const { cwd: _cwd, timeline: _timeline, ...parsed } = parseParams(name, { cwd: process.cwd(), ...args }) as Record<string, unknown>;
  return { op: name, args: parsed } as OperationRequest;
}

const apply = (timeline: Timeline, name: OperationRequest["op"], args: Record<string, unknown>, ctx = context()) =>
  applyOperation(timeline, op(name, args), ctx);

async function rejection(promise: Promise<unknown>): Promise<RpcError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof RpcError) return error;
    throw error;
  }
  throw new Error("expected a rejection");
}

// Ben's file starts 2 s into the group clock; the group ends at 20 s (Ana), Ben's at 20 s too.
const GROUP: MulticamGroup = {
  id: "g_talk",
  angles: [
    { id: "ana", name: "Ana", asset: "assets/ana.mp4", offset: 0 },
    { id: "ben", name: "Ben", asset: "assets/ben.mp4", offset: 2 },
  ],
};

const shot = (id: string, start: number, from: number, to: number, layout: ShotClip["shot"], angles: string[]): ShotClip => ({
  id,
  type: "shot",
  start,
  in: from,
  out: to,
  shot: layout,
  angles,
});

/** Program track t_p (0-4 Ana, 4-8 both, 8-12 Ben) over a music track t_a, both 12 s. */
function base(): Timeline {
  return {
    ...createTimeline("main"),
    tracks: [
      { id: "t_p", kind: "program", group: "g_talk", clips: [shot("c_s1", 0, 0, 4, "solo", ["ana"]), shot("c_s2", 4, 4, 8, "two-up", ["ana", "ben"]), shot("c_s3", 8, 8, 12, "solo", ["ben"])] },
      { id: "t_a", kind: "audio", clips: [{ id: "c_m", type: "media", asset: "assets/mic.wav", start: 0, in: 0, out: 12 }] },
    ],
    groups: [GROUP],
  };
}

const shots = (timeline: Timeline): ShotClip[] => (timeline.tracks.find((track) => track.kind === "program") as ProgramTrack).clips;

describe("ripple cut over a program track", () => {
  it("cuts shots like any clip: trims, splits on the group clock, shifts the rest", async () => {
    const { timeline, inverse } = await apply(base(), "cut", { from: 3, to: 5, snap: false });
    expect(shots(timeline)).toEqual([
      shot("c_s1", 0, 0, 3, "solo", ["ana"]),
      shot("c_s2", 3, 5, 8, "two-up", ["ana", "ben"]),
      shot("c_s3", 6, 8, 12, "solo", ["ben"]),
    ]);
    expect((timeline.tracks[1] as { clips: unknown[] }).clips).toEqual([
      { id: "c_m", type: "media", asset: "assets/mic.wav", start: 0, in: 0, out: 3 },
      { id: "c_0001", type: "media", asset: "assets/mic.wav", start: 3, in: 5, out: 12 },
    ]);
    const undone = await applyOperation(timeline, inverse, context());
    expect(undone.timeline.tracks).toEqual(base().tracks);
  });

  it("splits a shot the cut falls inside", async () => {
    const { timeline } = await apply(base(), "cut", { from: 5, to: 6, snap: false, tracks: ["t_p"] });
    expect(shots(timeline)).toEqual([
      shot("c_s1", 0, 0, 4, "solo", ["ana"]),
      shot("c_s2", 4, 4, 5, "two-up", ["ana", "ben"]),
      shot("c_0001", 5, 6, 8, "two-up", ["ana", "ben"]),
      shot("c_s3", 7, 8, 12, "solo", ["ben"]),
    ]);
  });

  it("gives the snapper the angles' sound under the shots, not the shots", async () => {
    const seen: EditPoint[] = [];
    const ctx = context({
      resolveEditPoint: (point) => {
        seen.push(point);
        return null;
      },
    });
    await apply(base(), "cut", { from: 1, to: 2, tracks: ["t_p"] }, ctx);
    expect(seen[0]!.clips!.map((clip) => [clip.id, clip.start, "asset" in clip ? clip.asset : null])).toEqual([
      ["c_s1/ana", 0, "assets/ana.mp4"],
      ["c_s1/ben", 2, "assets/ben.mp4"],
      ["c_s2/ana", 4, "assets/ana.mp4"],
      ["c_s2/ben", 4, "assets/ben.mp4"],
      ["c_s3/ana", 8, "assets/ana.mp4"],
      ["c_s3/ben", 8, "assets/ben.mp4"],
    ]);
  });
});

describe("shot edits", () => {
  it("trims a shot by group time or timeline time, never snapped", async () => {
    let snapped = 0;
    const ctx = context({
      resolveEditPoint: () => {
        snapped++;
        return null;
      },
    });
    const head = await apply(base(), "clip.trim", { clip: "c_s3", in: 9 }, ctx);
    expect(shots(head.timeline)[2]).toEqual(shot("c_s3", 9, 9, 12, "solo", ["ben"]));
    const tail = await apply(base(), "clip.trim", { clip: "c_s1", end: 3.5 }, ctx);
    expect(shots(tail.timeline)[0]).toEqual(shot("c_s1", 0, 0, 3.5, "solo", ["ana"]));
    expect(snapped).toBe(0);
    expect(head.snaps).toEqual([]);
  });

  it("ripple-trims a shot: later clips on every track move", async () => {
    const { timeline } = await apply(base(), "clip.trim", { clip: "c_s3", out: 14, ripple: true });
    expect(shots(timeline)[2]).toEqual(shot("c_s3", 8, 8, 14, "solo", ["ben"]));
    const rippled = await apply(base(), "clip.trim", { clip: "c_s1", out: 3, ripple: true });
    expect(shots(rippled.timeline).map((s) => s.start)).toEqual([0, 3, 7]);
  });

  it("refuses a shot past the group's end with the valid range", async () => {
    const error = await rejection(apply(base(), "clip.trim", { clip: "c_s3", out: 21 }));
    expect(error.code).toBe(ErrorCode.InvalidOperation);
    expect(error.message).toContain("shot c_s3 plays group g_talk to 21 s, past its end (20 s). Valid out: 8.033 to 20 s.");
  });

  it("refuses a head extension before group time 0, and an emptied shot", async () => {
    const late = { ...base(), tracks: [{ ...(base().tracks[0] as ProgramTrack), clips: [shot("c_s1", 2, 1, 4, "solo", ["ana"])] }] };
    const error = await rejection(apply(late, "clip.trim", { clip: "c_s1", start: 0 }));
    expect(error.message).toContain("the head cannot extend before source time 0 or timeline time 0. Valid start: 1 to 4.967 s.");
    const empty = await rejection(apply(base(), "clip.trim", { clip: "c_s1", out: 0 }));
    expect(empty.message).toMatch(/the shot would be empty/);
  });

  it("splits a shot: both parts keep layout and angles, the right one continues the group clock", async () => {
    const { timeline } = await apply(base(), "clip.split", { clip: "c_s2", at: 5 });
    expect(shots(timeline).slice(1, 3)).toEqual([shot("c_s2", 4, 4, 5, "two-up", ["ana", "ben"]), shot("c_0001", 5, 5, 8, "two-up", ["ana", "ben"])]);
  });

  it("moves shots along their track, refuses overlaps and other tracks", async () => {
    const gap = await apply(base(), "clip.remove", { clip: "c_s2" });
    const moved = await apply(gap.timeline, "clip.move", { clip: "c_s1", start: 4 });
    expect(shots(moved.timeline)[0]!.start).toBe(4);
    const overlap = await rejection(apply(base(), "clip.move", { clip: "c_s1", start: 1 }));
    expect(overlap.message).toMatch(/would overlap on track t_p/);
    const away = await rejection(apply(base(), "clip.move", { clip: "c_s1", track: "t_a" }));
    expect(away.message).toMatch(/c_s1 is on a program track; t_a is a audio track/);
  });

  it("sets a shot's scriptRef, refuses sound and picture settings, naming the angle gain", async () => {
    const { timeline } = await apply(base(), "clip.set", { clip: "c_s1", scriptRef: "scripts/script.md#intro" });
    expect(shots(timeline)[0]!.scriptRef).toBe("scripts/script.md#intro");
    const gain = await rejection(apply(base(), "clip.set", { clip: "c_s1", gain: -3 }));
    expect(gain.code).toBe(ErrorCode.InvalidOperation);
    expect(gain.message).toMatch(/shots take no `gain`.*gain, set on the angle/);
    const transform = await rejection(apply(base(), "clip.set", { clip: "c_s1", transform: { scale: 0.5 } }));
    expect(transform.message).toMatch(/shots take no `transform`/);
  });

  it("takes only shots on a program track with clip.add, and shot clips nowhere else", async () => {
    const error = await rejection(apply(base(), "clip.add", { track: "t_p", asset: "assets/talk.mp4" }));
    expect(error.code).toBe(ErrorCode.InvalidOperation);
    expect(error.message).toMatch(/holds shots only/);
    const typed = await rejection(apply(base(), "clip.add", { track: "t_a", type: "shot", duration: 1 }));
    expect(typed.code).toBe(ErrorCode.InvalidOperation);
    expect(typed.message).toMatch(/shot clips belong on a program track/);
  });

  it("refuses a subtitle track following a program track", async () => {
    const error = await rejection(apply(base(), "track.add", { kind: "subtitles", follows: "t_p" }));
    expect(error.message).toMatch(/`follows` must name a video or audio track; t_p is a program track/);
  });

  it("removes a program track only with force; its group stays", async () => {
    const refused = await rejection(apply(base(), "track.remove", { track: "t_p" }));
    expect(refused.message).toMatch(/has 3 clip\(s\)/);
    const { timeline } = await apply(base(), "track.remove", { track: "t_p", force: true });
    expect(timeline.tracks.map((track) => track.id)).toEqual(["t_a"]);
    expect(timeline.groups).toEqual([GROUP]);
  });
});

describe("groups in patches and inverses", () => {
  it("diffs and applies whole groups; the last one gone drops `groups`", () => {
    const before = base();
    const after = { ...base(), groups: [{ ...GROUP, angles: [GROUP.angles[0]!, { ...GROUP.angles[1]!, offset: 2.5 }] }] };
    const patch = diffTimelines(before, after);
    expect(patch).toEqual({ groups: [{ id: "g_talk", group: after.groups[0] }] });
    expect(applyPatch(before, patch)).toEqual(after);
    const audioOnly = { ...base(), tracks: [base().tracks[1]!] };
    const { groups: _dropped, ...ungrouped } = audioOnly;
    expect(applyPatch(audioOnly, diffTimelines(audioOnly, ungrouped))).toEqual(ungrouped);
  });

  it("applies a group change as an operation: shots are checked against it, its inverse restores it", async () => {
    const offset = { ...GROUP, angles: [GROUP.angles[0]!, { ...GROUP.angles[1]!, offset: 2.5 }] };
    const result = await apply(base(), "timeline.patch", { groups: [{ id: "g_talk", group: offset }] });
    expect(result.timeline.groups).toEqual([offset]);
    expect(result.changes).toMatchObject({ added: [], updated: ["g_talk"], removed: [], range: { from: 0, to: 12 } });
    const undone = await applyOperation(result.timeline, result.inverse, context());
    expect(undone.timeline.groups).toEqual([GROUP]);
  });

  it("refuses a group change that leaves a shot past the group's end, or a shot on an angle without a picture", async () => {
    const short = { ...GROUP, angles: GROUP.angles.map((angle) => ({ ...angle, asset: "assets/short.mp4", offset: 0 })) };
    const error = await rejection(apply(base(), "timeline.patch", { groups: [{ id: "g_talk", group: short }] }));
    expect(error.message).toContain("shot c_s3 plays group g_talk to 12 s, past its end (10 s). Valid out: 8.033 to 10 s.");
    const blind = { ...GROUP, angles: [{ ...GROUP.angles[0]!, asset: "assets/mic.wav" }, GROUP.angles[1]!] };
    const noPicture = await rejection(apply(base(), "timeline.patch", { groups: [{ id: "g_talk", group: blind }] }));
    expect(noPicture.message).toMatch(/shot c_s1 shows angle ana, but assets\/mic.wav has no video stream/);
  });

  it("refuses removing a group a program track shows", async () => {
    const error = await rejection(apply(base(), "timeline.patch", { groups: [{ id: "g_talk", group: null }] }));
    expect(error.message).toMatch(/must name a multicam group in `groups`, got "g_talk"/);
  });

  it("keeps every inverse exact over random shot edits", async () => {
    let seed = 7;
    const rand = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
    let timeline = base();
    let applied = 0;
    for (let step = 0; step < 120; step++) {
      const ids = shots(timeline).map((s) => s.id);
      const clip = ids[Math.floor(rand() * ids.length)];
      const at = Math.round(rand() * 14 * 30) / 30;
      const choices: [OperationRequest["op"], Record<string, unknown>][] = [
        ["cut", { from: at, to: at + 0.5, snap: false }],
        ["clip.split", { clip, at }],
        ["clip.trim", { clip, end: at }],
        ["clip.trim", { clip, start: at, ripple: true }],
        ["clip.move", { clip, start: at }],
      ];
      if (clip === undefined) break;
      const [name, args] = choices[Math.floor(rand() * choices.length)]!;
      let result;
      try {
        result = await apply(timeline, name, args);
      } catch (error) {
        expect(error).toBeInstanceOf(RpcError);
        continue;
      }
      applied++;
      const undone = await applyOperation(result.timeline, result.inverse, context());
      expect(undone.timeline.tracks).toEqual(timeline.tracks);
      expect(undone.timeline.groups).toEqual(timeline.groups);
      timeline = result.timeline;
    }
    expect(applied).toBeGreaterThan(20);
  });
});
