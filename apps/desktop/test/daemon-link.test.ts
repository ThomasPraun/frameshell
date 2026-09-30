import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { type Socket, createConnection, createServer } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { type Daemon, startDaemon } from "@frameshell/core";
import { type EventParams, ErrorCode, connectToDaemon } from "@frameshell/protocol";
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

describe("DaemonLink event subscriptions", () => {
  type Change = EventParams<"timeline.changed">;

  /** Daemon + a project + a CLI-like connection that edits it. */
  async function setup() {
    const path = socketPath();
    const daemon = await startDaemon({ socketPath: path });
    cleanups.push(() => daemon.close());
    const cli = await connectToDaemon(path, { client: "cli/test" });
    cleanups.push(() => cli.close());
    const dir = join(realpathSync(mkdtempSync(join(tmpdir(), "frameshell-link-"))), "talk");
    await cli.request("project.init", { dir });
    return { path, daemon, cli, dir };
  }

  /** Listener recording changes; `next()` resolves on the next one. */
  function recorder() {
    const seen: Change[] = [];
    let waiter: ((change: Change) => void) | undefined;
    return {
      seen,
      onEvent: (change: Change) => {
        seen.push(change);
        waiter?.(change);
      },
      next: () => new Promise<Change>((resolve) => (waiter = resolve)),
    };
  }

  it("forwards changes another client makes to the subscribed project", async () => {
    const { path, cli, dir } = await setup();
    const events = recorder();
    const subscription = await link(path).subscribe("timeline.changed", dir, events);
    expect(subscription.dir).toBe(dir);

    const next = events.next();
    const result = await cli.request("track.add", { cwd: dir, kind: "video" });
    expect(await next).toMatchObject({ project: dir, timeline: "main", revision: result.revision, author: "cli" });
  });

  it("restarts a lost daemon, resubscribes and asks listeners to resync", async () => {
    const { path, daemon, dir } = await setup();
    const events = recorder();
    let resynced!: () => void;
    const resync = new Promise<void>((resolve) => (resynced = resolve));
    const daemonLink = link(path, { FRAMESHELL_IDLE_TIMEOUT_MS: "1000" });
    await daemonLink.subscribe("timeline.changed", dir, { onEvent: events.onEvent, onResync: resynced });

    // No request pending: the link notices the loss itself and starts a daemon of its own.
    await daemon.close();
    await resync;

    const cli = await connectToDaemon(path, { client: "cli/test" });
    cleanups.push(() => cli.close());
    const next = events.next();
    await cli.request("track.add", { cwd: dir, kind: "audio" });
    expect(await next).toMatchObject({ project: dir, revision: 1 });
  });

  it("keeps delivering to the remaining subscriber when another one of the same project unsubscribes", async () => {
    const { path, cli, dir } = await setup();
    const daemonLink = link(path);
    const first = recorder();
    const second = recorder();
    const subscription = await daemonLink.subscribe("timeline.changed", dir, first);
    await daemonLink.subscribe("timeline.changed", dir, second);

    await subscription.unsubscribe();
    const next = second.next();
    await cli.request("track.add", { cwd: dir, kind: "video" });
    await next;
    expect(first.seen).toEqual([]);
  });
});

describe("DaemonLink retries", () => {
  /**
   * Proxy on its own endpoint in front of the daemon. On the first line matching `drop`, it forwards
   * the line and cuts the app's side before the reply comes back: the daemon applied the request, the
   * app saw a transport failure. Later connections pass through.
   */
  async function lossyProxy(target: string, drop: RegExp) {
    const path = socketPath();
    let dropped = 0;
    const sockets = new Set<Socket>();
    const server = createServer((client) => {
      const upstream = createConnection(target);
      sockets.add(client).add(upstream);
      let cut = false;
      let pending = "";
      upstream.on("data", (chunk) => {
        if (!cut) client.write(chunk);
      });
      client.on("data", (chunk) => {
        pending += chunk.toString("utf8");
        let newline: number;
        while ((newline = pending.indexOf("\n")) !== -1) {
          const line = pending.slice(0, newline + 1);
          pending = pending.slice(newline + 1);
          upstream.write(line);
          if (dropped === 0 && drop.test(line)) {
            dropped++;
            cut = true;
            client.destroy();
            return;
          }
        }
      });
      // Give the daemon time to run what it received before its side closes too.
      client.on("close", () => setTimeout(() => upstream.destroy(), 500));
      client.on("error", () => undefined);
      upstream.on("error", () => client.destroy());
    });
    await new Promise<void>((resolve) => server.listen(path, resolve));
    cleanups.push(
      () =>
        new Promise((resolve) => {
          for (const socket of sockets) socket.destroy();
          server.close(resolve);
        }),
    );
    return { path, dropped: () => dropped };
  }

  it("retries a mutating request whose reply was lost with the same idempotency key, so it applies once", async () => {
    const target = socketPath();
    const daemon = await startDaemon({ socketPath: target });
    cleanups.push(() => daemon.close());
    const cli = await connectToDaemon(target, { client: "cli/test" });
    cleanups.push(() => cli.close());
    const dir = join(realpathSync(mkdtempSync(join(tmpdir(), "frameshell-link-"))), "talk");
    await cli.request("project.init", { dir });
    const proxy = await lossyProxy(target, /"method":"track\.add"/);

    const result = await link(proxy.path).request("track.add", { cwd: dir, kind: "video", name: "Once" });
    expect(proxy.dropped()).toBe(1);
    expect(result.operation.op).toBe("track.add");
    const { tracks } = await cli.request("track.list", { cwd: dir });
    expect(tracks.map((track) => track.name)).toEqual(["Once"]);
    const history = await cli.request("history", { cwd: dir, timeline: "main" });
    expect(history.transactions.flatMap((tx) => tx.operations.map((op) => op.op))).toEqual(["track.add"]);
  });
});
