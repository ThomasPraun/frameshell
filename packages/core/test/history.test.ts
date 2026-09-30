import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ErrorCode, type MediaProbe, RpcError } from "@frameshell/protocol";
import { createProjectConfig, createTimeline } from "@frameshell/schema";
import { describe, expect, it } from "vitest";
import { ProjectRegistry } from "../src/projects.js";
import type { OperationRequest } from "../src/timeline/engine.js";
import { TimelineService } from "../src/timeline/service.js";
import { tempDir } from "./helpers.js";

// Seam under test: TimelineService (apply, history, revert) on a real project
// directory; the journal is observed through `history` and, for its on-disk
// contract, the `.frameshell/history/<timeline>.jsonl` file itself.

const PROBE: MediaProbe = {
  duration: 10,
  format: "mov,mp4",
  video: { codec: "h264", width: 320, height: 240, fps: 30, vfr: false, still: false },
  audio: null,
};

function project(): string {
  const root = tempDir();
  mkdirSync(join(root, "timelines"));
  mkdirSync(join(root, "assets"));
  writeFileSync(join(root, "assets", "a.mp4"), "stub");
  writeFileSync(join(root, "frameshell.json"), JSON.stringify(createProjectConfig("Test")));
  const timeline = { ...createTimeline("main"), tracks: [{ id: "t_v", kind: "video", clips: [] }] };
  writeFileSync(join(root, "timelines", "main.json"), JSON.stringify(timeline));
  return root;
}

function setup() {
  const root = project();
  let next = 0;
  const timelines = new TimelineService({
    probe: async () => PROBE,
    clipTypes: async () => new Map(),
    newId: (prefix) => `${prefix}_${++next}`,
  });
  const apply = (author: string, tx: string, request: OperationRequest, label: string | null = null) =>
    timelines.apply({ root, cwd: root, timeline: "main", author, tx: { id: tx, label }, request });
  const add = (author: string, tx: string, start: number) =>
    apply(author, tx, { op: "clip.add", args: { track: "t_v", type: "media", asset: "assets/a.mp4", start, in: 0, out: 2 } });
  const revert = (author: string, tx: string, target: string) =>
    timelines.revert({ root, cwd: root, timeline: "main", author, tx: { id: tx, label: null }, target });
  const tracks = () => JSON.parse(readFileSync(join(root, "timelines", "main.json"), "utf8")).tracks;
  return { root, timelines, apply, add, revert, tracks };
}

async function rejection(promise: Promise<unknown>): Promise<RpcError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof RpcError) return error;
    throw error;
  }
  throw new Error("expected a rejection");
}

