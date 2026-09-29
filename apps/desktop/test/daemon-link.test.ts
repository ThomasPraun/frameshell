import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { type Daemon, startDaemon } from "@frameshell/core";
import { ErrorCode } from "@frameshell/protocol";
import { DaemonLink } from "../src/main/daemon-link.js";

const socketPath = () =>
  process.platform === "win32"
    ? `\\\\.\\pipe\\frameshell-link-test-${randomUUID().slice(0, 8)}`
    : join(realpathSync(tmpdir()), `fs-link-${randomUUID().slice(0, 8)}.sock`);

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

function link(path: string, env: NodeJS.ProcessEnv = {}) {
  const daemonLink = new DaemonLink({
    socketPath: path,
    client: "desktop/test",
    env: { ...process.env, FRAMESHELL_SOCKET: path, ...env },
  });
  cleanups.push(() => daemonLink.close());
  return daemonLink;
}

describe("DaemonLink", () => {
  it("auto-starts the daemon on first request", async () => {
    const path = socketPath();
    const daemonLink = link(path, { FRAMESHELL_IDLE_TIMEOUT_MS: "1000" });
    const status = await daemonLink.request("status", { cwd: realpathSync(tmpdir()) });
    expect(status.daemon.socketPath).toBe(path);
    expect(status.caller.client).toBe("desktop/test");
    expect(status.daemon.pid).not.toBe(process.pid);
  });

  it("reconnects after the daemon restarts", async () => {
    const path = socketPath();
    let daemon: Daemon = await startDaemon({ socketPath: path });
    cleanups.push(() => daemon.close());
    const daemonLink = link(path);
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "frameshell-link-")));
    await daemonLink.request("status", { cwd });

    await daemon.close();
    daemon = await startDaemon({ socketPath: path });
    const status = await daemonLink.request("status", { cwd });
    expect(status.daemon.uptimeMs).toBeLessThan(5_000);
  });

  it("passes daemon errors through without retrying", async () => {
    const path = socketPath();
    const daemon = await startDaemon({ socketPath: path });
    cleanups.push(() => daemon.close());
    const outside = join(realpathSync(mkdtempSync(join(tmpdir(), "frameshell-link-"))), "x.md");
    await expect(link(path).request("file.write", { path: outside, content: "" })).rejects.toMatchObject({
      code: ErrorCode.OutsideProject,
    });
  });
});
