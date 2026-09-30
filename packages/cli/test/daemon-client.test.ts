import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { connectOrStartDaemon } from "../src/daemon-client.js";

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

describe("connectOrStartDaemon", () => {
  it("starts a fresh daemon when the one it reached stops on its idle timeout mid-handshake", async () => {
    const path = socketPath();
    // Stand-in for a daemon whose idle timer fires as the client connects: it drops the connection
    // unanswered and stops listening, exactly as frameshelld's idle close does.
    const dying = createServer((socket) => {
      socket.destroy();
      dying.close();
    });
    await new Promise<void>((resolve) => dying.listen(path, resolve));

    const dir = realpathSync(mkdtempSync(join(tmpdir(), "frameshell-dc-")));
    const env = {
      ...process.env,
      FRAMESHELL_SOCKET: path,
      FRAMESHELL_IDLE_TIMEOUT_MS: "200",
      FRAMESHELL_DATA_DIR: dir,
      FRAMESHELL_CONFIG_DIR: dir,
    };
    const conn = await connectOrStartDaemon({ socketPath: path, client: "test/dc", env });
    try {
      expect(conn.daemon.pid).not.toBe(process.pid);
    } finally {
      conn.close();
      await exited(conn.daemon.pid);
    }
  });
});
