import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  type CallToolResult,
  ResourceListChangedNotificationSchema,
  ResourceUpdatedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import type { DaemonConnection } from "@frameshell/protocol";
import { createMcpServer } from "../src/index.js";

// Seam under test: the MCP server's default project (ADR 0014) through a real MCP client, against a fake daemon whose
// `ui.active` stands in for the broker: `active` is the project of the window the user focused last.

const A = "/videos/launch";
const B = "/videos/teaser";
const PROJECTS = [A, B];

let active: string | null;
let calls: { method: string; params: Record<string, unknown> }[];
let client: Client | undefined;

function fakeDaemon(): DaemonConnection {
  return {
    request: async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params });
      const cwd = params["cwd"] as string | undefined;
      const project = PROJECTS.find((dir) => cwd === dir || cwd?.startsWith(`${dir}/`)) ?? null;
      if (method === "status") return { project: project ? { dir: project } : null };
      if (method === "ui.active") return { dir: active };
      if (method === "timeline.show") return { timeline: params["timeline"] ?? "main", project };
      if (method === "events.subscribe" || method === "events.unsubscribe") return { dir: project, events: [] };
      throw new Error(`fake daemon has no ${method}`);
    },
    on: () => () => {},
    closed: new Promise(() => {}),
    close: () => {},
  } as unknown as DaemonConnection;
}

async function connect(cwd: string): Promise<Client> {
  calls = [];
  const server = createMcpServer({ cwd, connect: async () => fakeDaemon() });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientSide);
  return client;
}

async function call(name: string, args: Record<string, unknown> = {}): Promise<CallToolResult> {
  return (await client!.callTool({ name, arguments: args })) as CallToolResult;
}

const texts = (result: CallToolResult) => result.content.flatMap((part) => (part.type === "text" ? [part.text] : []));

afterEach(async () => {
  await client?.close();
  client = undefined;
  active = null;
});

describe("default project of an MCP server started outside any project", () => {
  it("acts on the project of the app's active window, names it in the result, and follows a window switch", async () => {
    active = A;
    await connect("/");
    const first = await call("status");
    expect(first.isError).toBeFalsy();
    expect(JSON.parse(texts(first)[0]!)).toEqual({ project: { dir: A } });
    expect(texts(first)[1]).toContain(`Project: ${A}`);
    expect(calls).toContainEqual({ method: "status", params: { cwd: A } });

    active = B;
    const second = await call("timeline_show");
    expect(JSON.parse(texts(second)[0]!)).toMatchObject({ project: B });
    expect(texts(second)[1]).toContain(`Project: ${B}`);
  });

  it("fails with what to do when no app window shows a project", async () => {
    await connect("/");
    const result = await call("timeline_show");
    expect(result.isError).toBe(true);
    expect(texts(result)[0]).toMatch(/^ProjectNotFound: .*Open a project in Frameshell, or pass cwd\./);
    expect(calls.some((entry) => entry.method === "timeline.show")).toBe(false);
  });

  it("takes an explicit cwd as given, without asking the app", async () => {
    active = A;
    await connect("/");
    const result = await call("timeline_show", { cwd: `${B}/assets` });
    expect(JSON.parse(texts(result)[0]!)).toMatchObject({ project: B });
    expect(texts(result)).toHaveLength(1);
    expect(calls.map((entry) => entry.method)).toEqual(["timeline.show"]);
  });

  it("keeps the project the server started in when there is one, whatever the app shows", async () => {
    active = B;
    await connect(`${A}/scripts`);
    const result = await call("timeline_show");
    expect(JSON.parse(texts(result)[0]!)).toMatchObject({ project: A });
    expect(texts(result)).toHaveLength(1);
    expect(calls.some((entry) => entry.method === "ui.active")).toBe(false);
    expect(calls).toContainEqual({ method: "timeline.show", params: { cwd: `${A}/scripts` } });
  });

  it("serves resources of the active window's project and re-announces them on a switch", async () => {
    active = A;
    const mcp = await connect("/");
    const updated: string[] = [];
    let listChanged = 0;
    mcp.setNotificationHandler(ResourceUpdatedNotificationSchema, (note) => void updated.push(note.params.uri));
    mcp.setNotificationHandler(ResourceListChangedNotificationSchema, () => void listChanged++);

    const status = await mcp.readResource({ uri: "frameshell://status" });
    expect(JSON.parse((status.contents[0] as { text: string }).text)).toEqual({ project: { dir: A } });
    await mcp.subscribeResource({ uri: "frameshell://timelines/main" });
    expect(calls).toContainEqual({ method: "events.subscribe", params: { cwd: A, events: ["timeline.changed", "proposal.changed"] } });

    active = B;
    const timeline = await mcp.readResource({ uri: "frameshell://timelines/main" });
    expect(JSON.parse((timeline.contents[0] as { text: string }).text)).toMatchObject({ project: B });
    await expect.poll(() => updated).toContain("frameshell://timelines/main");
    expect(listChanged).toBeGreaterThan(0);
    expect(calls).toContainEqual({ method: "events.subscribe", params: { cwd: B, events: ["timeline.changed", "proposal.changed"] } });
    expect(calls).toContainEqual({ method: "events.unsubscribe", params: { cwd: A, events: ["timeline.changed", "proposal.changed"] } });
  });

  it("lists only the status resource, and refuses project resources, while there is no project", async () => {
    const mcp = await connect("/");
    const { resources } = await mcp.listResources();
    expect(resources.map((resource) => resource.uri)).toEqual(["frameshell://status"]);
    await expect(mcp.readResource({ uri: "frameshell://timelines/main" })).rejects.toThrow(/Open a project in Frameshell, or pass cwd/);
  });
});
