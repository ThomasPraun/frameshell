import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type DaemonConnection, ErrorCode, connectToDaemon } from "@frameshell/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { type Daemon, startDaemon } from "../src/index.js";
import { tempDir, uniqueSocketPath } from "./helpers.js";

// Seam under test: the daemon over its socket. Clients differ by handshake
// (`cli` + session, `cli` alone, `desktop/…`), as real terminals and the app do.
// Operations are track edits, which need no media.

const GAP_MS = 400;

let daemon: Daemon | undefined;
const connections: DaemonConnection[] = [];
afterEach(async () => {
  for (const conn of connections.splice(0)) conn.close();
  await daemon?.close();
  daemon = undefined;
});

async function setup() {
  daemon = await startDaemon({ socketPath: uniqueSocketPath(), txIdleGapMs: GAP_MS });
  const dir = join(tempDir(), "talk");
  const connect = async (client: string, session?: string) => {
    const conn = await connectToDaemon(daemon!.socketPath, { client, session });
    connections.push(conn);
    return conn;
  };
  const admin = await connect("cli/test");
  await admin.request("project.init", { dir });
  const addTrack = (conn: DaemonConnection, name: string) => conn.request("track.add", { cwd: dir, kind: "video", name });
  const tracks = async () => (await admin.request("track.list", { cwd: dir })).tracks.map((track) => track.name);
  return { dir, connect, admin, addTrack, tracks };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("transactions", () => {
  it("attributes operations to cli:<session>, cli and ui by handshake", async () => {
    const { connect, addTrack } = await setup();
    const agent = await addTrack(await connect("cli/test", "agent"), "A");
    const bare = await addTrack(await connect("cli/test"), "B");
    const app = await addTrack(await connect("desktop/0.1.0"), "C");
    expect([agent, bare, app].map((result) => result.operation.author)).toEqual(["cli:agent", "cli", "ui"]);
  });

  it("groups a session's operations into one transaction until an idle gap, and never across sessions", async () => {
    const { connect, addTrack } = await setup();
    const agent = await connect("cli/test", "agent");
    const other = await connect("cli/test", "other");
    const app = await connect("desktop/0.1.0");

    const first = await addTrack(agent, "A1");
    const second = await addTrack(agent, "A2");
    const otherOp = await addTrack(other, "O1");
    const ui1 = await addTrack(app, "U1");
    const ui2 = await addTrack(app, "U2");
    expect(second.operation.tx).toBe(first.operation.tx);
    expect(otherOp.operation.tx).not.toBe(first.operation.tx);
    expect(ui2.operation.tx).not.toBe(ui1.operation.tx);

    await sleep(GAP_MS * 1.5);
    const later = await addTrack(agent, "A3");
    expect(later.operation.tx).not.toBe(first.operation.tx);
  });

  it("keeps an explicit transaction open across idle gaps until commit, labelled in history", async () => {
    const { dir, connect, addTrack, admin } = await setup();
    const agent = await connect("cli/test", "agent");
    const begun = await agent.request("tx.begin", { label: "rough cut" });
    expect(begun).toMatchObject({ tx: expect.stringMatching(/^tx_[0-9a-f]{8}$/), label: "rough cut", author: "cli:agent" });
    await addTrack(agent, "A1");
    await sleep(GAP_MS * 1.5);
    const second = await addTrack(agent, "A2");
    expect(second.operation.tx).toBe(begun.tx);
    expect(await agent.request("tx.commit", {})).toEqual({ ...begun, operations: 2 });

    const after = await addTrack(agent, "A3");
    expect(after.operation.tx).not.toBe(begun.tx);
    const history = await admin.request("history", { cwd: dir });
    expect(history.transactions.map((t) => [t.label, t.operations.length])).toEqual([
      ["rough cut", 2],
      [null, 1],
    ]);
    const journal = readFileSync(join(dir, ".frameshell", "history", "main.jsonl"), "utf8").trim().split("\n");
    expect(journal).toHaveLength(3);
  });

  it("refuses tx.begin without a session and a second begin, and commit with nothing open", async () => {
    const { connect } = await setup();
    const bare = await connect("cli/test");
    await expect(bare.request("tx.begin", { label: "x" })).rejects.toMatchObject({
      code: ErrorCode.TransactionState,
      message: expect.stringMatching(/FRAMESHELL_SESSION/),
    });
    const agent = await connect("cli/test", "agent");
    const open = await agent.request("tx.begin", { label: "first" });
    await expect(agent.request("tx.begin", { label: "second" })).rejects.toMatchObject({
      code: ErrorCode.TransactionState,
      data: { open: { tx: open.tx, label: "first" } },
    });
    await agent.request("tx.commit", {});
    await expect(agent.request("tx.commit", {})).rejects.toMatchObject({ code: ErrorCode.TransactionState });
  });

  it("aborts an explicit transaction by reverting its operations", async () => {
    const { connect, addTrack, tracks } = await setup();
    const agent = await connect("cli/test", "agent");
    await addTrack(agent, "Keep");
    await agent.request("tx.begin", { label: "experiment" });
    await addTrack(agent, "Drop1");
    await addTrack(agent, "Drop2");
    const aborted = await agent.request("tx.abort", {});
    expect(aborted.reverted).toHaveLength(1);
    expect(aborted.reverted[0]!.operation).toMatchObject({ op: "revert", tx: aborted.tx });
    expect(await tracks()).toEqual(["Keep"]);
    await expect(agent.request("tx.commit", {})).rejects.toMatchObject({ code: ErrorCode.TransactionState });
  });

  it("refuses to abort a transaction that removed a track after the human added one, naming the human's operation", async () => {
    const { dir, connect, addTrack, tracks } = await setup();
    const agent = await connect("cli/test", "agent");
    const app = await connect("desktop/0.1.0");
    // Removing the bottom track journals a full `order`: its inverse must put it back under "Kept".
    const gone = await addTrack(agent, "Gone");
    await addTrack(agent, "Kept");
    await sleep(GAP_MS * 2);
    await agent.request("tx.begin", { label: "cleanup" });
    await agent.request("track.remove", { cwd: dir, track: gone.changes.added[0]! });
    const humanOp = await addTrack(app, "Human");
    await expect(agent.request("tx.abort", {})).rejects.toMatchObject({
      code: ErrorCode.RevertConflict,
      data: { conflicts: [expect.objectContaining({ id: humanOp.operation.id, op: "track.add", author: "ui" })] },
    });
    await app.request("revert", { cwd: dir, target: humanOp.operation.id });
    await agent.request("tx.abort", {});
    expect(await tracks()).toEqual(["Gone", "Kept"]);
  });

  it("shows the agent what the human changed since its last transaction", async () => {
    const { dir, connect, addTrack } = await setup();
    const agent = await connect("cli/test", "agent");
    const app = await connect("desktop/0.1.0");
    const agentOp = await addTrack(agent, "Agent");
    const humanOp = await addTrack(app, "Human");
    const since = await agent.request("history", { cwd: dir, since: agentOp.operation.tx });
    expect(since.transactions).toEqual([
      expect.objectContaining({ author: "ui", operations: [expect.objectContaining({ id: humanOp.operation.id, op: "track.add" })] }),
    ]);
  });

  it("reverts through the daemon in a transaction of its own", async () => {
    const { dir, connect, addTrack, tracks } = await setup();
    const agent = await connect("cli/test", "agent");
    const added = await addTrack(agent, "A1");
    await addTrack(agent, "A2");
    const reverted = await agent.request("revert", { cwd: dir, target: added.operation.tx });
    expect(reverted.operation.tx).not.toBe(added.operation.tx);
    expect(await tracks()).toEqual([]);
    const next = await addTrack(agent, "A3");
    expect(next.operation.tx).not.toBe(reverted.operation.tx);
  });
});
