import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type AppDirs, type DaemonConnection, ErrorCode, connectToDaemon } from "@frameshell/protocol";
import { createTimeline } from "@frameshell/schema";
import { CONFIG_JOURNAL, type Daemon, startDaemon } from "../src/index.js";
import { tempDir, uniqueSocketPath } from "./helpers.js";

// Project-config changes in history (ADR 0036 slice 1): format edits are journaled in their transaction, listed by
// `history`, undone by `revert` and `tx.abort` (`desktop/…` = `ui`). Review mode: config-review.test.ts.

let daemon: Daemon | undefined;
const connections: DaemonConnection[] = [];
afterEach(async () => {
  for (const conn of connections.splice(0)) conn.close();
  await daemon?.close();
  daemon = undefined;
});

async function setup() {
  const dirs: AppDirs = { dataDir: tempDir(), configDir: tempDir() };
  daemon = await startDaemon({ socketPath: uniqueSocketPath(), dirs, idleTimeoutMs: Infinity });
  const connect = async (client: string, session?: string) => {
    const conn = await connectToDaemon(daemon!.socketPath, { client, agent: null, session });
    connections.push(conn);
    return conn;
  };
  const ui = await connect("desktop/test");
  const agent = await connect("cli/test");
  const dir = join(tempDir(), "talk");
  await ui.request("project.init", { dir });
  const formatIds = async () => (await agent.request("format.list", { cwd: dir })).formats.map((format) => format.id);
  const journal = () =>
    readFileSync(join(dir, CONFIG_JOURNAL), "utf8")
      .split(/\r?\n/)
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  return { dir, ui, agent, connect, formatIds, journal };
}

