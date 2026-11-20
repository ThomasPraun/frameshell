import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import type { DaemonConnection } from "@frameshell/protocol";
import { CORE_SKILL_FILES } from "../../core/src/skills/core-skill.js";
import { RESOURCE_TEMPLATES, createMcpServer } from "../src/index.js";

// Seam under test: the agent skill served as MCP resources, through a real MCP client against a fake daemon that has
// no project, so nothing but the bundled files can answer.

let client: Client | undefined;

/** A daemon that knows no project and no app window. */
function fakeDaemon(): DaemonConnection {
  return {
    request: async (method: string) => {
      if (method === "status") return { project: null };
      if (method === "ui.active") return { dir: null };
      throw new Error(`fake daemon has no ${method}`);
    },
    on: () => () => {},
    closed: new Promise(() => {}),
    close: () => {},
  } as unknown as DaemonConnection;
}

async function connect(skill?: Record<string, string>): Promise<Client> {
  const server = createMcpServer({ cwd: "/not/a/project", connect: async () => fakeDaemon(), ...(skill ? { skill } : {}) });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  client = new Client({ name: "claude-desktop", version: "0.0.0" });
  await client.connect(clientSide);
  return client;
}

async function text(uri: string): Promise<string> {
  const { contents } = await client!.readResource({ uri });
  expect(contents).toHaveLength(1);
  expect(contents[0]).toMatchObject({ uri, mimeType: "text/markdown" });
  return (contents[0] as { text: string }).text;
}

afterEach(async () => {
  await client?.close();
  client = undefined;
});

describe("skill resources", () => {
  it("serves the bundled skill with no project open: SKILL.md at frameshell://skill, every other file under its own path", async () => {
    await connect(CORE_SKILL_FILES);
    const { resources } = await client!.listResources();
    const uris = resources.map((r) => r.uri);
    expect(uris).toContain("frameshell://status");
    expect(uris[1]).toBe("frameshell://skill");
    expect(uris).toContain("frameshell://skill/reference/cli.md");
    expect(uris).not.toContain("frameshell://skill/SKILL.md");
    expect(uris.filter((uri) => uri.startsWith("frameshell://skill"))).toHaveLength(Object.keys(CORE_SKILL_FILES).length);

    expect(await text("frameshell://skill")).toBe(CORE_SKILL_FILES["SKILL.md"]);
    for (const [file, content] of Object.entries(CORE_SKILL_FILES)) {
      if (file !== "SKILL.md") expect(await text(`frameshell://skill/${file}`), file).toBe(content);
    }
  });

  it("serves the options section of the skill and every file the skill table links, by the URI its links give", async () => {
    await connect(CORE_SKILL_FILES);
    const skill = await text("frameshell://skill");
    expect(skill).toContain("## Options, not obligations");
    expect(skill).toContain("plugin_catalog");
    const linked = [...skill.matchAll(/\]\((reference\/[^)#]+\.md)/g)].map((match) => match[1]!);
    expect(linked.length).toBeGreaterThan(10);
    for (const file of new Set(linked)) expect(await text(`frameshell://skill/${file}`), file).toBe(CORE_SKILL_FILES[file]);
  });

  it("declares the skill's template, and the URIs the skill docs may name", async () => {
    await connect(CORE_SKILL_FILES);
    const { resourceTemplates } = await client!.listResourceTemplates();
    expect(resourceTemplates.map((t) => t.uriTemplate)).toContain("frameshell://skill/{path}");
    expect(RESOURCE_TEMPLATES).toEqual(expect.arrayContaining(["frameshell://skill", "frameshell://skill/{path}"]));
  });

  it("an unknown skill file is an error that names the files, not a project error", async () => {
    await connect({ "SKILL.md": "# Skill", "reference/a.md": "# A" });
    await expect(client!.readResource({ uri: "frameshell://skill/reference/missing.md" })).rejects.toThrow(/No skill file reference\/missing\.md.*SKILL\.md, reference\/a\.md/);
    await expect(client!.readResource({ uri: "frameshell://skill/../status" })).rejects.toThrow(/No skill file/);
  });

  it("points to the skill and the catalog in the instructions", async () => {
    await connect(CORE_SKILL_FILES);
    const instructions = client!.getInstructions()!;
    expect(instructions).toContain("`frameshell://skill`");
    expect(instructions).toContain("`plugin_catalog`");
  });

  it("serves no skill resource and does not mention it when the server is given none", async () => {
    await connect();
    const { resources } = await client!.listResources();
    expect(resources.map((r) => r.uri)).toEqual(["frameshell://status"]);
    expect((await client!.listResourceTemplates()).resourceTemplates.map((t) => t.uriTemplate)).not.toContain("frameshell://skill/{path}");
    expect(client!.getInstructions()).not.toContain("frameshell://skill");
    expect(client!.getInstructions()).toContain("`plugin_catalog`");
  });
});
