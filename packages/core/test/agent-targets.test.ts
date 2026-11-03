import { type AgentTarget, type AppDirs, type DaemonConnection, ErrorCode, type EventParams, RpcError, connectToDaemon } from "@frameshell/protocol";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentTargets, targetId } from "../src/targets/inbox.js";
import { type Daemon, startDaemon } from "../src/index.js";
import { tempDir, uniqueSocketPath } from "./helpers.js";

// Seams under test: the registry of agent targets and their inboxes (ADR 0025), alone and through the daemon's socket
// the way `frameshell mcp`, `frameshell ask` and the app use it.

const owner = () => ({});
const at = new Date("2026-11-02T10:00:00.000Z");

describe("AgentTargets", () => {
  it("names a target after the client's agent label, so Claude Code is `claude` like its app terminals", () => {
    expect(targetId("claude-code")).toBe("claude");
    expect(targetId("Codex CLI")).toBe("codex-cli");
    expect(targetId("!!!")).toBe("agent");
  });

  it("makes every connection of one client on one project one target, kept while any is registered", () => {
    const targets = new AgentTargets();
    const [a, b] = [owner(), owner()];
    targets.register(a, "/p", { client: "claude-code", title: "Claude Code", kind: "mcp" });
    targets.register(b, "/p", { client: "claude-code", kind: "mcp" });
    expect(targets.list("/p")).toEqual([{ id: "claude", kind: "mcp", client: "claude-code", title: "Claude Code", connections: 2, pending: 0 }]);
    targets.unregister(a, "/p");
    expect(targets.list("/p")[0]?.connections).toBe(1);
    targets.drop(b);
    expect(targets.list("/p")).toEqual([]);
  });

  it("queues references until read, oldest first, and reading removes them", () => {
    const targets = new AgentTargets({ now: () => at });
    const mcp = owner();
    targets.register(mcp, "/p", { client: "claude-code", kind: "mcp" });
    expect(targets.put("/p", "claude", ["[frameshell] clip c_1"])).toEqual({ target: expect.objectContaining({ pending: 1 }), read: false });
    targets.put("/p", "claude", ["[frameshell] clip c_2", "shorter"]);
    expect(targets.take("/p", "claude")).toEqual([
      { lines: ["[frameshell] clip c_1"], sentAt: at.toISOString() },
      { lines: ["[frameshell] clip c_2", "shorter"], sentAt: at.toISOString() },
    ]);
    expect(targets.take("/p", "claude")).toEqual([]);
    expect(targets.list("/p")[0]?.pending).toBe(0);
  });

  it("keeps a target whose connections closed while references wait, and forgets it once they are read", () => {
    const targets = new AgentTargets();
    const mcp = owner();
    targets.register(mcp, "/p", { client: "codex", kind: "mcp" });
    targets.put("/p", "codex", ["[frameshell] range 00:00:01.00–00:00:02.00"]);
    targets.drop(mcp);
    expect(targets.list("/p")).toEqual([expect.objectContaining({ id: "codex", connections: 0, pending: 1 })]);
    expect(targets.take("/p", "codex")).toHaveLength(1);
    expect(targets.list("/p")).toEqual([]);
  });

  it("keeps projects apart and moves a re-registration", () => {
    const targets = new AgentTargets();
    const conn = owner();
    targets.register(conn, "/a", { client: "claude-code", kind: "mcp" });
    targets.register(conn, "/b", { client: "claude-code", kind: "mcp" });
    expect(targets.targetOf(conn, "/a")).toBe("claude");
    targets.register(conn, "/a", { client: "terminal", kind: "cli" });
    expect(targets.list("/a").map((target) => target.id)).toEqual(["terminal"]);
    expect(targets.list("/b").map((target) => target.id)).toEqual(["claude"]);
  });

  it("refuses a reference for an unknown target, naming the known ones", () => {
    const targets = new AgentTargets();
    targets.register(owner(), "/p", { client: "claude-code", kind: "mcp" });
    let error: unknown;
    try {
      targets.put("/p", "codex", ["x"]);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(RpcError);
    expect((error as RpcError).code).toBe(ErrorCode.InvalidParams);
    expect((error as RpcError).data).toMatchObject({ targets: ["claude"] });
  });

  it("hands a reference straight to the oldest waiter, and reports each read", async () => {
    const changes: { targets: AgentTarget[]; read: string | null }[] = [];
    const targets = new AgentTargets({ onChanged: (_key, list, read) => changes.push({ targets: list, read }) });
    const [first, second] = [owner(), owner()];
    targets.register(first, "/p", { client: "terminal", kind: "cli" });
    targets.register(second, "/p", { client: "terminal", kind: "cli" });
    const one = targets.wait(first, "/p", "terminal", 10_000);
    const two = targets.wait(second, "/p", "terminal", 10_000);
    expect(targets.put("/p", "terminal", ["a"]).read).toBe(true);
    expect((await one).map((reference) => reference.lines)).toEqual([["a"]]);
    expect(changes.at(-1)?.read).toBe("terminal");
    targets.drop(second);
    expect(targets.put("/p", "terminal", ["b"]).read).toBe(false);
    await expect(Promise.race([two, new Promise((resolve) => setTimeout(() => resolve("still waiting"), 20))])).resolves.toBe("still waiting");
  });

  it("resolves a wait empty after its timeout", async () => {
    const targets = new AgentTargets();
    const conn = owner();
    targets.register(conn, "/p", { client: "terminal", kind: "cli" });
    await expect(targets.wait(conn, "/p", "terminal", 10)).resolves.toEqual([]);
    expect(targets.put("/p", "terminal", ["late"]).read).toBe(false);
  });
});

describe("agent targets over the daemon socket", () => {
  let daemon: Daemon | undefined;
  const connections: DaemonConnection[] = [];
  afterEach(async () => {
    for (const conn of connections.splice(0)) conn.close();
    await daemon?.close();
    daemon = undefined;
  });

  async function setup() {
    const dirs: AppDirs = { dataDir: tempDir(), configDir: tempDir() };
    daemon = await startDaemon({ socketPath: uniqueSocketPath(), dirs });
    const dir = join(tempDir(), "talk");
    const connect = async (client: string, options: { session?: string; agent?: string | null } = {}) => {
      const conn = await connectToDaemon(daemon!.socketPath, { client, ...options });
      connections.push(conn);
      return conn;
    };
    const app = await connect("desktop/0.1.0");
    await app.request("project.init", { dir });
    return { dir, connect, app };
  }

  it("lists a registered MCP client to the app, queues what the app sends and lets the client take it", async () => {
    const { dir, connect, app } = await setup();
    const events: EventParams<"target.changed">[] = [];
    app.on("target.changed", (params) => events.push(params));
    await app.request("events.subscribe", { cwd: dir, events: ["target.changed"] });
    const mcp = await connect("mcp/0.0.0");
    const registered = await mcp.request("target.register", { cwd: dir, client: "claude-code", title: "Claude Code", kind: "mcp" });
    expect(registered.target).toMatchObject({ id: "claude", connections: 1, pending: 0 });
    expect((await app.request("target.list", { cwd: dir })).targets.map((target) => target.id)).toEqual(["claude"]);

    const sent = await app.request("inbox.put", { cwd: dir, target: "claude", lines: ["[frameshell] clip c_a", "shorter"] });
    expect(sent).toMatchObject({ read: false, target: { pending: 1 } });
    const taken = await mcp.request("inbox.take", { cwd: dir });
    expect(taken).toMatchObject({ target: "claude", references: [{ lines: ["[frameshell] clip c_a", "shorter"] }] });
    expect((await mcp.request("inbox.take", { cwd: dir })).references).toEqual([]);
    await expect.poll(() => events.at(-1)).toMatchObject({ read: "claude", targets: [{ id: "claude", pending: 0 }] });

    mcp.close();
    await expect.poll(async () => (await app.request("target.list", { cwd: dir })).targets).toEqual([]);
  });

  it("lets a CLI run under that agent take its inbox without registering, and takes nothing for others", async () => {
    const { dir, connect, app } = await setup();
    const mcp = await connect("mcp/0.0.0");
    await mcp.request("target.register", { cwd: dir, client: "claude-code", kind: "mcp" });
    await app.request("inbox.put", { cwd: dir, target: "claude", lines: ["[frameshell] word w_000001"] });
    const stranger = await connect("cli/ask");
    expect(await stranger.request("inbox.take", { cwd: dir })).toMatchObject({ target: null, references: [] });
    const hook = await connect("cli/ask", { agent: "claude" });
    expect((await hook.request("inbox.take", { cwd: dir })).references).toHaveLength(1);
  });

  it("wakes `inbox.wait` with the next reference, and refuses a wait with no target", async () => {
    const { dir, connect, app } = await setup();
    const shell = await connect("cli/ask");
    await expect(shell.request("inbox.wait", { cwd: dir, timeout: 1 })).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    await shell.request("target.register", { cwd: dir, client: "terminal", kind: "cli" });
    const waiting = shell.request("inbox.wait", { cwd: dir, timeout: 30 });
    // Whether the wait or the reference reaches the daemon first, the waiter gets it.
    await app.request("inbox.put", { cwd: dir, target: "terminal", lines: ["[frameshell] range 00:00:01.00–00:00:02.00"] });
    expect((await waiting).references.map((reference) => reference.lines)).toEqual([["[frameshell] range 00:00:01.00–00:00:02.00"]]);
  });
});
