import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startDaemon } from "@frameshell/core";
import { type DaemonConnection, ErrorCode, connectToDaemon } from "@frameshell/protocol";
import type { TimelineEdit } from "../src/shared/api.js";
import { TimelineEditor } from "../src/main/timeline-editor.js";

// Seam under test: main's timeline editor (what the renderer's edits and undo/redo keys reach),
// against a real daemon. The app's connection is `desktop/…`, so the daemon attributes it to `ui`.

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const FIXTURE = {
  $schema: "https://frameshell.dev/schema/v1/timeline.json",
  schemaVersion: 1,
  id: "main",
  revision: 0,
  tracks: [
    {
      id: "v1",
      kind: "video",
      clips: [
        { id: "c_a", type: "titles", start: 0, duration: 4 },
        { id: "c_b", type: "titles", start: 4, duration: 6 },
      ],
    },
    { id: "v2", kind: "video", clips: [{ id: "c_c", type: "titles", start: 20, duration: 2 }] },
  ],
};

/** Daemon, a project holding {@link FIXTURE}, the app's editor and a terminal-like CLI connection. */
async function setup() {
  const work = realpathSync(mkdtempSync(join(tmpdir(), "fs-editor-")));
  const socketPath =
    process.platform === "win32" ? `\\\\.\\pipe\\frameshell-editor-${randomUUID().slice(0, 8)}` : join(work, "d.sock");
  const daemon = await startDaemon({ socketPath, dirs: { dataDir: join(work, "data"), configDir: join(work, "config") } });
  cleanups.push(() => daemon.close());
  const connect = async (client: string, session?: string): Promise<DaemonConnection> => {
    const connection = await connectToDaemon(socketPath, { client, ...(session ? { session } : {}) });
    cleanups.push(() => connection.close());
    return connection;
  };
  const app = await connect("desktop/test");
  const cli = await connect("cli/test", "term-1");
  const dir = join(work, "talk");
  await app.request("project.init", { dir });
  // Loaded from the terminal: an app save would be a `ui` edit, the first thing undo takes back.
  // Its own session: a `file.write` is journaled under the caller's author and would share the terminal's transaction.
  const loader = await connect("cli/loader", "loader-1");
  await loader.request("file.write", { path: join(dir, "timelines", "main.json"), content: JSON.stringify(FIXTURE) });
  const editor = new TimelineEditor((method, params) => app.request(method, params));
  /** Clip start/end as the daemon derives them. */
  const clip = async (id: string) => {
    const view = await app.request("timeline.show", { cwd: dir, timeline: "main" });
    const found = view.tracks.flatMap((track) => track.clips.map((c) => ({ ...c, track: track.id }))).find((c) => c.id === id);
    return found ? { track: found.track, start: found.start, end: found.end } : null;
  };
  return { dir, app, cli, editor, clip };
}

