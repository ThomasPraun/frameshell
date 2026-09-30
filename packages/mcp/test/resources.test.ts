import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type DaemonConnection, isMethodName } from "@frameshell/protocol";
import { ProjectResources, outlineUri } from "../src/resources.js";

// Outline resource path with a stubbed registry and daemon. `script.outline`
// is not on main yet (#25); the stdio contract test covers it once it is (#75).
let root: string;
let calls: { method: string; params: Record<string, unknown> }[];

function fakeDaemon(): DaemonConnection {
  return {
    request: async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params });
      if (method === "status") return { project: { dir: root } };
      return { scenes: [{ id: "s1", title: "Intro" }] };
    },
  } as unknown as DaemonConnection;
}

const withOutline = (method: string) => method === "script.outline" || isMethodName(method);

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "fs-mcp-res-"));
  calls = [];
  await mkdir(join(root, "scripts", "act1"), { recursive: true });
  await writeFile(join(root, "scripts", "launch.md"), "# Intro\n");
  await writeFile(join(root, "scripts", "act1", "open.md"), "# Open\n");
  await writeFile(join(root, "scripts", "notes.txt"), "not a script\n");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("script outline resource", () => {
  it("lists one outline per scripts/**/*.md and a template when the registry has script.outline", async () => {
    const resources = new ProjectResources(root, async () => fakeDaemon(), withOutline);
    const uris = (await resources.list()).resources.map((r) => r.uri);
    expect(uris).toContain(outlineUri("launch.md"));
    expect(uris).toContain(outlineUri("act1/open.md"));
    expect(uris.filter((uri) => uri.includes("/outline"))).toHaveLength(2);
    expect(resources.templates().map((t) => t.uriTemplate)).toContain("frameshell://scripts/{file}/outline");
  });

  it("reads an outline through script.outline with the file under scripts/", async () => {
    const resources = new ProjectResources(root, async () => fakeDaemon(), withOutline);
    const text = await resources.read(outlineUri("act1/open.md"));
    expect(JSON.parse(text)).toEqual({ scenes: [{ id: "s1", title: "Intro" }] });
    expect(calls.at(-1)).toEqual({ method: "script.outline", params: { cwd: root, file: "scripts/act1/open.md" } });
  });

  it("serves no outline while the registry lacks script.outline", async () => {
    const resources = new ProjectResources(root, async () => fakeDaemon(), () => false);
    const uris = (await resources.list()).resources.map((r) => r.uri);
    expect(uris.some((uri) => uri.includes("/outline"))).toBe(false);
    expect(resources.templates().map((t) => t.uriTemplate)).not.toContain("frameshell://scripts/{file}/outline");
    await expect(resources.read(outlineUri("launch.md"))).rejects.toThrow(/Unknown resource/);
    expect(calls.some((call) => call.method === "script.outline")).toBe(false);
  });
});
