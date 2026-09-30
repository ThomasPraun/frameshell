import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { startDaemon } from "@frameshell/core";
import { type DaemonConnection, ErrorCode, type UiCommand, type UiView, connectToDaemon } from "@frameshell/protocol";
import { DaemonLink } from "../src/main/daemon-link.js";
import { UiBridge } from "../src/main/ui-bridge.js";

// Seam under test: main's UiBridge over a real DaemonLink and daemon, as an MCP client sees the app through `ui.*`.

const socketPath = () =>
  process.platform === "win32"
    ? `\\\\.\\pipe\\frameshell-ui-test-${randomUUID().slice(0, 8)}`
    : join(realpathSync(tmpdir()), `fs-ui-${randomUUID().slice(0, 8)}.sock`);

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const idle: UiView = {
  timeline: "main",
  playhead: 0,
  playing: false,
  duration: 12,
  selection: { clips: [], words: [], range: null, history: null },
  editor: { active: null, tabs: [] },
  visible: { from: 0, to: 12 },
};

/** Daemon, a project, the app's link with its bridge (windows answer via `windows`), and an MCP-like connection. */
async function setup(path = socketPath()) {
  let daemon = await startDaemon({ socketPath: path });
  cleanups.push(() => daemon.close());
  const mcp: DaemonConnection = await connectToDaemon(path, { client: "mcp/test" });
  cleanups.push(() => mcp.close());
  const dir = join(realpathSync(mkdtempSync(join(tmpdir(), "frameshell-ui-"))), "talk");
  await mcp.request("project.init", { dir });

  const link = new DaemonLink({ socketPath: path, client: "desktop/test", env: { ...process.env, FRAMESHELL_SOCKET: path } });
  cleanups.push(() => link.close());
  /** Window id → what it does with a command; absent = window gone. */
  const windows = new Map<string, (command: UiCommand) => { error: string | null; state: UiView }>();
  const bridge: UiBridge = new UiBridge({
    request: (method, params) => link.request(method, params),
    deliver: (view, _project, { id, command }) => {
      const handle = windows.get(view);
      if (!handle) return false;
      const { error, state } = handle(command);
      bridge.reply(view, id, error, state);
      return true;
    },
  });
  link.on("ui.command", (params) => bridge.command(params));
  link.onReconnect(() => bridge.resync());
  return {
    dir,
    mcp,
    link,
    bridge,
    windows,
    restart: async () => {
      await daemon.close();
      daemon = await startDaemon({ socketPath: path });
    },
  };
}

describe("UiBridge", () => {
  it("publishes a window's state and carries navigation to it and back", async () => {
    const { dir, mcp, bridge, windows } = await setup();
    let state = idle;
    windows.set("1", (command) => {
      if (command.kind === "seek") state = { ...state, playhead: command.at };
      return { error: null, state };
    });
    bridge.publish("1", dir, idle);
    await expect.poll(() => mcp.request("ui.state", { cwd: dir })).toMatchObject({ connected: true, playhead: 0 });

    await expect(mcp.request("ui.seek", { cwd: dir, at: 3 })).resolves.toMatchObject({ playhead: 3 });
    // A burst of reports ends with the newest state at the daemon.
    for (let i = 1; i <= 20; i++) bridge.publish("1", dir, { ...idle, playhead: i / 10 });
    await expect.poll(() => mcp.request("ui.state", { cwd: dir })).toMatchObject({ playhead: 2 });
  });

  it("refuses at once a command for a window that closed, and forgets a detached one", async () => {
    const { dir, mcp, bridge } = await setup();
    bridge.publish("1", dir, idle);
    await expect.poll(() => mcp.request("ui.state", { cwd: dir })).toMatchObject({ connected: true });
    await expect(mcp.request("ui.play", { cwd: dir })).rejects.toMatchObject({
      code: ErrorCode.UiCommandFailed,
      message: expect.stringContaining("closed"),
    });
    bridge.detach("1");
    await expect.poll(() => mcp.request("ui.state", { cwd: dir })).toEqual({ connected: false });
  });

  it("registers the windows again after the daemon restarts", async () => {
    const { dir, bridge, link, restart } = await setup();
    // Reconnects happen while an event subscription exists, as for every window showing a project.
    await link.subscribe("timeline.changed", dir, { onEvent: () => undefined });
    bridge.publish("1", dir, { ...idle, playhead: 5 });
    await expect.poll(() => link.request("ui.state", { cwd: dir })).toMatchObject({ playhead: 5 });

    await restart();
    await expect.poll(() => link.request("ui.state", { cwd: dir }), { timeout: 10_000 }).toMatchObject({ connected: true, playhead: 5 });
  });
});