describe("TimelineEditor.apply", () => {
  it("sends each edit as one daemon operation by `ui`, saved to the timeline file at once", async () => {
    const { dir, app, editor, clip } = await setup();
    const result = await editor.apply(dir, "main", [{ op: "clip.move", args: { clip: "c_c", start: 12, track: "v1" } }]);
    expect(result.operation).toMatchObject({ op: "clip.move", author: "ui" });
    expect(await clip("c_c")).toEqual({ track: "v1", start: 12, end: 14 });
    const saved = JSON.parse(readFileSync(join(dir, "timelines", "main.json"), "utf8"));
    expect(saved.revision).toBe(result.revision);
    const history = await app.request("history", { cwd: dir, timeline: "main" });
    // Before it: the fixture's file.write from the terminal connection.
    expect(history.transactions.slice(1).map((tx) => [tx.author, tx.operations.map((op) => op.op)])).toEqual([["ui", ["clip.move"]]]);
  });

  it("labels every call's transaction, so `history --since` reads as what the human did (#119)", async () => {
    const { dir, app, editor } = await setup();
    await editor.apply(dir, "main", [{ op: "clip.move", args: { clip: "c_c", start: 30 } }]);
    await editor.apply(dir, "main", [{ op: "clip.trim", args: { clip: "c_a", end: 3, ripple: true, snap: false } }]);
    await editor.apply(dir, "main", [{ op: "clip.set", args: { clip: "c_c", gain: -3 } }], { label: "Lower gain" });
    const history = await app.request("history", { cwd: dir, timeline: "main" });
    expect(history.transactions.slice(1).map((tx) => [tx.author, tx.label])).toEqual([
      ["ui", "Move clip"],
      ["ui", "Ripple trim clip"],
      ["ui", "Lower gain"],
    ]);
  });

  it("refuses a label or burst key that is not short text, before reaching the daemon", async () => {
    const { dir, editor } = await setup();
    const move: TimelineEdit[] = [{ op: "clip.move", args: { clip: "c_c", start: 30 } }];
    await expect(editor.apply(dir, "main", move, { label: "" })).rejects.toThrow(/label/);
    await expect(editor.apply(dir, "main", move, { burst: 7 as unknown as string })).rejects.toThrow(/burst/);
    await expect(editor.apply(dir, "main", move, { label: "x".repeat(201) })).rejects.toThrow(/label/);
  });

  it("covers trim, split and ripple delete (a cut of one track, exact)", async () => {
    const { dir, editor, clip } = await setup();
    await editor.apply(dir, "main", [{ op: "clip.trim", args: { clip: "c_b", end: 9, snap: false } }]);
    const split = await editor.apply(dir, "main", [{ op: "clip.split", args: { clip: "c_b", at: 6 } }]);
    const right = split.changes.added[0]!;
    expect(await clip(right)).toEqual({ track: "v1", start: 6, end: 9 });
    await editor.apply(dir, "main", [{ op: "cut", args: { from: 0, to: 4, tracks: ["v1"], snap: false } }]);
    expect(await clip("c_a")).toBeNull();
    expect(await clip("c_b")).toEqual({ track: "v1", start: 0, end: 2 });
    expect(await clip("c_c")).toEqual({ track: "v2", start: 20, end: 22 });
  });

  it("sets a clip's transform and gain (inspector, preview handles) as one undoable ui operation", async () => {
    const { dir, app, editor } = await setup();
    const set = await editor.apply(dir, "main", [{ op: "clip.set", args: { clip: "c_c", transform: { x: 120, scale: 0.5 }, gain: -6 } }]);
    expect(set.operation).toMatchObject({ op: "clip.set", author: "ui" });
    const stored = async () => {
      const view = await app.request("timeline.show", { cwd: dir, timeline: "main" });
      return view.tracks[1]!.clips[0]!;
    };
    expect(await stored()).toMatchObject({ transform: { x: 120, scale: 0.5 }, audio: { gain: -6 } });
    await editor.undo(dir, "main");
    expect(await stored()).not.toHaveProperty("transform");
  });

  it("refuses operations the timeline panel never sends, before reaching the daemon", async () => {
    const { dir, editor } = await setup();
    const sneaky = { op: "track.remove", args: { track: "v1", force: true } } as unknown as TimelineEdit;
    await expect(editor.apply(dir, "main", [sneaky])).rejects.toThrow(/track\.remove/);
  });

  it("passes the daemon's message through when an edit breaks a timeline rule", async () => {
    const { dir, editor } = await setup();
    await expect(editor.apply(dir, "main", [{ op: "clip.move", args: { clip: "c_a", start: 5 } }])).rejects.toThrow(/overlap/);
  });
});

