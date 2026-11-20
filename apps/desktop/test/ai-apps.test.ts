import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { aiApps, aiAppStatus, aiAppsPlace, changeAiApp, serverSnippets } from "../src/main/ai-apps.js";

const setup = { command: "/opt/frameshell/bin/frameshell", platform: "darwin" as const };

async function testHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), "fs-ai-apps-"));
}

describe("aiAppsPlace", () => {
  it("puts every app's settings under FRAMESHELL_TEST_HOME and ignores the variables that move them", () => {
    const env = { FRAMESHELL_TEST_HOME: "/tmp/home", APPDATA: "C:\\real", CODEX_HOME: "/real/codex", CLAUDE_CONFIG_DIR: "/real/claude" };
    expect(aiAppsPlace(env, setup)).toEqual({ home: "/tmp/home", env: {}, setup });
    expect(aiAppsPlace({ CODEX_HOME: "/real/codex" }, setup)).toEqual({ home: homedir(), env: { CODEX_HOME: "/real/codex" }, setup });
  });
});

describe("AI apps", () => {
  it("reads each app as not installed in an empty home, and Claude Desktop as missing on Linux", async () => {
    const home = await testHome();
    const { apps } = await aiApps({ home, env: {}, setup });
    expect(apps.map((app) => [app.id, app.available, app.installed, app.connected])).toEqual([
      ["claude-desktop", true, false, false],
      ["codex", true, false, false],
      ["claude-code", true, false, false],
      ["gemini", true, false, false],
    ]);
    expect(await aiAppStatus("claude-desktop", { home, env: {}, setup: { ...setup, platform: "linux" } })).toMatchObject({ available: false, files: [] });
  });

  it("refuses Connect while the app is not installed, and writes nothing", async () => {
    const home = await testHome();
    const change = await changeAiApp("codex", true, { home, env: {}, setup });
    expect(change.problem).toEqual({ kind: "not-installed" });
    await expect(readFile(join(home, ".codex", "config.toml"), "utf8")).rejects.toThrow();
  });

  it("connects and disconnects Claude Desktop and the ChatGPT desktop app through their settings files", async () => {
    const home = await testHome();
    const claudeDir = join(home, "Library", "Application Support", "Claude");
    await mkdir(claudeDir, { recursive: true });
    await mkdir(join(home, ".codex"), { recursive: true });
    await writeFile(join(home, ".codex", "config.toml"), 'model = "o3"\n');
    const place = { home, env: {}, setup };

    const claude = await changeAiApp("claude-desktop", true, place);
    expect(claude).toMatchObject({ problem: null, backups: [], status: { installed: true, connected: true } });
    const config = JSON.parse(await readFile(join(claudeDir, "claude_desktop_config.json"), "utf8"));
    expect(config.mcpServers.frameshell).toEqual({ command: setup.command, args: ["mcp"] });

    const codex = await changeAiApp("codex", true, place);
    expect(codex).toMatchObject({ problem: null, status: { connected: true } });
    expect(codex.backups).toEqual([join(home, ".codex", "config.toml.frameshell-backup")]);
    const toml = await readFile(join(home, ".codex", "config.toml"), "utf8");
    expect(toml.startsWith('model = "o3"\n')).toBe(true);
    expect(toml).toContain("[mcp_servers.frameshell]");

    expect((await changeAiApp("claude-desktop", false, place)).status.connected).toBe(false);
    expect((await changeAiApp("codex", false, place)).status.connected).toBe(false);
    expect(await readFile(join(home, ".codex", "config.toml"), "utf8")).toBe('model = "o3"\n');
  });

  it("reports a settings file that does not parse, and leaves it alone", async () => {
    const home = await testHome();
    await mkdir(join(home, ".gemini"), { recursive: true });
    const file = join(home, ".gemini", "settings.json");
    await writeFile(file, "{ broken");
    const place = { home, env: {}, setup };
    expect(await aiAppStatus("gemini", place)).toMatchObject({ installed: true, connected: false, problem: { kind: "invalid", file } });
    expect((await changeAiApp("gemini", true, place)).problem).toEqual({ kind: "invalid", file });
    expect(await readFile(file, "utf8")).toBe("{ broken");
  });

  it("marks Frameshell entries that run another command as different", async () => {
    const home = await testHome();
    await mkdir(join(home, ".gemini"), { recursive: true });
    await writeFile(join(home, ".gemini", "settings.json"), '{ "mcpServers": { "frameshell": { "command": "frameshell", "args": ["mcp"] } } }');
    expect(await aiAppStatus("gemini", { home, env: {}, setup })).toMatchObject({ connected: false, different: true });
  });
});

describe("serverSnippets", () => {
  it("gives the entry the connectors write, as mcpServers JSON and as VS Code's servers", () => {
    const snippets = serverSnippets({ command: "C:\\Users\\ana\\bin\\frameshell.cmd", platform: "win32" });
    const entry = { command: "cmd", args: ["/c", "C:\\Users\\ana\\bin\\frameshell.cmd", "mcp"] };
    expect(JSON.parse(snippets.mcpServers)).toEqual({ mcpServers: { frameshell: entry } });
    expect(JSON.parse(snippets.vscode)).toEqual({ servers: { frameshell: { type: "stdio", ...entry } } });
  });
});
