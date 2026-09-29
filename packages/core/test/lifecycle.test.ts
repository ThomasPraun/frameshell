import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { connectToDaemon, isDaemonUnavailable } from "@frameshell/protocol";
import { type Daemon, startDaemon } from "../src/index.js";
import { tempDir, uniqueSocketPath } from "./helpers.js";
import { join } from "node:path";

const daemons: Daemon[] = [];
afterEach(async () => {
  await Promise.all(daemons.splice(0).map((d) => d.close()));
});
async function start(options: Parameters<typeof startDaemon>[0]): Promise<Daemon> {
  const daemon = await startDaemon(options);
  daemons.push(daemon);
  return daemon;
}

describe("daemon lifecycle", () => {
  it("exits after the idle timeout once the last client leaves", async () => {
    const daemon = await start({ socketPath: uniqueSocketPath(), idleTimeoutMs: 150 });
    const conn = await connectToDaemon(daemon.socketPath, { client: "test" });
    await new Promise((r) => setTimeout(r, 300));
    // Still alive: a client is connected.
    expect((await conn.request("status", { cwd: tempDir() })).daemon.clients).toBe(1);
    conn.close();
    await daemon.closed;
    await expect(connectToDaemon(daemon.socketPath, { client: "test" })).rejects.toSatisfy(isDaemonUnavailable);
  });

  it("refuses to start when a live daemon owns the socket", async () => {
    const socketPath = uniqueSocketPath();
    await start({ socketPath });
    await expect(startDaemon({ socketPath })).rejects.toMatchObject({ code: "EADDRINUSE" });
  });

  it.skipIf(process.platform === "win32")("cleans up a stale socket left by a crashed daemon", async () => {
    const socketPath = uniqueSocketPath();
    await crashWhileListening(socketPath);
    expect(existsSync(socketPath)).toBe(true);

    const daemon = await start({ socketPath });
    const conn = await connectToDaemon(daemon.socketPath, { client: "test" });
    expect(conn.daemon.pid).toBe(process.pid);
    conn.close();
  });

  it.skipIf(process.platform === "win32")("refuses an over-long socket path the kernel would truncate", async () => {
    const socketPath = join(tempDir(), `${"x".repeat(120)}.sock`);
    await expect(startDaemon({ socketPath })).rejects.toMatchObject({
      code: "ENAMETOOLONG",
      message: expect.stringContaining("too long"),
    });
  });

  it.skipIf(process.platform === "win32")("never deletes a regular file sitting at the socket path", async () => {
    const socketPath = join(tempDir(), "not-a-socket");
    writeFileSync(socketPath, "keep me");
    await expect(startDaemon({ socketPath })).rejects.toThrow(/not a socket/);
    expect(existsSync(socketPath)).toBe(true);
  });
});

/** Child listens on the path, then dies by SIGKILL so no cleanup runs. */
async function crashWhileListening(socketPath: string): Promise<void> {
  const child = spawn(process.execPath, [
    "-e",
    `require("node:net").createServer().listen(${JSON.stringify(socketPath)}, () => console.log("ready"))`,
  ]);
  await new Promise<void>((resolve, reject) => {
    child.stdout.once("data", () => resolve());
    child.once("error", reject);
  });
  const exited = new Promise((r) => child.once("exit", r));
  child.kill("SIGKILL");
  await exited;
}
