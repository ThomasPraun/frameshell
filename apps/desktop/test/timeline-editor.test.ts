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
  await cli.request("file.write", { path: join(dir, "timelines", "main.json"), content: JSON.stringify(FIXTURE) });
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

  it("stops at an edit the daemon refuses, keeping what applied as one undo step, and says why", async () => {
    const { dir, app, editor, clip } = await setup();
    const batch: TimelineEdit[] = [
      { op: "clip.move", args: { clip: "c_c", start: 30 } },
      { op: "clip.move", args: { clip: "c_a", start: 5 } }, // Overlaps c_b.
      { op: "clip.move", args: { clip: "c_b", start: 40 } },
    ];
    await expect(editor.apply(dir, "main", batch)).rejects.toThrow(/overlap/);
    expect(await clip("c_c")).toMatchObject({ start: 30 });
    expect(await clip("c_b")).toMatchObject({ start: 4 });

    // Committed, not left open: the next edit is a transaction of its own.
    const next = await editor.apply(dir, "main", [{ op: "clip.move", args: { clip: "c_b", start: 40 } }]);
    const history = await app.request("history", { cwd: dir, timeline: "main" });
    expect(history.transactions.slice(1).map((tx) => [tx.tx, tx.operations.length])).toEqual([
      [expect.any(String), 1],
      [next.operation.tx, 1],
    ]);
    await editor.undo(dir, "main");
    await editor.undo(dir, "main");
    expect(await clip("c_c")).toMatchObject({ start: 20 });
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
      [null, 1],
      ["Split 2 clips", 2],
      [null, 1],
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