describe("TimelineEditor batches", () => {
  /** Two clips split by one command, as the panel sends it. */
  const splitTwo: TimelineEdit[] = [
    { op: "clip.split", args: { clip: "c_a", at: 2 } },
    { op: "clip.split", args: { clip: "c_b", at: 7 } },
  ];

  it("applies a multi-clip edit as one ui transaction: one history entry, labelled", async () => {
    const { dir, app, editor, clip } = await setup();
    const result = await editor.apply(dir, "main", splitTwo);
    expect(result.operation).toMatchObject({ op: "clip.split", author: "ui" });
    expect(await clip("c_a")).toMatchObject({ end: 2 });
    expect(await clip("c_b")).toMatchObject({ end: 7 });
    const history = await app.request("history", { cwd: dir, timeline: "main" });
    expect(history.transactions.slice(1).map((tx) => [tx.author, tx.label, tx.operations.map((op) => op.op)])).toEqual([
      ["ui", "Split 2 clips", ["clip.split", "clip.split"]],
    ]);
  });

  it("undo reverts the whole batch in one step, redo re-applies all of it", async () => {
    const { dir, editor, clip } = await setup();
    await editor.apply(dir, "main", [{ op: "clip.move", args: { clip: "c_c", start: 30 } }]);
    await editor.apply(dir, "main", [
      { op: "cut", args: { from: 4, to: 10, tracks: ["v1"], snap: false } },
      { op: "cut", args: { from: 0, to: 4, tracks: ["v1"], snap: false } },
    ]);
    expect(await clip("c_a")).toBeNull();
    expect(await clip("c_b")).toBeNull();

    await editor.undo(dir, "main");
    expect(await clip("c_a")).toEqual({ track: "v1", start: 0, end: 4 });
    expect(await clip("c_b")).toEqual({ track: "v1", start: 4, end: 10 });
    expect(await clip("c_c")).toMatchObject({ start: 30 });

    await editor.redo(dir, "main");
    expect(await clip("c_a")).toBeNull();
    expect(await clip("c_b")).toBeNull();
  });

  it("is all or nothing: a refused edit undoes the call's earlier ones, and undo skips the call (#119)", async () => {
    const { dir, app, editor, clip } = await setup();
    const before = await editor.apply(dir, "main", [{ op: "clip.move", args: { clip: "c_c", start: 25 } }]);
    // A group move whose second member lands on a clip that stays.
    const batch: TimelineEdit[] = [
      { op: "clip.move", args: { clip: "c_c", start: 30 } },
      { op: "clip.move", args: { clip: "c_a", start: 5 } }, // Overlaps c_b.
      { op: "clip.move", args: { clip: "c_b", start: 40 } },
    ];
    await expect(editor.apply(dir, "main", batch)).rejects.toThrow(/overlap/);
    expect(await clip("c_c")).toMatchObject({ start: 25 });
    expect(await clip("c_a")).toMatchObject({ start: 0 });
    expect(await clip("c_b")).toMatchObject({ start: 4 });

    // Closed, not left open: the next edit is a transaction of its own.
    const next = await editor.apply(dir, "main", [{ op: "clip.move", args: { clip: "c_b", start: 40 } }]);
    expect(next.operation.tx).not.toBe(before.operation.tx);
    await expect(app.request("tx.commit", {})).rejects.toMatchObject({ code: ErrorCode.TransactionState });
    await editor.undo(dir, "main");
    expect(await clip("c_b")).toMatchObject({ start: 4 });
    // The refused call changed nothing: the next undo takes back the edit before it.
    await editor.undo(dir, "main");
    expect(await clip("c_c")).toMatchObject({ start: 20 });
    expect(await editor.undo(dir, "main")).toBeNull();
  });

  it("keeps what applied as one step when undoing it conflicts with an agent's edit made meanwhile", async () => {
    const { dir, app, cli, clip } = await setup();
    const editor = new TimelineEditor(async (method, params) => {
      // The agent moves c_c again between the call's first and second edit.
      if (method === "clip.move" && (params as { clip: string }).clip === "c_a") {
        await cli.request("clip.move", { cwd: dir, timeline: "main", clip: "c_c", start: 35 });
      }
      return app.request(method, params);
    });
    const batch: TimelineEdit[] = [
      { op: "clip.move", args: { clip: "c_c", start: 30 } },
      { op: "clip.move", args: { clip: "c_a", start: 5 } }, // Overlaps c_b.
    ];
    await expect(editor.apply(dir, "main", batch)).rejects.toThrow(/overlap/);
    expect(await clip("c_c")).toMatchObject({ start: 35 });
    await expect(app.request("tx.commit", {})).rejects.toMatchObject({ code: ErrorCode.TransactionState });
  });

  it("never lets a ui transaction left open by a crashed app block a batch or absorb its edits", async () => {
    const { dir, app, editor } = await setup();
    const orphan = await app.request("tx.begin", { label: "Move 2 clips", autoCommitAfter: 60 });
    const result = await editor.apply(dir, "main", splitTwo);
    expect(result.operation.tx).not.toBe(orphan.tx);
    const history = await app.request("history", { cwd: dir, timeline: "main" });
    expect(history.transactions.at(-1)).toMatchObject({ tx: result.operation.tx, label: "Split 2 clips" });
  });

  it("commits a crashed app's ui transaction before a single edit, so later edits and undo never join it", async () => {
    const { dir, app, editor, clip } = await setup();
    const orphan = await app.request("tx.begin", { label: "Move 2 clips", autoCommitAfter: 60 });
    await app.request("clip.move", { cwd: dir, timeline: "main", clip: "c_c", start: 25 });
    const first = await editor.apply(dir, "main", [{ op: "clip.move", args: { clip: "c_c", start: 30 } }]);
    const second = await editor.apply(dir, "main", [{ op: "clip.move", args: { clip: "c_c", start: 31 } }]);
    expect(new Set([orphan.tx, first.operation.tx, second.operation.tx]).size).toBe(3);
    await expect(app.request("tx.commit", {})).rejects.toMatchObject({ code: ErrorCode.TransactionState });

    await editor.undo(dir, "main");
    expect(await clip("c_c")).toMatchObject({ start: 30 });
    await editor.undo(dir, "main");
    await editor.undo(dir, "main");
    expect(await clip("c_c")).toMatchObject({ start: 20 });
  });

  it("commits a ui transaction left open before an undo, so the revert is a step of its own", async () => {
    const { dir, app, editor, clip } = await setup();
    await editor.apply(dir, "main", [{ op: "clip.move", args: { clip: "c_c", start: 30 } }]);
    // A fresh editor, as in an app restarted after the crash.
    const restarted = new TimelineEditor((method, params) => app.request(method, params));
    const orphan = await app.request("tx.begin", { label: "Move 2 clips", autoCommitAfter: 60 });
    await app.request("clip.move", { cwd: dir, timeline: "main", clip: "c_a", start: 12 });
    const undone = await restarted.undo(dir, "main");
    expect(undone?.operation.tx).not.toBe(orphan.tx);
    expect(await clip("c_a")).toMatchObject({ start: 0 });
    expect(await clip("c_c")).toMatchObject({ start: 30 });
  });

  it("closes a batch whose commit was lost before the next edit, which stays a step of its own", async () => {
    const { dir, app, clip } = await setup();
    let loseCommit = false;
    const editor = new TimelineEditor((method, params) => {
      if (method === "tx.commit" && loseCommit) {
        loseCommit = false;
        return Promise.reject(new Error("Daemon connection closed."));
      }
      return app.request(method, params);
    });
    await editor.apply(dir, "main", [{ op: "clip.move", args: { clip: "c_c", start: 30 } }]);
    loseCommit = true;
    await editor.apply(dir, "main", splitTwo);
    const next = await editor.apply(dir, "main", [{ op: "clip.move", args: { clip: "c_c", start: 31 } }]);
    const history = await app.request("history", { cwd: dir, timeline: "main" });
    expect(history.transactions.slice(1).map((tx) => [tx.label, tx.operations.length])).toEqual([
      ["Move clip", 1],
      ["Split 2 clips", 2],
      ["Move clip", 1],
    ]);
    expect(history.transactions.at(-1)?.tx).toBe(next.operation.tx);
    await editor.undo(dir, "main");
    expect(await clip("c_c")).toMatchObject({ start: 30 });
    expect(await clip("c_a")).toMatchObject({ end: 2 });
  });

  it("runs batches one after another, so two windows' edits never share a transaction", async () => {
    const { dir, app, editor } = await setup();
    await Promise.all([
      editor.apply(dir, "main", splitTwo),
      editor.apply(dir, "main", [
        { op: "clip.move", args: { clip: "c_c", start: 30 } },
        { op: "clip.move", args: { clip: "c_c", start: 31 } },
      ]),
    ]);
    const history = await app.request("history", { cwd: dir, timeline: "main" });
    expect(history.transactions.slice(1).map((tx) => [tx.label, tx.operations.map((op) => op.op)])).toEqual([
      ["Split 2 clips", ["clip.split", "clip.split"]],
      ["Move 2 clips", ["clip.move", "clip.move"]],
    ]);
  });
});

