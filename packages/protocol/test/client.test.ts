import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { type Server, type Socket, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PROTOCOL_VERSION, connectToDaemon, readMessages, writeMessage } from "../src/index.js";

// Seam under test: the typed client against a scripted daemon speaking raw JSON-RPC lines.

const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise((resolve) => server.close(resolve));
});

/** Daemon stand-in: answers the handshake, then hands the socket to the test. */
async function fakeDaemon(): Promise<{ path: string; connected: Promise<Socket> }> {
  const path =
    process.platform === "win32"
      ? `\\\\.\\pipe\\frameshell-client-${randomUUID().slice(0, 8)}`
      : join(realpathSync(tmpdir()), `fs-client-${randomUUID().slice(0, 8)}.sock`);
  let accept!: (socket: Socket) => void;
  const connected = new Promise<Socket>((resolve) => (accept = resolve));
  const server = createServer((socket) => {
    readMessages(socket, (message) => {
      const { id, method } = message as { id: number; method: string };
      if (method !== "handshake") return;
      writeMessage(socket, { jsonrpc: "2.0", id, result: { protocolVersion: PROTOCOL_VERSION, daemonVersion: "0", pid: 1 } });
      accept(socket);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(path, resolve));
  return { path, connected };
}

const change = (revision: number) => ({
  project: "/p",
  timeline: "main",
  revision,
  author: "cli",
  changes: { added: [], updated: [], removed: [], range: null },
});

describe("DaemonConnection events", () => {
  it("delivers valid notifications to listeners and drops malformed ones", async () => {
    const { path, connected } = await fakeDaemon();
    const conn = await connectToDaemon(path, { client: "test" });
    const daemon = await connected;
    const seen: number[] = [];
    let done!: () => void;
    const last = new Promise<void>((resolve) => (done = resolve));
    conn.on("timeline.changed", ({ revision }) => {
      seen.push(revision);
      if (revision === 3) done();
    });

    writeMessage(daemon, { jsonrpc: "2.0", method: "timeline.changed", params: change(1) });
    writeMessage(daemon, { jsonrpc: "2.0", method: "timeline.changed", params: { ...change(2), revision: "two" } });
    writeMessage(daemon, { jsonrpc: "2.0", method: "timeline.nope", params: change(9) });
    writeMessage(daemon, { jsonrpc: "2.0", method: "timeline.changed", params: change(3) });
    await last;

    expect(seen).toEqual([1, 3]);
    conn.close();
  });

  it("stops calling a listener once it is removed", async () => {
    const { path, connected } = await fakeDaemon();
    const conn = await connectToDaemon(path, { client: "test" });
    const daemon = await connected;
    const removed: number[] = [];
    const off = conn.on("timeline.changed", ({ revision }) => removed.push(revision));
    let done!: () => void;
    const arrived = new Promise<void>((resolve) => (done = resolve));
    conn.on("timeline.changed", () => done());

    off();
    writeMessage(daemon, { jsonrpc: "2.0", method: "timeline.changed", params: change(1) });
    await arrived;
    expect(removed).toEqual([]);
    conn.close();
  });

  it("resolves `closed` when the daemon drops the connection", async () => {
    const { path, connected } = await fakeDaemon();
    const conn = await connectToDaemon(path, { client: "test" });
    (await connected).destroy();
    await expect(conn.closed).resolves.toBeUndefined();
  });
});
