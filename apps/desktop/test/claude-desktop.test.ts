import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  InvalidConfigError,
  claudeDesktopConfigPath,
  claudeDesktopState,
  connectClaudeDesktop,
  disconnectClaudeDesktop,
  serverEntry,
} from "../src/main/claude-desktop.js";

const shim = "/Users/ana/Library/Application Support/Frameshell/desktop/bin/frameshell";
const entry = serverEntry(shim, "darwin");

async function configIn(content?: string): Promise<string> {
  const dir = join(await mkdtemp(join(tmpdir(), "fs-claude-")), "Claude");
  await mkdir(dir);
  const file = join(dir, "claude_desktop_config.json");
  if (content !== undefined) await writeFile(file, content);
  return file;
}

describe("claudeDesktopConfigPath", () => {
  it("finds Claude Desktop's config on macOS and Windows, and none on Linux", () => {
    expect(claudeDesktopConfigPath("darwin", "/Users/ana", {})).toBe(
      "/Users/ana/Library/Application Support/Claude/claude_desktop_config.json",
    );
    expect(claudeDesktopConfigPath("win32", "C:\\Users\\ana", { APPDATA: "D:\\Roaming" })).toBe("D:\\Roaming\\Claude\\claude_desktop_config.json");
    expect(claudeDesktopConfigPath("win32", "C:\\Users\\ana", {})).toBe("C:\\Users\\ana\\AppData\\Roaming\\Claude\\claude_desktop_config.json");
    expect(claudeDesktopConfigPath("linux", "/home/ana", {})).toBeUndefined();
  });
});

describe("serverEntry", () => {
  it("runs the shim directly, and through cmd on Windows, where Claude Desktop cannot start a .cmd file", () => {
    expect(serverEntry("/usr/local/bin/frameshell", "darwin")).toEqual({ command: "/usr/local/bin/frameshell", args: ["mcp"] });
    expect(serverEntry("C:\\Users\\ana\\bin\\frameshell.cmd", "win32")).toEqual({
      command: "cmd",
      args: ["/c", "C:\\Users\\ana\\bin\\frameshell.cmd", "mcp"],
    });
  });
});

describe("connectClaudeDesktop", () => {
  it("adds only the frameshell server, keeping every other byte, and backs the file up", async () => {
    const before = '{\n  "mcpServers": {\n    "files": { "command": "npx", "args": ["-y", "server-files"] }\n  },\n  "theme": "dark"\n}\n';
    const file = await configIn(before);
    expect(await claudeDesktopState(file, entry)).toEqual({ installed: true, connected: false });

    const backup = await connectClaudeDesktop(file, entry);
    expect(await readFile(backup!, "utf8")).toBe(before);
    const after = await readFile(file, "utf8");
    expect(JSON.parse(after)).toEqual({
      mcpServers: { files: { command: "npx", args: ["-y", "server-files"] }, frameshell: { command: shim, args: ["mcp"] } },
      theme: "dark",
    });
    expect(after).toContain('"files": { "command": "npx", "args": ["-y", "server-files"] }');
    expect(after.endsWith('  "theme": "dark"\n}\n')).toBe(true);
    expect(await claudeDesktopState(file, entry)).toEqual({ installed: true, connected: true });

    // Connecting again points the entry at the current shim, once.
    await connectClaudeDesktop(file, serverEntry("/new/frameshell", "linux"));
    expect(JSON.parse(await readFile(file, "utf8")).mcpServers.frameshell).toEqual({ command: "/new/frameshell", args: ["mcp"] });
  });

  it("writes the entry formatted like the file when that changes nothing else", async () => {
    const other = { mcpServers: { files: { command: "npx", args: ["-y"] } }, theme: "dark" };
    const file = await configIn(`${JSON.stringify(other, null, 2)}\n`);
    await connectClaudeDesktop(file, entry);
    const expected = { ...other, mcpServers: { ...other.mcpServers, frameshell: { command: shim, args: ["mcp"] } } };
    expect(await readFile(file, "utf8")).toBe(`${JSON.stringify(expected, null, 2)}\n`);
  });

  it("creates the config when Claude Desktop has none yet", async () => {
    const file = await configIn();
    expect(await connectClaudeDesktop(file, entry)).toBeNull();
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ mcpServers: { frameshell: { command: shim, args: ["mcp"] } } });
  });

  it("leaves a config that is not JSON alone", async () => {
    const file = await configIn("{ broken");
    await expect(connectClaudeDesktop(file, entry)).rejects.toBeInstanceOf(InvalidConfigError);
    expect(await readFile(file, "utf8")).toBe("{ broken");
  });
});

describe("disconnectClaudeDesktop", () => {
  it("removes the frameshell server and nothing else", async () => {
    const file = await configIn('{\n  "mcpServers": {\n    "files": { "command": "npx" }\n  }\n}\n');
    await connectClaudeDesktop(file, entry);
    await disconnectClaudeDesktop(file);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ mcpServers: { files: { command: "npx" } } });
    expect(await claudeDesktopState(file, entry)).toEqual({ installed: true, connected: false });
  });

  it("does nothing when Frameshell is not in the config", async () => {
    const before = '{ "mcpServers": {} }';
    const file = await configIn(before);
    expect(await disconnectClaudeDesktop(file)).toBeNull();
    expect(await readFile(file, "utf8")).toBe(before);
  });
});

describe("claudeDesktopState", () => {
  it("reports Claude Desktop missing when its folder is", async () => {
    expect(await claudeDesktopState(join(tmpdir(), "no-such-claude", "claude_desktop_config.json"), entry)).toEqual({
      installed: false,
      connected: false,
    });
  });
});
