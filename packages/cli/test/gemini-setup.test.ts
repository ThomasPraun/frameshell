import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  InvalidConfigError,
  connectGemini,
  disconnectGemini,
  geminiServer,
  geminiSettingsPath,
  geminiState,
  runSetup,
} from "../src/index.js";

// Seam under test: Connect Gemini CLI, on real files in a temp home.
const setup = { command: "/Users/ana/Library/Application Support/Frameshell/bin/frameshell", platform: "darwin" as const };

async function geminiHome(settings?: string) {
  const dir = await mkdtemp(join(tmpdir(), "fs-gemini-"));
  await mkdir(join(dir, ".gemini"));
  const file = geminiSettingsPath(dir);
  if (settings !== undefined) await writeFile(file, settings);
  return { dir, file };
}

const OTHER = '{\n  // my theme\n  "theme": "dark",\n  "mcpServers": {\n    "files": { "command": "npx", "args": [] }\n  }\n}\n';

describe("geminiServer", () => {
  it("runs the shim with a request timeout of an hour in milliseconds", () => {
    expect(geminiServer(setup)).toEqual({ command: setup.command, args: ["mcp"], timeout: 3_600_000 });
  });
});

describe("connectGemini", () => {
  it("adds the server keeping comments and other servers, and backs up", async () => {
    const { file } = await geminiHome(OTHER);
    expect(await geminiState(file, setup)).toMatchObject({ installed: true, connected: false, different: false });
    const backup = await connectGemini(file, setup);
    expect(await readFile(backup!, "utf8")).toBe(OTHER);
    const after = await readFile(file, "utf8");
    expect(after).toContain("// my theme");
    expect(JSON.parse(after.replace("// my theme", "")).mcpServers).toEqual({ files: { command: "npx", args: [] }, frameshell: geminiServer(setup) });
    expect(await geminiState(file, setup)).toMatchObject({ connected: true });
  });

  it("creates the file when there is none, and is idempotent", async () => {
    const { file } = await geminiHome();
    expect(await connectGemini(file, setup)).toBeNull();
    const text = await readFile(file, "utf8");
    expect(JSON.parse(text)).toEqual({ mcpServers: { frameshell: geminiServer(setup) } });
    expect(await connectGemini(file, setup)).toBeNull();
    expect(await readFile(file, "utf8")).toBe(text);
  });

  it("reports an entry that runs something else as different, and replaces it", async () => {
    const { file } = await geminiHome('{ "mcpServers": { "frameshell": { "command": "old", "args": ["mcp"] } } }\n');
    expect(await geminiState(file, setup)).toMatchObject({ connected: false, different: true });
    await connectGemini(file, setup);
    expect(await geminiState(file, setup)).toMatchObject({ connected: true, different: false });
  });

  it("refuses a file that is not JSON and changes nothing", async () => {
    const { file } = await geminiHome("{ nope");
    await expect(connectGemini(file, setup)).rejects.toThrow(InvalidConfigError);
    expect(await readFile(file, "utf8")).toBe("{ nope");
  });
});

describe("disconnectGemini", () => {
  it("removes only Frameshell's server", async () => {
    const { file } = await geminiHome(OTHER);
    await connectGemini(file, setup);
    await disconnectGemini(file);
    expect(await readFile(file, "utf8")).toBe(OTHER);
    expect(await disconnectGemini(file)).toBeNull();
  });
});

describe("frameshell setup gemini", () => {
  it("connects and removes under the given home", async () => {
    const { dir, file } = await geminiHome(OTHER);
    const run = async (args: string[]) => {
      let stdout = "";
      const code = await runSetup(args, { stdout: (t) => (stdout += t), stderr: () => undefined, env: {}, home: dir });
      return { code, stdout };
    };
    expect((await run(["gemini", "--command", "/opt/frameshell"])).code).toBe(0);
    expect(JSON.parse((await run(["gemini", "--command", "/opt/frameshell", "--status", "--json"])).stdout)).toMatchObject({ connected: true, file });
    expect((await run(["gemini", "--remove"])).code).toBe(0);
    expect(await readFile(file, "utf8")).toBe(OTHER);
    expect((await run(["gemini", "--status", "--remove"])).code).toBe(2);
  });
});
