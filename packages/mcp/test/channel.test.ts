import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import type { DaemonConnection } from "@frameshell/protocol";
import { createMcpServer } from "../src/server.js";

// Seam under test: Claude Code channels opt-in (ADR 0025 decision 4) through a real MCP client against a fake daemon
// whose inbox.wait hands out the references the test queues.

interface Reference {
  lines: string[];
  sentAt: string;
}

let queue: Reference[] = [];
let waiters: ((references: Reference[]) => void)[] = [];
let waits = 0;
let client: Client | undefined;

function send(reference: Reference): void {
  const waiter = waiters.shift();
  if (waiter) waiter([reference]);
  else queue.push(reference);
}

function fakeDaemon(project: string): DaemonConnection {
  return {
    request: async (method: string) => {
      if (method === "status") return { project: { dir: project } };
      if (method === "target.register") return { dir: project, target: {} };
      if (method === "inbox.wait") {
        waits++;
        const ready = queue.splice(0);
        const references = ready.length > 0 ? ready : await new Promise<Reference[]>((resolve) => waiters.push(resolve));
        return { dir: project, target: "claude", references };
      }
      throw new Error(`fake daemon has no ${method}`);
    },
    on: () => () => {},
    closed: new Promise(() => {}),
    close: () => {},
  } as unknown as DaemonConnection;
}

async function connect(channel: boolean): Promise<{ client: Client; events: { method: string; params: unknown }[] }> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "frameshell-mcp-channel-")));
  writeFileSync(join(dir, "frameshell.json"), "{}");
  const server = createMcpServer({ cwd: dir, channel, connect: async () => fakeDaemon(dir) });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const connected = new Client({ name: "claude-code", version: "2.1.317" });
  client = connected;
  const events: { method: string; params: unknown }[] = [];
  connected.fallbackNotificationHandler = async (notification) => {
    events.push({ method: notification.method, params: notification.params });
  };
  await connected.connect(clientSide);
  return { client: connected, events };
}

afterEach(async () => {
  await client?.close();
  client = undefined;
  queue = [];
  waiters = [];
  waits = 0;
});

describe("Claude Code channel opt-in", () => {
  it("declares the claude/channel capability only when enabled", async () => {
    const off = await connect(false);
    expect(off.client.getServerCapabilities()?.experimental).toBeUndefined();
    await client?.close();
    const on = await connect(true);
    expect(on.client.getServerCapabilities()?.experimental).toEqual({ "claude/channel": {} });
    expect(on.client.getInstructions()).toContain('<channel source="frameshell">');
  });

  it("pushes each reference as a channel event with identifier meta keys, taking it from the inbox", async () => {
    const { events } = await connect(true);
    send({ lines: ["[frameshell] clip c_1", "look at this"], sentAt: "2026-11-02T10:00:00.000Z" });
    await expect.poll(() => events.length).toBe(1);
    expect(events[0]).toEqual({
      method: "notifications/claude/channel",
      params: { content: "[frameshell] clip c_1\nlook at this", meta: { target: "claude", sent_at: "2026-11-02T10:00:00.000Z" } },
    });
    for (const key of Object.keys((events[0]!.params as { meta: object }).meta)) expect(key).toMatch(/^[A-Za-z0-9_]+$/);
    send({ lines: ["[frameshell] word w_2"], sentAt: "2026-11-02T10:00:01.000Z" });
    await expect.poll(() => events.length).toBe(2);
  });

  it("pushes nothing and holds no inbox wait without the opt-in", async () => {
    const { client: c, events } = await connect(false);
    await c.listTools();
    send({ lines: ["[frameshell] clip c_1"], sentAt: "2026-11-02T10:00:00.000Z" });
    await new Promise((done) => setTimeout(done, 100));
    expect(events).toEqual([]);
    expect(waits).toBe(0);
    expect(queue).toHaveLength(1);
  });
});