describe("TimelineEditor gesture bursts (#119)", () => {
  /** Nudge c_c one frame right, as a held `.` key sends it. */
  const nudge = (start: number): TimelineEdit[] => [{ op: "clip.move", args: { clip: "c_c", start } }];
  const burst = { label: "Nudge clip", burst: "nudge:c_c" };
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const uiEntries = async (app: DaemonConnection, dir: string) =>
    (await app.request("history", { cwd: dir, timeline: "main" })).transactions
      .filter((tx) => tx.author === "ui")
      .map((tx) => [tx.label, tx.operations.map((op) => op.op)]);

  it("joins calls of one burst into one labelled transaction, one undo step", async () => {
    const { dir, app, clip } = await setup();
    const editor = new TimelineEditor((method, params) => app.request(method, params), { burstGapMs: 5_000 });
    const first = await editor.apply(dir, "main", nudge(20.033), burst);
    const third = await editor.apply(dir, "main", nudge(20.067), burst).then(() => editor.apply(dir, "main", nudge(20.1), burst));
    expect(third.operation.tx).toBe(first.operation.tx);
    // Another command ends the burst: a step of its own.
    await editor.apply(dir, "main", [{ op: "clip.split", args: { clip: "c_b", at: 7 } }]);
    expect(await uiEntries(app, dir)).toEqual([
      ["Nudge clip", ["clip.move", "clip.move", "clip.move"]],
      ["Split clip", ["clip.split"]],
    ]);
    await editor.undo(dir, "main");
    await editor.undo(dir, "main");
    expect(await clip("c_c")).toMatchObject({ start: 20 });
  });

  it("closes the burst after the gap: a later press is a new entry", async () => {
    const { dir, app } = await setup();
    const editor = new TimelineEditor((method, params) => app.request(method, params), { burstGapMs: 50 });
    const first = await editor.apply(dir, "main", nudge(20.033), burst);
    await sleep(300);
    // Closed by its timer: nothing is open for `ui` any more.
    await expect(app.request("tx.commit", {})).rejects.toMatchObject({ code: ErrorCode.TransactionState });
    const second = await editor.apply(dir, "main", nudge(20.067), burst);
    expect(second.operation.tx).not.toBe(first.operation.tx);
  });

  it("another burst key, an undo, a History revert or a file save each close the open burst first", async () => {
    const { dir, app, cli, clip } = await setup();
    const editor = new TimelineEditor((method, params) => app.request(method, params), { burstGapMs: 5_000 });
    await editor.apply(dir, "main", nudge(20.033), burst);
    const other = await editor.apply(dir, "main", [{ op: "clip.move", args: { clip: "c_b", start: 11 } }], { burst: "nudge:c_b" });
    const undone = await editor.undo(dir, "main");
    expect(undone?.operation.tx).not.toBe(other.operation.tx);
    expect(await clip("c_b")).toMatchObject({ start: 4 });
    expect((await clip("c_c"))!.start).toBeCloseTo(20.033, 2);

    await editor.apply(dir, "main", nudge(20.067), burst);
    const agent = await cli.request("clip.move", { cwd: dir, timeline: "main", clip: "c_b", start: 12 });
    const reverted = await editor.revert(dir, "main", agent.operation.tx);
    expect(reverted.status).toBe("reverted");

    await editor.apply(dir, "main", nudge(20.1), burst);
    const path = join(dir, "timelines", "main.json");
    const saved = JSON.parse(readFileSync(path, "utf8"));
    saved.tracks[1].clips[0].start = 25;
    await editor.alone(() => app.request("file.write", { path, content: JSON.stringify(saved) }));
    const entries = await uiEntries(app, dir);
    expect(entries.slice(-2)).toEqual([
      ["Nudge clip", ["clip.move"]],
      [null, ["timeline.patch"]],
    ]);
  });

  it("ends the burst at a refused edit: the next press starts a new entry", async () => {
    const { dir, app } = await setup();
    const editor = new TimelineEditor((method, params) => app.request(method, params), { burstGapMs: 5_000 });
    const first = await editor.apply(dir, "main", nudge(20.033), burst);
    await expect(editor.apply(dir, "main", [{ op: "clip.move", args: { clip: "c_c", start: -1 } }], burst)).rejects.toThrow();
    const next = await editor.apply(dir, "main", nudge(20.067), burst);
    expect(next.operation.tx).not.toBe(first.operation.tx);
  });
});

