import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  InvalidConfigError,
  claudeDesktopConfigFile,
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

describe("claudeDesktopConfigFile (#735)", () => {
  const home = "C:\\Users\\ana";
  const env = { APPDATA: "C:\\Users\\ana\\AppData\\Roaming", LOCALAPPDATA: "C:\\Users\\ana\\AppData\\Local" };
  const packages = "C:\\Users\\ana\\AppData\\Local\\Packages";
  const store = `${packages}\\Claude_pzs8sxrjxfjjc\\LocalCache\\Roaming\\Claude`;
  const plain = "C:\\Users\\ana\\AppData\\Roaming\\Claude";
  const fake = (dirs: Record<string, string[]>, existing: string[]) =>
    [async (dir: string) => dirs[dir] ?? [], async (dir: string) => existing.includes(dir)] as const;

  it("uses Claude-Data of a recent Store build first, even with the older redirected folder beside it", async () => {
    const data = "C:\\Users\\ana\\AppData\\Local\\Claude-Data";
    const [list, exists] = fake(
      { [data]: ["README.txt", "claude_pzs8sxrjxfjjc"], [packages]: ["Claude_pzs8sxrjxfjjc"] },
      [`${data}\\claude_pzs8sxrjxfjjc`, store, plain],
    );
    expect(await claudeDesktopConfigFile("win32", home, env, list, exists)).toBe(`${data}\\claude_pzs8sxrjxfjjc\\claude_desktop_config.json`);
  });

  it("uses the Microsoft Store build's redirected settings folder, which %APPDATA% does not show", async () => {
    const [list, exists] = fake({ [packages]: ["Microsoft.Photos_8wekyb3d8bbwe", "Claude_pzs8sxrjxfjjc"] }, [store]);
    expect(await claudeDesktopConfigFile("win32", home, env, list, exists)).toBe(`${store}\\claude_desktop_config.json`);
  });

  it("keeps %APPDATA%\\Claude for the plain installer, even with an unused Claude package beside it", async () => {
    const [list, exists] = fake({ [packages]: ["Claude_pzs8sxrjxfjjc"] }, [plain]);
    expect(await claudeDesktopConfigFile("win32", home, env, list, exists)).toBe(`${plain}\\claude_desktop_config.json`);
    const [none, nothing] = fake({}, [plain]);
    expect(await claudeDesktopConfigFile("win32", home, env, none, nothing)).toBe(`${plain}\\claude_desktop_config.json`);
  });

  it("points at the package before it ran once, and at %APPDATA%\\Claude with nothing installed", async () => {
    const [list, exists] = fake({ [packages]: ["Claude_pzs8sxrjxfjjc"] }, []);
    expect(await claudeDesktopConfigFile("win32", home, env, list, exists)).toBe(`${store}\\claude_desktop_config.json`);
    const [none, nothing] = fake({}, []);
    expect(await claudeDesktopConfigFile("win32", home, env, none, nothing)).toBe(`${plain}\\claude_desktop_config.json`);
  });

  it("is the plain path on macOS and none on Linux", async () => {
    expect(await claudeDesktopConfigFile("darwin", "/Users/ana", {})).toBe("/Users/ana/Library/Application Support/Claude/claude_desktop_config.json");
    expect(await claudeDesktopConfigFile("linux", "/home/ana", {})).toBeUndefined();
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
    expect(await claudeDesktopState(file, entry)).toEqual({ installed: true, connected: false, different: false });

    const backup = await connectClaudeDesktop(file, entry);
    expect(await readFile(backup!, "utf8")).toBe(before);
    const after = await readFile(file, "utf8");
    expect(JSON.parse(after)).toEqual({
      mcpServers: { files: { command: "npx", args: ["-y", "server-files"] }, frameshell: { command: shim, args: ["mcp"] } },
      theme: "dark",
    });
    expect(after).toContain('"files": { "command": "npx", "args": ["-y", "server-files"] }');
    expect(after.endsWith('  "theme": "dark"\n}\n')).toBe(true);
    expect(await claudeDesktopState(file, entry)).toEqual({ installed: true, connected: true, different: false });

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
    expect(await claudeDesktopState(file, entry)).toEqual({ installed: true, connected: false, different: false });
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
      different: false,
    });
  });
});
