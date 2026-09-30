import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ErrorCode, type MediaProbe, RpcError } from "@frameshell/protocol";
import { createProjectConfig, createTimeline } from "@frameshell/schema";
import { describe, expect, it } from "vitest";
import { ProjectRegistry } from "../src/projects.js";
import type { OperationRequest } from "../src/timeline/engine.js";
import { TimelineService, type TimelineServiceOptions } from "../src/timeline/service.js";
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

function setup(
  resolveEditPoint?: TimelineServiceOptions["resolveEditPoint"],
  onChanged?: TimelineServiceOptions["onChanged"],
) {
  const root = project();
  let next = 0;
  const timelines = new TimelineService({
    probe: async () => PROBE,
    clipTypes: async () => new Map(),
    newId: (prefix) => `${prefix}_${++next}`,
    ...(resolveEditPoint ? { resolveEditPoint } : {}),
    ...(onChanged ? { onChanged } : {}),
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

  it("names a later track add or remove as the conflict when the target changed the track order", async () => {
    const { apply, revert, tracks } = setup();
    await apply("ui", "tx_000000b0", { op: "track.add", args: { kind: "audio" } });
    const before = tracks();
    const removed = await apply("cli:agent", "tx_000000a1", { op: "track.remove", args: { track: "t_v", force: false } });
    const human = await apply("ui", "tx_000000b1", { op: "track.add", args: { kind: "audio" } });

    const conflict = await rejection(revert("cli:agent", "tx_000000a2", removed.operation.id));
    expect(conflict.code).toBe(ErrorCode.RevertConflict);
    expect(conflict.message).toMatch(new RegExp(`${human.operation.id}.*track\\.add.*ui`, "s"));
    expect(conflict.message).not.toMatch(/no longer matches/);
    expect(conflict.data).toMatchObject({
      target: removed.operation.id,
      conflicts: [{ id: human.operation.id, op: "track.add", author: "ui", tx: "tx_000000b1" }],
    });

    await revert("cli:agent", "tx_000000a2", human.operation.id);
    await revert("cli:agent", "tx_000000a3", removed.operation.id);
    expect(tracks()).toEqual(before);
  });

  it("treats reverting twice as a conflict with the first revert", async () => {
    const { add, revert } = setup();
    const added = await add("cli:agent", "tx_000000a1", 0);
    const first = await revert("ui", "tx_000000b1", added.operation.id);
    const again = await rejection(revert("ui", "tx_000000b2", added.operation.id));
    expect(again.data).toMatchObject({ conflicts: [{ id: first.operation.id, op: "revert" }] });
  });

  /**
   * An edit made while no daemon held the file (daemon stopped), then a fresh
   * service. `withoutHead`: the journal's head snapshot is gone too (a journal
   * from an older daemon), so the edit cannot be diffed and stays a gap.
   */
  const offlineEdit = (
    root: string,
    edit: (timeline: { revision: number; tracks: { clips: { start: number }[] }[] }) => void,
    { withoutHead = false } = {},
  ) => {
    const path = join(root, "timelines", "main.json");
    const timeline = JSON.parse(readFileSync(path, "utf8"));
    edit(timeline);
    writeFileSync(path, JSON.stringify(timeline));
    if (withoutHead) rmSync(join(root, ".frameshell", "history", "main.head.json"));
    return new TimelineService({ probe: async () => PROBE, clipTypes: async () => new Map(), newId: (prefix) => `${prefix}_x${Math.random()}` });
  };

  it("journals an edit made while no daemon ran as a `file` operation on next load, so it can be reverted", async () => {
    const { root, add, tracks } = setup();
    await add("cli:agent", "tx_000000a1", 0);
    const restarted = offlineEdit(root, (timeline) => {
      timeline.tracks[0]!.clips[0]!.start = 5;
    });

    await restarted.reconcile(root, "main");

    const history = await restarted.history(root, "main", {});
    expect(history.transactions.map((tx) => tx.author)).toEqual(["cli:agent", "file"]);
    expect(history.transactions[1]!.operations).toMatchObject([{ op: "timeline.patch", revisionBefore: 1, revision: 2, touched: ["c_1"] }]);
    expect(JSON.parse(readFileSync(join(root, "timelines", "main.json"), "utf8")).revision).toBe(2);
    const call = { root, cwd: root, timeline: "main", author: "ui", tx: { id: "tx_000000b1", label: null } };
    await restarted.revert({ ...call, target: history.transactions[1]!.tx });
    expect(tracks()[0].clips[0].start).toBe(0);
  });

  it("restores the journal's version when an edit made while no daemon ran breaks a timeline rule, keeping the edit", async () => {
    const { root, add, tracks } = setup();
    await add("cli:agent", "tx_000000a1", 0);
    await add("cli:agent", "tx_000000a1", 3);
    const before = readFileSync(join(root, "timelines", "main.json"), "utf8");
    const restarted = offlineEdit(root, (timeline) => {
      timeline.tracks[0]!.clips[1]!.start = 1; // overlaps c_1 (0 to 2)
    });

    await restarted.reconcile(root, "main");

    expect(JSON.parse(readFileSync(join(root, "timelines", "main.json"), "utf8"))).toEqual(JSON.parse(before));
    expect(tracks()[0].clips.map((clip: { start: number }) => clip.start)).toEqual([0, 3]);
    const [rejected] = await restarted.rejections(root);
    expect(rejected).toMatchObject({ timeline: "main", reason: "invalid", current: 2 });
    expect(JSON.parse(readFileSync(join(root, rejected!.preserved), "utf8")).tracks[0].clips[1].start).toBe(1);
    expect((await restarted.history(root, "main", {})).transactions).toHaveLength(1);
  });

  it("puts the journal's revision back when only the revision changed while no daemon ran", async () => {
    const { root, add } = setup();
    const added = await add("cli:agent", "tx_000000a1", 0);
    const restarted = offlineEdit(root, (timeline) => {
      timeline.revision += 5;
    });
    await restarted.revert({ root, cwd: root, timeline: "main", author: "ui", tx: { id: "tx_000000b1", label: null }, target: added.operation.tx });
    expect(JSON.parse(readFileSync(join(root, "timelines", "main.json"), "utf8"))).toMatchObject({ revision: 2, tracks: [{ clips: [] }] });
  });

  it("refuses when the timeline file changed outside the journal and no snapshot says how", async () => {
    const { root, add } = setup();
    const added = await add("cli:agent", "tx_000000a1", 0);
    const restarted = offlineEdit(
      root,
      (timeline) => {
        timeline.revision += 1;
      },
      { withoutHead: true },
    );
    const error = await rejection(
      restarted.revert({ root, cwd: root, timeline: "main", author: "ui", tx: { id: "tx_000000b1", label: null }, target: added.operation.tx }),
    );
    expect(error.code).toBe(ErrorCode.RevertConflict);
    expect(error.message).toMatch(/changed outside/);
  });

  // `file.write` is the desktop editor's save path; the registry alone writes as is, the service then sees a direct edit.
  const humanSave = async (root: string, edit: (timeline: { revision: number; tracks: { clips: { start: number }[] }[] }) => void) => {
    const path = join(root, "timelines", "main.json");
    const timeline = JSON.parse(readFileSync(path, "utf8"));
    edit(timeline);
    await new ProjectRegistry().writeFile(path, JSON.stringify(timeline));
  };

  it("names a direct edit that changed the same clip as the conflict", async () => {
    const { root, add, apply, revert, tracks } = setup();
    await add("cli:agent", "tx_000000a1", 0);
    const move = await apply("cli:agent", "tx_000000a1", { op: "clip.move", args: { clip: "c_1", start: 1 } });
    await humanSave(root, (timeline) => {
      timeline.tracks[0]!.clips[0]!.start = 5;
    });

    const error = await rejection(revert("cli:agent", "tx_000000a2", move.operation.id));
    expect(error.code).toBe(ErrorCode.RevertConflict);
    expect(error.data).toMatchObject({ conflicts: [{ op: "timeline.patch", author: "file", ids: ["c_1"] }] });
    expect(tracks()[0].clips[0].start).toBe(5);
  });

  it("refuses when an unjournaled edit is followed by journaled operations", async () => {
    const { root, add, apply } = setup();
    await add("cli:agent", "tx_000000a1", 0);
    const move = await apply("cli:agent", "tx_000000a1", { op: "clip.move", args: { clip: "c_1", start: 1 } });
    const restarted = offlineEdit(
      root,
      (timeline) => {
        timeline.tracks[0]!.clips[0]!.start = 5;
      },
      { withoutHead: true },
    );
    const call = { root, cwd: root, timeline: "main" };
    await restarted.apply({ ...call, author: "ui", tx: { id: "tx_000000b1", label: null }, request: { op: "track.add", args: { kind: "video" } } });

    const error = await rejection(restarted.revert({ ...call, author: "cli:agent", tx: { id: "tx_000000a2", label: null }, target: move.operation.tx }));
    expect(error.code).toBe(ErrorCode.RevertConflict);
    expect(error.message).toMatch(new RegExp(`changed outside the journal between ${move.operation.id}`));
    expect(JSON.parse(readFileSync(join(root, "timelines", "main.json"), "utf8")).tracks[0].clips[0].start).toBe(5);
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

  it("still reverts when a direct edit came before the target", async () => {
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

  it("journals a snapped cut with the applied times, its author, and an inverse that restores the unsnapped timeline", async () => {
    // Stub resolver: every edge moves 0.2 s later, as if a pause lay there.
    const { root, add, apply, revert, tracks } = setup((_root, _fps) => (point) => ({ time: point.time + 0.2, clean: true }));
    await add("cli:agent", "tx_000000a1", 0);
    const before = tracks();
    const cut = await apply("cli:agent", "tx_000000a2", { op: "cut", args: { from: 0.5, to: 1 } });

    expect(cut.snaps.map((s) => [s.field, s.requested, s.applied])).toEqual([
      ["from", 0.5, 0.7],
      ["to", 1, 1.2],
    ]);
    const entries = readFileSync(join(root, ".frameshell", "history", "main.jsonl"), "utf8")
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(entries[1]).toMatchObject({ op: "cut", author: "cli:agent", tx: "tx_000000a2", id: cut.operation.id, revisionBefore: 1, revision: 2 });
    expect(entries[1].inverse.op).toBe("timeline.patch");
    // Snapped result: kept [0, 0.7] and [1.2, 2] shifted to start at 0.7.
    expect(tracks()).not.toEqual(before);

    await revert("cli:agent", "tx_000000a3", cut.operation.id);
    expect(tracks()).toEqual(before);
  });
});

describe("history diff", () => {
  it("lists the clips a transaction added, removed, moved and changed, with where they were before and right after it", async () => {
    const { root, timelines, add, apply } = setup();
    await add("ui", "tx_00000001", 0); // c_1, 0-2
    await add("ui", "tx_00000001", 3); // c_2, 3-5
    await add("ui", "tx_00000001", 6); // c_3, 6-8
    const tx = "tx_000000a1";
    await apply("cli:agent", tx, { op: "clip.remove", args: { clip: "c_1" } });
    await apply("cli:agent", tx, { op: "clip.move", args: { clip: "c_2", start: 10 } });
    await apply("cli:agent", tx, { op: "clip.trim", args: { clip: "c_3", out: 1 } });
    await add("cli:agent", tx, 20); // c_4
    // Later changes by someone else do not change what the transaction did.
    await apply("ui", "tx_000000b1", { op: "clip.move", args: { clip: "c_2", start: 14 } });

    const diff = await timelines.diff(root, "main", tx);
    expect(diff).toEqual({
      timeline: "main",
      target: tx,
      clips: [
        { clip: "c_1", change: "removed", before: { track: "t_v", start: 0, end: 2 }, after: null },
        { clip: "c_2", change: "moved", before: { track: "t_v", start: 3, end: 5 }, after: { track: "t_v", start: 10, end: 12 } },
        { clip: "c_3", change: "changed", before: { track: "t_v", start: 6, end: 8 }, after: { track: "t_v", start: 6, end: 7 } },
        { clip: "c_4", change: "added", before: null, after: { track: "t_v", start: 20, end: 22 } },
      ],
    });
  });

  it("diffs a single operation, and leaves out clips a transaction changed and then restored", async () => {
    const { root, timelines, add, apply } = setup();
    await add("ui", "tx_00000001", 0);
    const tx = "tx_000000a1";
    const move = await apply("cli:agent", tx, { op: "clip.move", args: { clip: "c_1", start: 4 } });
    await apply("cli:agent", tx, { op: "clip.move", args: { clip: "c_1", start: 0 } });

    expect((await timelines.diff(root, "main", tx)).clips).toEqual([]);
    expect((await timelines.diff(root, "main", move.operation.id)).clips).toEqual([
      { clip: "c_1", change: "moved", before: { track: "t_v", start: 0, end: 2 }, after: { track: "t_v", start: 4, end: 6 } },
    ]);
  });

  it("reports an unknown target with HistoryNotFound", async () => {
    const { root, timelines, add } = setup();
    await add("ui", "tx_00000001", 0);
    const error = await rejection(timelines.diff(root, "main", "tx_ffffffff"));
    expect(error.code).toBe(ErrorCode.HistoryNotFound);
  });

  it("refuses with HistoryUnavailable when the file changed outside the journal since the target", async () => {
    const { root, add } = setup();
    const added = await add("cli:agent", "tx_000000a1", 0);
    const path = join(root, "timelines", "main.json");
    const timeline = JSON.parse(readFileSync(path, "utf8"));
    timeline.revision += 1;
    writeFileSync(path, JSON.stringify(timeline));
    const restarted = new TimelineService({ probe: async () => PROBE, clipTypes: async () => new Map() });
    const error = await rejection(restarted.diff(root, "main", added.operation.tx));
    expect(error.code).toBe(ErrorCode.HistoryUnavailable);
    expect(error.data).toMatchObject({ target: added.operation.tx, timeline: "main" });
  });
});

describe("timeline.changed feed (onChanged)", () => {
  it("fires for a revert, with the revert operation's revision, author and changes", async () => {
    const seen: Array<{ revision: number; author: string; changes: unknown }> = [];
    const { add, revert } = setup(undefined, (change) => seen.push(change));
    const first = await add("cli:agent", "tx_000000a1", 0);
    const reverted = await revert("ui", "tx_000000a2", "tx_000000a1");

    expect(seen).toHaveLength(2);
    expect(seen[1]).toEqual({
      root: expect.any(String),
      timeline: "main",
      revision: reverted.revision,
      author: "ui",
      changes: reverted.changes,
    });
    expect(reverted.revision).toBeGreaterThan(first.revision);
    expect(reverted.changes.removed.length).toBeGreaterThan(0);
  });

  it("fires for a snapped cut, reporting the snapped edges' changes", async () => {
    const seen: Array<{ revision: number; author: string; changes: unknown }> = [];
    const { add, apply } = setup((_root, _fps) => (point) => ({ time: point.time + 0.2, clean: true }), (change) =>
      seen.push(change),
    );
    await add("cli:agent", "tx_000000a1", 0);
    const cut = await apply("cli:agent", "tx_000000a2", { op: "cut", args: { from: 0.5, to: 1 } });

    expect(cut.snaps.length).toBeGreaterThan(0);
    expect(seen).toHaveLength(2);
    expect(seen[1]).toMatchObject({ revision: cut.revision, author: "cli:agent", changes: cut.changes });
  });
});