describe("TimelineEditor undo and redo", () => {
  it("undo reverts the latest ui edit, redo re-applies it, and they keep alternating", async () => {
    const { dir, editor, clip } = await setup();
    await editor.apply(dir, "main", [{ op: "clip.move", args: { clip: "c_c", start: 30 } }]);
    await editor.apply(dir, "main", [{ op: "clip.trim", args: { clip: "c_b", end: 8, snap: false } }]);

    expect((await editor.undo(dir, "main"))?.operation).toMatchObject({ op: "revert", author: "ui" });
    expect(await clip("c_b")).toMatchObject({ end: 10 });
    expect(await clip("c_c")).toMatchObject({ start: 30 });
    await editor.undo(dir, "main");
    expect(await clip("c_c")).toMatchObject({ start: 20 });
    expect(await editor.undo(dir, "main")).toBeNull();

    await editor.redo(dir, "main");
    expect(await clip("c_c")).toMatchObject({ start: 30 });
    await editor.undo(dir, "main");
    expect(await clip("c_c")).toMatchObject({ start: 20 });
    await editor.redo(dir, "main");
    await editor.redo(dir, "main");
    expect(await clip("c_b")).toMatchObject({ end: 8 });
    expect(await editor.redo(dir, "main")).toBeNull();
  });

  it("undo takes back a save of the timeline file from the app's editor, a `ui` edit like any other", async () => {
    const { dir, app, editor, clip } = await setup();
    const path = join(dir, "timelines", "main.json");
    const saved = JSON.parse(readFileSync(path, "utf8"));
    saved.tracks[1].clips[0].start = 25;
    await app.request("file.write", { path, content: JSON.stringify(saved) });
    expect(await clip("c_c")).toMatchObject({ start: 25 });

    expect((await editor.undo(dir, "main"))?.operation.author).toBe("ui");
    expect(await clip("c_c")).toMatchObject({ start: 20 });
  });

  it("a new edit after an undo drops the redo", async () => {
    const { dir, editor, clip } = await setup();
    await editor.apply(dir, "main", [{ op: "clip.move", args: { clip: "c_c", start: 30 } }]);
    await editor.undo(dir, "main");
    await editor.apply(dir, "main", [{ op: "clip.move", args: { clip: "c_c", start: 40 } }]);
    expect(await editor.redo(dir, "main")).toBeNull();
    await editor.undo(dir, "main");
    expect(await clip("c_c")).toMatchObject({ start: 20 });
  });

  it("undoes only ui operations: the agent's edits in the terminal stay", async () => {
    const { dir, cli, editor, clip } = await setup();
    await editor.apply(dir, "main", [{ op: "clip.move", args: { clip: "c_c", start: 30 } }]);
    await cli.request("clip.move", { cwd: dir, timeline: "main", clip: "c_a", start: 12 });
    const undone = await editor.undo(dir, "main");
    expect(undone?.operation.author).toBe("ui");
    expect(await clip("c_c")).toMatchObject({ start: 20 });
    expect(await clip("c_a")).toMatchObject({ start: 12 });
  });

  it("reports the daemon's conflict when the agent changed the same clip since", async () => {
    const { dir, cli, editor } = await setup();
    await editor.apply(dir, "main", [{ op: "clip.move", args: { clip: "c_c", start: 30 } }]);
    await cli.request("clip.move", { cwd: dir, timeline: "main", clip: "c_c", start: 40 });
    await expect(editor.undo(dir, "main")).rejects.toThrow(/c_c|revert/i);
  });
});

