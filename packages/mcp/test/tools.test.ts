import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { methodJsonSchemas } from "@frameshell/protocol";
import { createMcpServer } from "../src/index.js";

// Tool catalog through a real MCP client; no daemon needed to list tools.
const CWD = process.cwd();
let client: Client;

async function connect(): Promise<Client> {
  const server = createMcpServer({
    cwd: CWD,
    connect: () => Promise.reject(new Error("daemon unavailable in this test")),
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientSide);
  return client;
}

afterEach(async () => {
  await client?.close();
});

describe("MCP tool catalog", () => {
  it("has a tool for every public registry method, with the registry's description", async () => {
    const { tools } = await (await connect()).listTools();
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    const expected: Record<string, string> = {};
    for (const [method, schema] of Object.entries(methodJsonSchemas())) {
      if (schema.internal) continue;
      const name = method === "frame" ? "frame_capture" : method.replaceAll(".", "_").replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
      expected[name] = method;
      const tool = byName.get(name);
      expect(tool, `no tool for ${method}`).toBeDefined();
      // Registry text is written for models already: kept, bar method names in backticks.
      expect(tool!.description!.slice(0, 30)).toBe(schema.description.slice(0, 30));
      expect(tool!.description!.length).toBeGreaterThanOrEqual(schema.description.length);
    }
    expect(byName.has("handshake")).toBe(false);
    expect(byName.has("events_subscribe")).toBe(false);
    expect(byName.has("ui_publish")).toBe(false);
    expect([...byName.keys()].sort()).toEqual([...Object.keys(expected), "frames_strip"].sort());
    for (const name of byName.keys()) expect(name).toMatch(/^[a-z][a-z0-9_]*$/);
  });

  it("generates input schemas from the registry, with cwd defaulting to the server's directory", async () => {
    const { tools } = await (await connect()).listTools();
    const cut = tools.find((tool) => tool.name === "cut")!;
    expect(cut.inputSchema).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["from", "to"],
      properties: {
        from: { type: "number" },
        to: { type: "number" },
        cwd: { type: "string", description: expect.stringContaining(CWD) },
      },
    });
    const txBegin = tools.find((tool) => tool.name === "tx_begin")!;
    expect(txBegin.inputSchema).toMatchObject({ required: ["label"] });
    expect(txBegin.inputSchema.properties).not.toHaveProperty("cwd");
  });

  it("exposes the SPEC §7b UI state and navigation tools, each defaulting cwd", async () => {
    const { tools } = await (await connect()).listTools();
    const names = ["ui_state", "ui_seek", "ui_play", "ui_pause", "ui_select", "ui_open_file", "ui_show_tx_diff"];
    for (const name of names) {
      const tool = tools.find((candidate) => candidate.name === name);
      expect(tool, name).toBeDefined();
      expect(tool!.inputSchema.properties, name).toHaveProperty("cwd");
      expect(tool!.inputSchema.required ?? [], name).not.toContain("cwd");
    }
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    expect(byName.get("ui_state")!.description).toContain("`connected: false`");
    expect(byName.get("ui_seek")!.inputSchema.required).toEqual(["at"]);
    expect(byName.get("ui_show_tx_diff")!.inputSchema.required).toEqual(["target"]);
    expect(byName.get("ui_open_file")!.inputSchema.required).toEqual(["file"]);
    expect(byName.get("ui_select")!.inputSchema.required).toBeUndefined();
    // Cross-references name tools: `ui.state` in a description becomes `ui_state`.
    expect(byName.get("ui_seek")!.description).toContain("`ui_state`");
  });

  it("names tools, not methods, inside descriptions", async () => {
    const { tools } = await (await connect()).listTools();
    const render = tools.find((tool) => tool.name === "render")!;
    expect(render.description).toContain("`job_list`");
    expect(render.description).not.toContain("`job.list`");
  });

  it("returns images from frame_capture and frames_strip, with an optional out file", async () => {
    const { tools } = await (await connect()).listTools();
    const capture = tools.find((tool) => tool.name === "frame_capture")!;
    expect(capture.inputSchema.required).toEqual(["at"]);
    expect(capture.description).toMatch(/image/i);
    const strip = tools.find((tool) => tool.name === "frames_strip")!;
    expect(strip.inputSchema).toMatchObject({
      required: ["from", "to"],
      properties: { count: { type: "integer", minimum: 2, maximum: 16 } },
    });
  });

  it("reports an unreachable daemon as an actionable tool error, not a protocol error", async () => {
    const result = await (await connect()).callTool({ name: "timeline_show", arguments: {} });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/daemon unavailable in this test/);
  });

  it("rejects unknown tools with the list of tools", async () => {
    const result = await (await connect()).callTool({ name: "clip_explode", arguments: {} });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/Unknown tool `clip_explode`.*clip_add/);
  });
});
