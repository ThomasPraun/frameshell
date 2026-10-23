import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type MediaProbe, type TimelinePatch } from "@frameshell/protocol";
import { type Timeline, createProjectConfig, createTimeline } from "@frameshell/schema";
import { describe, expect, it } from "vitest";
import { overlappingIds } from "../src/history/revert.js";
import type { OperationRequest } from "../src/timeline/engine.js";
import { type ProposalChange, TimelineService } from "../src/timeline/service.js";
import { tempDir } from "./helpers.js";

// Seam under test: TimelineService with review mode on (ADR 0019 §7), clips on a real project directory and a fake
// probe: which edits by the person rebase a proposal and which make it stale. Keys are the ones `planRevert` uses.

const PROBE: MediaProbe = {
  duration: 10,
  format: "mov,mp4",
  video: { codec: "h264", width: 320, height: 240, fps: 30, vfr: false, still: false },
  audio: null,
};

function setup() {
  const root = tempDir();
  mkdirSync(join(root, "timelines"));
  mkdirSync(join(root, "assets"));
  writeFileSync(join(root, "assets", "a.mp4"), "stub");
  writeFileSync(join(root, "frameshell.json"), JSON.stringify(createProjectConfig("Test")));
  writeFileSync(join(root, "timelines", "main.json"), JSON.stringify({ ...createTimeline("main"), tracks: [{ id: "t_v", kind: "video", clips: [] }] }));
  let next = 0;
  const changes: ProposalChange[] = [];
  let review = false;
  const timelines = new TimelineService({
    probe: async () => PROBE,
    clipTypes: async () => new Map(),
    newId: (prefix) => `${prefix}_${++next}`,
    reviewEnabled: async () => review,
    onProposal: (change) => changes.push(change),
  });
  const apply = (author: string, tx: string, request: OperationRequest) =>
    timelines.apply({ root, cwd: root, timeline: "main", author, tx: { id: tx, label: null }, request });
  const add = (author: string, tx: string, start: number) =>
    apply(author, tx, { op: "clip.add", args: { track: "t_v", type: "media", asset: "assets/a.mp4", start, in: 0, out: 2 } });
  const file = () => JSON.parse(readFileSync(join(root, "timelines", "main.json"), "utf8")) as Timeline;
  const starts = (timeline: Timeline) => (timeline.tracks[0]!.kind === "subtitles" ? [] : timeline.tracks[0]!.clips.map((clip) => [clip.id, clip.start]));
  return {
    root,
    timelines,
    apply,
    add,
    file,
    starts,
    changes,
    turnOn: () => {
      review = true;
    },
  };
}

describe("review mode rebase on clips", () => {
  it("rebases when the person edits another clip, replaying the proposal on top", async () => {
    const { root, timelines, add, apply, file, starts, turnOn } = setup();
    await add("ui", "tx_00000001", 0); // c_1
    await add("ui", "tx_00000002", 4); // c_2
    turnOn();
    await apply("cli", "tx_000000a1", { op: "clip.move", args: { clip: "c_1", start: 1 } });
    await timelines.ready("tx_000000a1");
    await apply("ui", "tx_00000003", { op: "clip.move", args: { clip: "c_2", start: 6 } });
    expect((await timelines.proposal(root))).toMatchObject({ tx: "tx_000000a1", state: "ready" });
    expect(starts((await timelines.viewTimeline(root, "main", "proposal")).timeline)).toEqual([["c_1", 1], ["c_2", 6]]);
    await timelines.acceptProposal(root, "tx_000000a1");
    expect(starts(file())).toEqual([["c_1", 1], ["c_2", 6]]);
  });

  it("goes stale when the person edits the same clip", async () => {
    const { root, timelines, add, apply, file, starts, turnOn, changes } = setup();
    await add("ui", "tx_00000001", 0);
    turnOn();
    await apply("cli", "tx_000000a1", { op: "clip.move", args: { clip: "c_1", start: 1 } });
    await timelines.ready("tx_000000a1");
    await apply("ui", "tx_00000002", { op: "clip.trim", args: { clip: "c_1", out: 1 } });
    expect(await timelines.proposal(root)).toBeNull();
    expect(changes.at(-1)).toMatchObject({ tx: "tx_000000a1", state: "stale", conflicts: ["c_1"], endsTx: false });
    expect(starts(file())).toEqual([["c_1", 0]]);
  });

  it("goes stale when replaying on the person's edit breaks a timeline rule, naming what the operation touches", async () => {
    const { root, timelines, add, apply, turnOn, changes } = setup();
    await add("ui", "tx_00000001", 0); // c_1 0..2
    turnOn();
    await add("cli", "tx_000000a1", 4); // proposed c_2 4..6
    await timelines.ready("tx_000000a1");
    // The person moves c_1 where the proposed clip sits: different keys, but the replay overlaps.
    await apply("ui", "tx_00000002", { op: "clip.move", args: { clip: "c_1", start: 4 } });
    expect(await timelines.proposal(root)).toBeNull();
    expect(changes.at(-1)).toMatchObject({ state: "stale", conflicts: ["c_2"] });
  });
});

describe("overlappingIds", () => {
  const clip = (id: string, start: number) => ({ id, type: "media", asset: "assets/a.mp4", start, in: 0, out: 1 });
  const state = { ...createTimeline("main"), tracks: [{ id: "t_v", kind: "video", clips: [clip("c_1", 0), clip("c_2", 2)] }] } as Timeline;
  const upsert = (id: string, start: number): TimelinePatch => ({ clips: [{ track: "t_v", id, clip: clip(id, start) as never }] });
  const rewrite: TimelinePatch = { tracks: [{ id: "t_v", track: state.tracks[0]! }] };

  it("sees no overlap between edits of different clips", () => {
    expect(overlappingIds([upsert("c_1", 1)], [upsert("c_2", 3)], [state])).toEqual([]);
  });

  it("names a clip both sides changed", () => {
    expect(overlappingIds([upsert("c_1", 1)], [upsert("c_1", 3)], [state])).toEqual(["c_1"]);
  });

  it("counts a whole-track rewrite as touching the clips on it", () => {
    expect(overlappingIds([upsert("c_1", 1)], [rewrite], [state])).toEqual(["c_1", "t_v"]);
  });
});
