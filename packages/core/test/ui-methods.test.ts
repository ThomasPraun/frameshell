import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type DaemonConnection, ErrorCode, type UiView, connectToDaemon } from "@frameshell/protocol";
import { type Daemon, startDaemon } from "../src/index.js";
import { tempDir, uniqueSocketPath } from "./helpers.js";

// Seam under test: a real daemon over its socket. One connection plays the app (publishes, answers `ui.command`),
// another the MCP server (calls `ui.*`), as SPEC §7b routes them: the daemon is the only broker.

let daemon: Daemon | undefined;
const connections: DaemonConnection[] = [];
afterEach(async () => {
  for (const conn of connections.splice(0)) conn.close();
  await daemon?.close();
  daemon = undefined;
});

async function connect(client: string): Promise<DaemonConnection> {
  const conn = await connectToDaemon(daemon!.socketPath, { client });
  connections.push(conn);
  return conn;
}

const idle: UiView = {
  timeline: "main",
  playhead: 0,
  playing: false,
  duration: 20,
  selection: { clips: [], words: [], range: null, history: null, region: null, points: [] },
  editor: { active: null, tabs: [] },
  visible: { from: 0, to: 20 },
};

/** A fake app window: applies seeks and file opens to its state, refuses the rest. */
function fakeApp(app: DaemonConnection, view: string) {
  let state = idle;
  app.on("ui.command", ({ view: target, id, command }) => {
    if (target !== view) return;
    let error: string | null = null;
    if (command.kind === "seek") state = { ...state, playhead: command.at };
    else if (command.kind === "openFile") state = { ...state, editor: { active: command.path, tabs: [command.path] } };
    else error = `${command.kind} is not supported by this fake`;
    void app.request("ui.reply", { view, id, error, state });
  });
}

describe("ui.* methods", () => {
  it("report { connected: false } until the app publishes, then relay navigation to it", async () => {
    daemon = await startDaemon({ socketPath: uniqueSocketPath() });
    const mcp = await connect("mcp/test");
    const dir = join(tempDir(), "talk");
    await mcp.request("project.init", { dir });
    await expect(mcp.request("ui.state", { cwd: dir })).resolves.toEqual({ connected: false });
    await expect(mcp.request("ui.seek", { cwd: dir, at: 2 })).rejects.toMatchObject({ code: ErrorCode.UiNotConnected });

    const app = await connect("desktop/test");
    fakeApp(app, "w1");
    await expect(app.request("ui.publish", { cwd: dir, view: "w1", state: idle })).resolves.toEqual({ dir });
    await expect(mcp.request("ui.state", { cwd: join(dir, "timelines") })).resolves.toMatchObject({
      connected: true,
      project: dir,
      playhead: 0,
      visible: { from: 0, to: 20 },
    });

    await expect(mcp.request("ui.seek", { cwd: dir, at: 7.5 })).resolves.toMatchObject({ project: dir, playhead: 7.5 });
    await expect(mcp.request("ui.state", { cwd: dir })).resolves.toMatchObject({ playhead: 7.5 });
    await expect(mcp.request("ui.openFile", { cwd: dir, file: join(dir, "timelines", "main.json") })).resolves.toMatchObject({
      editor: { active: "timelines/main.json" },
    });
    await expect(mcp.request("ui.play", { cwd: dir })).rejects.toMatchObject({
      code: ErrorCode.UiCommandFailed,
      data: { command: "play", reason: "play is not supported by this fake" },
    });
    await expect(mcp.request("ui.openFile", { cwd: dir, file: "../elsewhere.md" })).rejects.toMatchObject({
      code: ErrorCode.OutsideProject,
    });

    // Closing the app's connection disconnects its windows.
    app.close();
    await app.closed;
    await expect.poll(() => mcp.request("ui.state", { cwd: dir })).toEqual({ connected: false });
  });

  it("ui.select resolves a person by name for the app, and refuses an unknown one before asking it (ADR 0020)", async () => {
    daemon = await startDaemon({ socketPath: uniqueSocketPath() });
    const mcp = await connect("mcp/test");
    const app = await connect("desktop/test");
    const dir = join(tempDir(), "talk");
    await mcp.request("project.init", { dir });
    const { person } = await mcp.request("people.add", { cwd: dir, name: "Juan" });
    const commands: unknown[] = [];
    app.on("ui.command", ({ view, id, command }) => {
      commands.push(command);
      void app.request("ui.reply", { view, id, error: null, state: idle });
    });
    await app.request("ui.publish", { cwd: dir, view: "w1", state: idle });

    await mcp.request("ui.select", { cwd: dir, person: { id: "juan" } });
    expect(commands).toEqual([expect.objectContaining({ kind: "select", person: { id: person.id, what: "speaks" }, clips: [], words: [] })]);
    await expect(mcp.request("ui.select", { cwd: dir, person: { id: "Ana", what: "onscreen" } })).rejects.toMatchObject({
      code: ErrorCode.InvalidOperation,
      message: expect.stringContaining(`no person "Ana" (people: Juan (${person.id}))`),
    });
    expect(commands).toHaveLength(1);
  });

  it("forgets a detached window at once", async () => {
    daemon = await startDaemon({ socketPath: uniqueSocketPath() });
    const app = await connect("desktop/test");
    const dir = join(tempDir(), "talk");
    await app.request("project.init", { dir });
    await app.request("ui.publish", { cwd: dir, view: "w1", state: idle });
    await app.request("ui.detach", { view: "w1" });
    await expect(app.request("ui.state", { cwd: dir })).resolves.toEqual({ connected: false });
  });
});

describe("ui.active", () => {
  it("answers the project of the window focused last, null when no window shows one", async () => {
    daemon = await startDaemon({ socketPath: uniqueSocketPath() });
    const mcp = await connect("mcp/test");
    const app = await connect("desktop/test");
    const one = join(tempDir(), "one");
    const two = join(tempDir(), "two");
    await mcp.request("project.init", { dir: one });
    await mcp.request("project.init", { dir: two });
    await expect(mcp.request("ui.active", {})).resolves.toEqual({ dir: null });

    await app.request("ui.publish", { cwd: one, view: "w1", state: idle, focused: true });
    await app.request("ui.publish", { cwd: join(two, "scripts"), view: "w2", state: idle, focused: false });
    await expect(mcp.request("ui.active", {})).resolves.toEqual({ dir: one });
    await app.request("ui.publish", { cwd: join(two, "scripts"), view: "w2", state: idle, focused: true });
    await expect(mcp.request("ui.active", {})).resolves.toEqual({ dir: two });

    await app.request("ui.detach", { view: "w2" });
    await expect(mcp.request("ui.active", {})).resolves.toEqual({ dir: one });
    app.close();
    await app.closed;
    await expect.poll(() => mcp.request("ui.active", {})).toEqual({ dir: null });
  });
});