describe("operation journal", () => {
  it("appends every operation with its author, transaction and revisions to .frameshell/history/<timeline>.jsonl", async () => {
    const { root, add, apply } = setup();
    const first = await add("cli:agent", "tx_0000000a", 0);
    await apply("plugin:titles", "tx_0000000b", { op: "clip.set", args: { clip: "c_1", gain: -6 } }, "loudness");
    await apply("ui", "tx_0000000c", { op: "clip.move", args: { clip: "c_1", start: 1 } });

    expect(first.operation).toMatchObject({ id: expect.stringMatching(/^op_[0-9a-f]{8}$/), author: "cli:agent", tx: "tx_0000000a" });
    const lines = readFileSync(join(root, ".frameshell", "history", "main.jsonl"), "utf8").trimEnd().split("\n");
    const entries = lines.map((line) => JSON.parse(line));
    expect(entries.map((e) => [e.op, e.author, e.tx, e.txLabel, e.revisionBefore, e.revision])).toEqual([
      ["clip.add", "cli:agent", "tx_0000000a", null, 0, 1],
      ["clip.set", "plugin:titles", "tx_0000000b", "loudness", 1, 2],
      ["clip.move", "ui", "tx_0000000c", null, 2, 3],
    ]);
    expect(entries[0]).toMatchObject({ id: first.operation.id, inverse: { op: "timeline.patch" }, at: expect.any(String) });
    // Content hashes chain: each entry starts from what the previous one wrote.
    expect(entries[0].hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(entries.slice(1).map((e) => e.hashBefore)).toEqual(entries.slice(0, -1).map((e) => e.hash));
  });

  it("lists history grouped by transaction, and only what came after a transaction with `since`", async () => {
    const { root, timelines, add, apply } = setup();
    const agentTx = "tx_000000a1";
    await add("cli:agent", agentTx, 0);
    await add("cli:agent", agentTx, 3);
    await apply("ui", "tx_000000b1", { op: "clip.set", args: { clip: "c_2", muted: true } });
    await apply("ui", "tx_000000b2", { op: "clip.move", args: { clip: "c_1", start: 6 } });

    const all = await timelines.history(root, "main", {});
    expect(all.revision).toBe(4);
    expect(all.transactions.map((t) => [t.tx, t.author, t.operations.length])).toEqual([
      [agentTx, "cli:agent", 2],
      ["tx_000000b1", "ui", 1],
      ["tx_000000b2", "ui", 1],
    ]);

    const since = await timelines.history(root, "main", { since: agentTx });
    expect(since.since).toBe(agentTx);
    expect(since.transactions.flatMap((t) => t.operations.map((o) => [o.author, o.op, o.touched]))).toEqual([
      ["ui", "clip.set", ["c_2"]],
      ["ui", "clip.move", ["c_1"]],
    ]);

    const unknown = await rejection(timelines.history(root, "main", { since: "tx_ffffffff" }));
    expect(unknown.code).toBe(ErrorCode.HistoryNotFound);
    expect(unknown.data).toMatchObject({ target: "tx_ffffffff", timeline: "main" });
  });

  it("returns an empty history for a timeline that has no journal yet", async () => {
    const { root, timelines } = setup();
    expect(await timelines.history(root, "main", {})).toEqual({ timeline: "main", revision: null, since: null, transactions: [] });
  });
});

describe("revert", () => {
  it("undoes a whole transaction, restoring the exact state before it, as a new journaled operation", async () => {
    const { root, timelines, add, apply, revert, tracks } = setup();
    await add("ui", "tx_00000001", 0);
    const before = tracks();
    const tx = "tx_000000a1";
    await add("cli:agent", tx, 3);
    await apply("cli:agent", tx, { op: "clip.split", args: { clip: "c_1", at: 1 } });
    await apply("cli:agent", tx, { op: "cut", args: { from: 0.5, to: 1.5 } });
    expect(tracks()).not.toEqual(before);

    const reverted = await revert("cli:agent", "tx_000000a2", tx);
    expect(tracks()).toEqual(before);
    expect(reverted).toMatchObject({ revision: 5, operation: { op: "revert", args: { target: tx }, revisionBefore: 4 } });

    const history = await timelines.history(root, "main", { since: tx });
    expect(history.transactions).toEqual([
      expect.objectContaining({ tx: "tx_000000a2", operations: [expect.objectContaining({ op: "revert", revision: 5 })] }),
    ]);
  });

  it("undoes a single operation and leaves the others of its transaction", async () => {
    const { add, apply, revert, tracks } = setup();
    const tx = "tx_000000a1";
    await add("cli:agent", tx, 0);
    const afterAdd = tracks();
    const set = await apply("cli:agent", tx, { op: "clip.set", args: { clip: "c_1", gain: -12 } });
    await revert("ui", "tx_000000b1", set.operation.id);
    expect(tracks()).toEqual(afterAdd);
  });

  it("refuses when a later operation changed the same clips, naming it, and reverts once that one is undone", async () => {
    const { add, apply, revert, tracks } = setup();
    const agentTx = "tx_000000a1";
    await add("cli:agent", agentTx, 0);
    await add("cli:agent", agentTx, 4);
    const before = tracks();
    const trim = await apply("cli:agent", "tx_000000a2", { op: "clip.trim", args: { clip: "c_1", out: 1 } });
    const human = await apply("ui", "tx_000000b1", { op: "clip.move", args: { clip: "c_1", start: 2 } });
    await apply("ui", "tx_000000b2", { op: "clip.set", args: { clip: "c_2", gain: -3 } });

    const conflict = await rejection(revert("cli:agent", "tx_000000a3", "tx_000000a2"));
    expect(conflict.code).toBe(ErrorCode.RevertConflict);
    expect(conflict.message).toMatch(new RegExp(`${human.operation.id}.*clip\\.move.*ui.*c_1`, "s"));
    expect(conflict.data).toMatchObject({
      target: "tx_000000a2",
      conflicts: [{ id: human.operation.id, op: "clip.move", author: "ui", tx: "tx_000000b1", ids: ["c_1"] }],
    });

    await revert("cli:agent", "tx_000000a3", human.operation.id);
    await revert("cli:agent", "tx_000000a4", trim.operation.tx);
    await revert("cli:agent", "tx_000000a5", "tx_000000b2");
    expect(tracks()).toEqual(before);
  });

  it("treats reverting twice as a conflict with the first revert", async () => {
    const { add, revert } = setup();
    const added = await add("cli:agent", "tx_000000a1", 0);
    const first = await revert("ui", "tx_000000b1", added.operation.id);
    const again = await rejection(revert("ui", "tx_000000b2", added.operation.id));
    expect(again.data).toMatchObject({ conflicts: [{ id: first.operation.id, op: "revert" }] });
  });

  it("refuses when the timeline file changed outside the journal", async () => {
    const { root, add, revert } = setup();
    const added = await add("cli:agent", "tx_000000a1", 0);
    const path = join(root, "timelines", "main.json");
    const edited = JSON.parse(readFileSync(path, "utf8"));
    writeFileSync(path, JSON.stringify({ ...edited, revision: edited.revision + 1 }));
    const error = await rejection(revert("ui", "tx_000000b1", added.operation.tx));
    expect(error.code).toBe(ErrorCode.RevertConflict);
    expect(error.message).toMatch(/changed outside/);
  });

  // `file.write` is the desktop editor's save path; it validates but keeps `revision`.
  const humanSave = async (root: string, edit: (timeline: { revision: number; tracks: { clips: { start: number }[] }[] }) => void) => {
    const path = join(root, "timelines", "main.json");
    const timeline = JSON.parse(readFileSync(path, "utf8"));
    edit(timeline);
    await new ProjectRegistry().writeFile(path, JSON.stringify(timeline));
  };

  it("refuses when a file.write save kept the revision but changed the content", async () => {
    const { root, add, apply, revert, tracks } = setup();
    await add("cli:agent", "tx_000000a1", 0);
    const move = await apply("cli:agent", "tx_000000a1", { op: "clip.move", args: { clip: "c_1", start: 1 } });
    await humanSave(root, (timeline) => {
      timeline.tracks[0]!.clips[0]!.start = 5;
    });

    const error = await rejection(revert("cli:agent", "tx_000000a2", move.operation.id));
    expect(error.code).toBe(ErrorCode.RevertConflict);
    expect(error.message).toMatch(/changed outside the journal/);
    expect(error.data).toMatchObject({ conflicts: [] });
    expect(tracks()[0].clips[0].start).toBe(5);
  });

  it("refuses when an unjournaled edit is followed by journaled operations", async () => {
    const { root, add, apply, revert, tracks } = setup();
    await add("cli:agent", "tx_000000a1", 0);
    const move = await apply("cli:agent", "tx_000000a1", { op: "clip.move", args: { clip: "c_1", start: 1 } });
    await humanSave(root, (timeline) => {
      timeline.tracks[0]!.clips[0]!.start = 5;
      timeline.revision += 1;
    });
    await apply("ui", "tx_000000b1", { op: "track.add", args: { kind: "video" } });

    const error = await rejection(revert("cli:agent", "tx_000000a2", move.operation.tx));
    expect(error.code).toBe(ErrorCode.RevertConflict);
    expect(error.message).toMatch(new RegExp(`changed outside the journal between ${move.operation.id}`));
    expect(tracks()[0].clips[0].start).toBe(5);
  });

  it("refuses to cross an operation whose journal append was lost", async () => {
    const { root, add, apply, revert, tracks } = setup();
    const added = await add("cli:agent", "tx_000000a1", 0);
    await apply("ui", "tx_000000b1", { op: "clip.move", args: { clip: "c_1", start: 5 } });
    const journal = join(root, ".frameshell", "history", "main.jsonl");
    const lines = readFileSync(journal, "utf8").trimEnd().split("\n");
    writeFileSync(journal, `${lines.slice(0, -1).join("\n")}\n`);
    await apply("ui", "tx_000000b2", { op: "track.add", args: { kind: "video" } });

    const error = await rejection(revert("cli:agent", "tx_000000a2", added.operation.id));
    expect(error.code).toBe(ErrorCode.RevertConflict);
    expect(tracks()[0].clips[0].start).toBe(5);
  });

  it("still reverts when the unjournaled edit came before the target", async () => {
    const { root, add, apply, revert, tracks } = setup();
    await add("cli:agent", "tx_000000a1", 0);
    await humanSave(root, (timeline) => {
      timeline.tracks[0]!.clips[0]!.start = 5;
    });
    const move = await apply("cli:agent", "tx_000000a2", { op: "clip.move", args: { clip: "c_1", start: 7 } });

    await revert("cli:agent", "tx_000000a3", move.operation.id);
    expect(tracks()[0].clips[0].start).toBe(5);
  });

  it("reports an unknown target with HistoryNotFound", async () => {
    const { revert } = setup();
    const error = await rejection(revert("ui", "tx_000000b1", "op_00000000"));
    expect(error.code).toBe(ErrorCode.HistoryNotFound);
  });
});
