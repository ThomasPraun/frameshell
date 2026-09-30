import { type AppDirs, type DaemonConnection, connectToDaemon } from "@frameshell/protocol";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type Daemon, startDaemon } from "../src/index.js";
import { tempDir, uniqueSocketPath } from "./helpers.js";

// Seam under test: the daemon over its socket. The app tags a terminal session with the agent CLI it detected
// (`session.tag`); a client may name its agent itself in the handshake (`FRAMESHELL_AGENT`). Track edits need no media.

let daemon: Daemon | undefined;
const connections: DaemonConnection[] = [];
afterEach(async () => {
  for (const conn of connections.splice(0)) conn.close();
  await daemon?.close();
  daemon = undefined;
});

async function setup() {
  const dirs: AppDirs = { dataDir: tempDir(), configDir: tempDir() };
  daemon = await startDaemon({ socketPath: uniqueSocketPath(), dirs, txIdleGapMs: 60_000 });
  const dir = join(tempDir(), "talk");
  const connect = async (client: string, options: { session?: string; agent?: string | null } = {}) => {
    const conn = await connectToDaemon(daemon!.socketPath, { client, ...options });
    connections.push(conn);
    return conn;
  };
  const app = await connect("desktop/0.1.0");
  await app.request("project.init", { dir });
  const addTrack = async (conn: DaemonConnection, name: string) =>
    (await conn.request("track.add", { cwd: dir, kind: "video", name })).operation;
  return { dir, connect, app, addTrack };
}

describe("agent sessions", () => {
  it("journals a tagged session's operations as its agent, keeping them in the session's transaction", async () => {
    const { dir, connect, app, addTrack } = await setup();
    const shell = await connect("cli/test", { session: "term-1a2b" });
    const before = await addTrack(shell, "A");
    await app.request("session.tag", { session: "term-1a2b", agent: "claude" });
    const during = await addTrack(shell, "B");
    await app.request("session.tag", { session: "term-1a2b", agent: null });
    const after = await addTrack(shell, "C");

    expect([before, during, after].map((op) => op.author)).toEqual(["cli:term-1a2b", "agent:claude:term-1a2b", "cli:term-1a2b"]);
    expect(new Set([before.tx, during.tx, after.tx]).size).toBe(1);
    const history = await app.request("history", { cwd: dir });
    expect(history.transactions.flatMap((tx) => tx.operations.map((op) => op.author))).toContain("agent:claude:term-1a2b");
  });

  it("tags only the named session", async () => {
    const { connect, app, addTrack } = await setup();
    await app.request("session.tag", { session: "term-aaaa", agent: "codex" });
    const other = await addTrack(await connect("cli/test", { session: "term-bbbb" }), "B");
    expect(other.author).toBe("cli:term-bbbb");
  });

  it("lets the client name its agent, or none, over the app's tag", async () => {
    const { connect, app, addTrack } = await setup();
    await app.request("session.tag", { session: "term-1a2b", agent: "claude" });
    const named = await addTrack(await connect("cli/test", { session: "term-1a2b", agent: "my-agent" }), "A");
    const none = await addTrack(await connect("cli/test", { session: "term-1a2b", agent: null }), "B");
    const bare = await addTrack(await connect("cli/test", { agent: "codex" }), "C");
    expect([named.author, none.author, bare.author]).toEqual(["agent:my-agent:term-1a2b", "cli:term-1a2b", "agent:codex"]);
  });

  it("drops tags when the connection that set them closes", async () => {
    const { connect, addTrack } = await setup();
    const tagger = await connect("desktop/0.1.0");
    await tagger.request("session.tag", { session: "term-1a2b", agent: "claude" });
    const shell = await connect("cli/test", { session: "term-1a2b" });
    expect((await addTrack(shell, "A")).author).toBe("agent:claude:term-1a2b");
    tagger.close();
    await expect.poll(async () => (await addTrack(shell, `B${Date.now()}`)).author).toBe("cli:term-1a2b");
  });

  it("lets the shell end a transaction its agent began after the agent quit", async () => {
    const { connect, app, addTrack } = await setup();
    const shell = await connect("cli/test", { session: "term-1a2b" });
    await app.request("session.tag", { session: "term-1a2b", agent: "claude" });
    const begun = await shell.request("tx.begin", { label: "tighten intro" });
    await addTrack(shell, "A");
    await app.request("session.tag", { session: "term-1a2b", agent: null });
    const committed = await shell.request("tx.commit", {});
    expect(committed).toMatchObject({ tx: begun.tx, operations: 1 });
  });

  it("reports the caller's agent in status", async () => {
    const { dir, connect, app } = await setup();
    const shell = await connect("cli/test", { session: "term-1a2b" });
    expect((await shell.request("status", { cwd: dir })).caller.agent).toBeNull();
    await app.request("session.tag", { session: "term-1a2b", agent: "claude" });
    expect((await shell.request("status", { cwd: dir })).caller).toEqual({ client: "cli/test", session: "term-1a2b", agent: "claude" });
  });
});