describe("TimelineEditor.revert (History panel)", () => {
  it("reverts any author's transaction as a ui revert", async () => {
    const { dir, cli, editor, clip } = await setup();
    const moved = await cli.request("clip.move", { cwd: dir, timeline: "main", clip: "c_c", start: 30 });
    const outcome = await editor.revert(dir, "main", moved.operation.tx);
    expect(outcome).toMatchObject({
      status: "reverted",
      result: { operation: { op: "revert", author: "ui", args: { target: moved.operation.tx } } },
    });
    expect(await clip("c_c")).toMatchObject({ start: 20 });
  });

  it("reports a revert conflict as data, naming the later operations to revert first", async () => {
    const { dir, cli, editor } = await setup();
    const agent = await cli.request("clip.move", { cwd: dir, timeline: "main", clip: "c_c", start: 30 });
    const human = await editor.apply(dir, "main", [{ op: "clip.move", args: { clip: "c_c", start: 40 } }]);
    const outcome = await editor.revert(dir, "main", agent.operation.id);
    expect(outcome).toEqual({
      status: "conflict",
      message: expect.stringContaining(human.operation.id),
      conflicts: [{ id: human.operation.id, op: "clip.move", author: "ui", tx: human.operation.tx, ids: ["c_c"] }],
    });
  });

  it("passes other daemon errors through", async () => {
    const { dir, editor } = await setup();
    await expect(editor.revert(dir, "main", "tx_ffffffff")).rejects.toThrow(/tx_ffffffff/);
  });
});
