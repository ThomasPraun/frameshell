import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import type { DaemonConnection } from "@frameshell/protocol";
import { createMcpServer } from "../src/index.js";

// Seam under test: the MCP server presents its client to the daemon as an agent target (ADR 0025) through a real
// MCP client, against a fake daemon that records requests. `active` stands in for the app's active window.

let calls: { method: string; params: Record<string, unknown> }[] = [];
let active: string | null = null;
let connects = 0;
let client: Client | undefined;

function fakeDaemon(projects: string[]): DaemonConnection {
  return {
    request: async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params });
      const cwd = params["cwd"] as string | undefined;
      const project = projects.find((dir) => cwd === dir || cwd?.startsWith(`${dir}/`)) ?? null;
      if (method === "status") return { project: project ? { dir: project } : null };
      if (method === "ui.active") return { dir: active };
      if (method === "target.register") return { dir: project, target: {} };
      if (method === "target.unregister") return { dir: project };
      if (method === "inbox.take") return { dir: project, target: "claude", references: [] };
      throw new Error(`fake daemon has no ${method}`);
    },
    on: () => () => {},
    closed: new Promise(() => {}),
    close: () => {},
  } as unknown as DaemonConnection;
}

async function connect(cwd: string, projects: string[], info = { name: "claude-code", title: "Claude Code", version: "2.1.317" }): Promise<Client> {
  calls = [];
  connects = 0;
  const server = createMcpServer({
    cwd,
    connect: async () => {
      connects++;
      return fakeDaemon(projects);
    },
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  client = new Client(info);
  await client.connect(clientSide);
  return client;
}

const registrations = () => calls.filter((call) => call.method === "target.register" || call.method === "target.unregister");

afterEach(async () => {
  await client?.close();
  client = undefined;
  active = null;
});

describe("the MCP server as an agent target", () => {
  it("registers its client on the project it started in as soon as it is initialized", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "frameshell-mcp-target-")));
    writeFileSync(join(dir, "frameshell.json"), "{}");
    await connect(join(dir, "assets"), [dir]);
    await expect.poll(registrations).toEqual([
      { method: "target.register", params: { cwd: dir, client: "claude-code", title: "Claude Code", kind: "mcp" } },
    ]);
  });

  it("outside any project, connects to nobody until a call, then registers on the app window's project and follows it", async () => {
    await connect("/", ["/videos/launch", "/videos/teaser"], { name: "claude-ai", title: "", version: "1" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(connects).toBe(0);

    active = "/videos/launch";
    await client!.callTool({ name: "inbox_take", arguments: {} });
    await expect.poll(registrations).toEqual([{ method: "target.register", params: { cwd: "/videos/launch", client: "claude-ai", kind: "mcp" } }]);

    active = "/videos/teaser";
    await client!.callTool({ name: "inbox_take", arguments: {} });
    await expect.poll(registrations).toEqual([
      { method: "target.register", params: { cwd: "/videos/launch", client: "claude-ai", kind: "mcp" } },
      { method: "target.register", params: { cwd: "/videos/teaser", client: "claude-ai", kind: "mcp" } },
      { method: "target.unregister", params: { cwd: "/videos/launch" } },
    ]);
  });

  it("offers `inbox_take` and `inbox_wait`, and no tool for the app's side", async () => {
    await connect("/", []);
    const names = (await client!.listTools()).tools.map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining(["inbox_take", "inbox_wait"]));
    expect(names.filter((name) => name.startsWith("target_") || name === "inbox_put")).toEqual([]);
  });
});