describe("format changes in history", () => {
  it("journals a format change in its transaction with a keyed patch and reverts it by op id", async () => {
    const { dir, agent, formatIds, journal } = await setup();
    const original = readFileSync(join(dir, "frameshell.json"), "utf8");
    const added = await agent.request("format.add", { cwd: dir, id: "9x16" });
    expect(added.tx).toMatch(/^tx_[0-9a-f]{8}$/);
    expect(journal()).toMatchObject([
      {
        id: added.op,
        op: "format.add",
        tx: added.tx,
        txLabel: null,
        doc: "project",
        patch: [{ key: "format:9x16", before: null, after: { id: "9x16", width: 1080, height: 1920, index: 1 } }],
        hashBefore: expect.stringMatching(/^sha256:/),
        undo: { method: "format.remove", params: { id: "9x16" } },
      },
    ]);
    const history = await agent.request("history", { cwd: dir, timeline: "main" });
    expect(history.transactions).toMatchObject([
      { tx: added.tx, author: "cli", operations: [{ id: added.op, op: "format.add", doc: "project", touched: ["format:9x16"], revision: 0, revisionBefore: 0 }] },
    ]);
    expect(await agent.request("history.diff", { cwd: dir, timeline: "main", target: added.tx })).toEqual({ timeline: "main", target: added.tx, clips: [] });

    const reverted = await agent.request("revert", { cwd: dir, timeline: "main", target: added.op });
    expect(reverted).toMatchObject({
      timeline: "main",
      revision: 0,
      operation: { op: "revert", args: { target: added.op }, inverse: { op: "timeline.patch", args: {} } },
      changes: { added: [], updated: [], removed: [] },
      config: [{ op: "revert", doc: "project", touched: ["format:9x16"] }],
    });
    expect(reverted.operation.id).toBe(reverted.config[0]!.id);
    expect(await formatIds()).toEqual(["16x9"]);
    expect(readFileSync(join(dir, "frameshell.json"), "utf8")).toBe(original);
    // Reverting the revert redoes the change.
    await agent.request("revert", { cwd: dir, timeline: "main", target: reverted.operation.id });
    expect(await formatIds()).toEqual(["16x9", "9x16"]);
  });

  it("reverts an add after a later unrelated add, and conflicts when a later change touched the same format", async () => {
    const { dir, agent, formatIds } = await setup();
    const vertical = await agent.request("format.add", { cwd: dir, id: "9x16" });
    await agent.request("format.add", { cwd: dir, id: "1x1" });
    await agent.request("revert", { cwd: dir, timeline: "main", target: vertical.op });
    expect(await formatIds()).toEqual(["16x9", "1x1"]);

    const square = (await agent.request("history", { cwd: dir, timeline: "main" })).transactions[1]!.operations[0]!;
    const removed = await agent.request("format.remove", { cwd: dir, id: "1x1" });
    await expect(agent.request("revert", { cwd: dir, timeline: "main", target: square.id })).rejects.toMatchObject({
      code: ErrorCode.RevertConflict,
      data: { target: square.id, doc: "project", conflicts: [{ id: removed.op, op: "format.remove", ids: ["format:1x1"] }] },
    });
    expect(await formatIds()).toEqual(["16x9"]);
  });

  it("refuses a revert across a hand edit of formats in frameshell.json", async () => {
    const { dir, agent } = await setup();
    const added = await agent.request("format.add", { cwd: dir, id: "9x16" });
    const file = join(dir, "frameshell.json");
    const config = JSON.parse(readFileSync(file, "utf8")) as { formats: unknown[] };
    config.formats.push({ id: "1x1", width: 1080, height: 1080 });
    writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
    await expect(agent.request("revert", { cwd: dir, timeline: "main", target: added.op })).rejects.toMatchObject({
      code: ErrorCode.RevertConflict,
      message: expect.stringContaining("changed outside the journal"),
      data: { conflicts: [] },
    });
  });

  it("reads a line written before ADR 0036 as its own transaction and reverts it", async () => {
    const { dir, agent, formatIds } = await setup();
    const file = join(dir, "frameshell.json");
    const formats = [
      { id: "16x9", width: 1920, height: 1080 },
      { id: "4x5", width: 1080, height: 1350 },
    ];
    writeFileSync(file, `${JSON.stringify({ ...(JSON.parse(readFileSync(file, "utf8")) as object), formats }, null, 2)}\n`);
    const journalPath = join(dir, CONFIG_JOURNAL);
    mkdirSync(dirname(journalPath), { recursive: true });
    const legacy = {
      id: "op_0a0b0c0d",
      op: "format.add",
      args: { id: "4x5" },
      author: "ui",
      at: "2026-11-01T10:00:00.000Z",
      before: null,
      after: formats,
      undo: { method: "format.remove", params: { id: "4x5" } },
    };
    appendFileSync(journalPath, `${JSON.stringify(legacy)}\n`);
    const history = await agent.request("history", { cwd: dir, timeline: "main" });
    expect(history.transactions).toMatchObject([{ tx: "tx_0a0b0c0d", author: "ui", operations: [{ id: "op_0a0b0c0d", touched: ["format:4x5"], doc: "project" }] }]);
    await agent.request("revert", { cwd: dir, timeline: "main", target: "tx_0a0b0c0d" });
    expect(await formatIds()).toEqual(["16x9"]);
  });

  it("groups a mixed transaction in history, reverts it whole, and undoes config on tx.abort", async () => {
    const { dir, connect, formatIds, journal } = await setup();
    const session = await connect("cli/test", "agent");
    const tracks = async () => (await session.request("track.list", { cwd: dir })).tracks.length;
    const begun = await session.request("tx.begin", { label: "vertical cut" });
    await session.request("track.add", { cwd: dir, kind: "video", name: "V1" });
    const added = await session.request("format.add", { cwd: dir, id: "9x16" });
    expect(added.tx).toBe(begun.tx);
    expect((await session.request("status", { cwd: dir })).transactions).toMatchObject([{ tx: begun.tx, operations: 2, timelines: ["main"] }]);
    await session.request("tx.commit", {});
    const listed = (await session.request("history", { cwd: dir, timeline: "main", since: undefined })).transactions;
    expect(listed).toMatchObject([{ tx: begun.tx, label: "vertical cut", operations: [{ op: "track.add" }, { op: "format.add", doc: "project" }] }]);

    const reverted = await session.request("revert", { cwd: dir, timeline: "main", target: begun.tx });
    expect(reverted.operation.op).toBe("revert");
    expect(reverted.config).toMatchObject([{ op: "revert", touched: ["format:9x16"] }]);
    expect(await formatIds()).toEqual(["16x9"]);
    expect(await tracks()).toBe(0);

    const aborted = await session.request("tx.begin", { label: "try square" });
    await session.request("format.add", { cwd: dir, id: "1x1" });
    await session.request("track.add", { cwd: dir, kind: "video", name: "V2" });
    const result = await session.request("tx.abort", {});
    expect(result.reverted).toHaveLength(1);
    expect(result.config).toMatchObject([{ op: "revert", tx: aborted.tx, args: { target: aborted.tx }, touched: ["format:1x1"] }]);
    expect(await formatIds()).toEqual(["16x9"]);
    expect(await tracks()).toBe(0);
    expect(journal().at(-1)).toMatchObject({ op: "revert", tx: aborted.tx, txLabel: "try square" });
  });

  it("reverts a transaction spanning a format and two timelines one timeline at a time", async () => {
    const { dir, ui, connect, formatIds } = await setup();
    await ui.request("file.write", { path: join(dir, "timelines", "intro.json"), content: JSON.stringify(createTimeline("intro")) });
    const session = await connect("cli/test", "agent");
    const tracks = async (timeline: string) => (await session.request("track.list", { cwd: dir, timeline })).tracks.length;
    const both = await session.request("tx.begin", { label: "vertical everywhere" });
    await session.request("format.add", { cwd: dir, id: "9x16" });
    await session.request("track.add", { cwd: dir, timeline: "main", kind: "video", name: "V1" });
    await session.request("track.add", { cwd: dir, timeline: "intro", kind: "video", name: "V1" });
    await session.request("tx.commit", {});

    const first = await session.request("revert", { cwd: dir, timeline: "main", target: both.tx });
    expect(first.config).toMatchObject([{ op: "revert", touched: ["format:9x16"] }]);
    expect([await formatIds(), await tracks("main"), await tracks("intro")]).toEqual([["16x9"], 0, 1]);
    const second = await session.request("revert", { cwd: dir, timeline: "intro", target: both.tx });
    expect(second).toMatchObject({ timeline: "intro", operation: { op: "revert" }, config: [] });
    expect([await formatIds(), await tracks("main"), await tracks("intro")]).toEqual([["16x9"], 0, 0]);

    // Clips only on intro: naming main keeps the --timeline hint instead of reverting the config part alone.
    const elsewhere = await session.request("tx.begin", { label: "square intro" });
    await session.request("format.add", { cwd: dir, id: "1x1" });
    await session.request("track.add", { cwd: dir, timeline: "intro", kind: "video", name: "V2" });
    await session.request("tx.commit", {});
    for (const call of [
      session.request("revert", { cwd: dir, timeline: "main", target: elsewhere.tx }),
      session.request("history.diff", { cwd: dir, timeline: "main", target: elsewhere.tx }),
    ]) {
      await expect(call).rejects.toMatchObject({
        code: ErrorCode.HistoryNotFound,
        message: expect.stringContaining("--timeline intro"),
        data: { target: elsewhere.tx, timeline: "main", timelines: ["intro"] },
      });
    }
    expect(await formatIds()).toEqual(["16x9", "1x1"]);
    const there = await session.request("revert", { cwd: dir, timeline: "intro", target: elsewhere.tx });
    expect(there.config).toMatchObject([{ op: "revert", touched: ["format:1x1"] }]);
    expect([await formatIds(), await tracks("intro")]).toEqual([["16x9"], 0]);
  });

  it("aborts a transaction whose only format change failed while review mode is on", async () => {
    const { dir, ui, connect } = await setup();
    const session = await connect("cli/test", "agent");
    const begun = await session.request("tx.begin", { label: "nothing written" });
    await expect(session.request("format.add", { cwd: dir, id: "16x9" })).rejects.toMatchObject({ code: ErrorCode.InvalidOperation });
    await ui.request("review.set", { cwd: dir, enabled: true });
    expect(await session.request("tx.abort", {})).toMatchObject({ tx: begun.tx, reverted: [], config: [] });
  });

  it("lets the person revert a format change at once in review mode, which makes an agent's proposal on it stale", async () => {
    const { dir, ui, connect, formatIds } = await setup();
    const session = await connect("cli/test", "agent");
    const square = await session.request("format.add", { cwd: dir, id: "1x1" });
    await ui.request("review.set", { cwd: dir, enabled: true });
    const before = readFileSync(join(dir, "frameshell.json"), "utf8");
    const begun = await session.request("tx.begin", { label: "drop square" });
    const removed = await session.request("format.remove", { cwd: dir, id: "1x1" });
    expect(removed).toMatchObject({ proposal: begun.tx, formats: [{ id: "16x9" }] });
    expect(readFileSync(join(dir, "frameshell.json"), "utf8")).toBe(before);
    await ui.request("revert", { cwd: dir, timeline: "main", target: square.op });
    expect(await formatIds()).toEqual(["16x9"]);
    expect((await ui.request("proposal.status", { cwd: dir })).decisions[0]).toMatchObject({ tx: begun.tx, outcome: "stale", conflicts: ["format:1x1"] });
    await expect(session.request("format.add", { cwd: dir, id: "9x16" })).rejects.toMatchObject({ code: ErrorCode.ProposalState, data: { reason: "stale" } });
  });
});
