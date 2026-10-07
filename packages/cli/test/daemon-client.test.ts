import { randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, realpathSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { type DaemonLaunch, connectOrStartDaemon, spawnDetachedDaemon } from "../src/daemon-client.js";

// Seam under test: connectOrStartDaemon, the one way the CLI, MCP server and app reach frameshelld.

const socketPath = () =>
  process.platform === "win32"
    ? `\\\\.\\pipe\\frameshell-dc-test-${randomUUID().slice(0, 8)}`
    : join(realpathSync(tmpdir()), `fs-dc-${randomUUID().slice(0, 8)}.sock`);

async function exited(pid: number): Promise<void> {
  for (let i = 0; i < 100; i++) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** Env for a spawned daemon: private socket, dirs and start counter. */
function daemonEnv(path: string, extra: Record<string, string> = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "frameshell-dc-")));
  const starts = realpathSync(mkdtempSync(join(tmpdir(), "frameshell-dc-starts-")));
  const env = {
    ...process.env,
    FRAMESHELL_SOCKET: path,
    FRAMESHELL_IDLE_TIMEOUT_MS: "200",
    FRAMESHELL_DATA_DIR: dir,
    FRAMESHELL_CONFIG_DIR: dir,
    FAKE_DAEMON_STARTS_DIR: starts,
    ...extra,
  };
  return { env, starts: () => readdirSync(starts).length };
}

const earlyExitDaemon = fileURLToPath(new URL("./fixtures/early-exit-daemon.mjs", import.meta.url));

describe("connectOrStartDaemon", () => {
  it("starts the daemon again when the one it spawned exits cleanly before any client reaches it", async () => {
    const path = socketPath();
    // Idle long enough that the real second daemon cannot also stop before it is reached.
    const { env, starts } = daemonEnv(path, { FAKE_DAEMON_EARLY_EXITS: "1", FRAMESHELL_IDLE_TIMEOUT_MS: "2000" });
    const conn = await connectOrStartDaemon({ socketPath: path, client: "test/dc", env, daemonEntry: earlyExitDaemon });
    try {
      expect(starts()).toBe(2);
    } finally {
      conn.close();
      await exited(conn.daemon.pid);
    }
  });

  it("gives up well before the start timeout when every daemon it spawns exits cleanly unreached", async () => {
    const path = socketPath();
    const { env, starts } = daemonEnv(path, { FAKE_DAEMON_EARLY_EXITS: "1000" });
    const began = Date.now();
    await expect(
      connectOrStartDaemon({ socketPath: path, client: "test/dc", env, daemonEntry: earlyExitDaemon, startTimeoutMs: 60_000 }),
    ).rejects.toThrow(/exited before accepting a connection/);
    expect(Date.now() - began).toBeLessThan(30_000);
    expect(starts()).toBe(3);
  });

  it("starts each daemon through the given launcher, with this executable, the installed entry and the env", async () => {
    const path = socketPath();
    const { env } = daemonEnv(path, { FRAMESHELL_IDLE_TIMEOUT_MS: "2000" });
    const launches: DaemonLaunch[] = [];
    const conn = await connectOrStartDaemon({
      socketPath: path,
      client: "test/dc",
      env,
      launch: (launch) => {
        launches.push(launch);
        return spawnDetachedDaemon(launch);
      },
    });
    try {
      expect(launches).toHaveLength(1);
      expect(launches[0]?.execPath).toBe(process.execPath);
      expect(launches[0]?.entry).toMatch(/frameshelld\.js$/);
      expect(launches[0]?.env).toBe(env);
      expect(conn.daemon.pid).not.toBe(process.pid);
    } finally {
      conn.close();
      await exited(conn.daemon.pid);
    }
  });

  it("starts a fresh daemon when the one it reached stops on its idle timeout mid-handshake", async () => {
    const path = socketPath();
    // Stand-in for a daemon whose idle timer fires as the client connects: it drops the connection
    // unanswered and stops listening, exactly as frameshelld's idle close does.
    const dying = createServer((socket) => {
      socket.destroy();
      dying.close();
    });
    await new Promise<void>((resolve) => dying.listen(path, resolve));

    const { env } = daemonEnv(path);
    const conn = await connectOrStartDaemon({ socketPath: path, client: "test/dc", env });
    try {
      expect(conn.daemon.pid).not.toBe(process.pid);
    } finally {
      conn.close();
      await exited(conn.daemon.pid);
    }
  });
});
