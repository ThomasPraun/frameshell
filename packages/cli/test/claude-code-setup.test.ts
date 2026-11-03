import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  InvalidConfigError,
  claudeCodeHookCommand,
  claudeCodePaths,
  claudeCodeState,
  connectClaudeCode,
  disconnectClaudeCode,
  runSetup,
} from "../src/index.js";

// Seam under test: Connect Claude Code (ADR 0025 decision 7), on real files in a temp home.
const setup = { command: "/Users/ana/Library/Application Support/Frameshell/bin/frameshell", platform: "darwin" as const };

async function home(files: { mcp?: string; settings?: string } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "fs-cc-"));
  await mkdir(join(dir, ".claude"));
  const paths = claudeCodePaths(dir, {});
  if (files.mcp !== undefined) await writeFile(paths.mcp, files.mcp);
  if (files.settings !== undefined) await writeFile(paths.settings, files.settings);
  return { dir, paths };
}

const OTHER_SETTINGS =
  '{\n  "theme": "dark",\n  "hooks": {\n    "UserPromptSubmit": [\n      { "hooks": [{ "type": "command", "command": "echo hi" }] }\n    ],\n    "Stop": [{ "hooks": [{ "type": "command", "command": "say done" }] }]\n  }\n}\n';

describe("claudeCodePaths", () => {
  it("uses ~/.claude.json and ~/.claude/settings.json, or CLAUDE_CONFIG_DIR", () => {
    expect(claudeCodePaths("/home/ana", {})).toEqual({ mcp: "/home/ana/.claude.json", settings: "/home/ana/.claude/settings.json" });
    expect(claudeCodePaths("/home/ana", { CLAUDE_CONFIG_DIR: "/cfg" })).toEqual({ mcp: "/cfg/.claude.json", settings: "/cfg/settings.json" });
  });
});

describe("claudeCodeHookCommand", () => {
  it("names the claude inbox and quotes a path with spaces", () => {
    expect(claudeCodeHookCommand({ command: "frameshell", platform: "darwin" })).toBe("frameshell ask --take --target claude --hook");
    expect(claudeCodeHookCommand(setup)).toBe(`"${setup.command}" ask --take --target claude --hook`);
  });
});

describe("connectClaudeCode", () => {
  it("adds the server and the hook, keeping every other byte, and backs both files up", async () => {
    const mcp = '{\n  "numStartups": 12,\n  "mcpServers": {\n    "files": { "type": "stdio", "command": "npx", "args": [] }\n  }\n}\n';
    const { paths } = await home({ mcp, settings: OTHER_SETTINGS });
    expect(await claudeCodeState(paths, setup)).toMatchObject({ installed: true, server: false, hook: false, connected: false });

    const backups = await connectClaudeCode(paths, setup);
    expect(await readFile(backups.mcp!, "utf8")).toBe(mcp);
    expect(await readFile(backups.settings!, "utf8")).toBe(OTHER_SETTINGS);

    const servers = JSON.parse(await readFile(paths.mcp, "utf8"));
    expect(servers.numStartups).toBe(12);
    expect(servers.mcpServers.files).toEqual({ type: "stdio", command: "npx", args: [] });
    expect(servers.mcpServers.frameshell).toEqual({ type: "stdio", command: setup.command, args: ["mcp"], env: {} });

    const settings = JSON.parse(await readFile(paths.settings, "utf8"));
    expect(settings.theme).toBe("dark");
    expect(settings.hooks.Stop).toEqual([{ hooks: [{ type: "command", command: "say done" }] }]);
    expect(settings.hooks.UserPromptSubmit).toEqual([
      { hooks: [{ type: "command", command: "echo hi" }] },
      { hooks: [{ type: "command", command: claudeCodeHookCommand(setup), timeout: 5 }] },
    ]);
    expect(await claudeCodeState(paths, setup)).toMatchObject({ server: true, hook: true, connected: true });
  });

  it("is idempotent: a second run changes no byte and makes no backup", async () => {
    const { paths } = await home({ settings: OTHER_SETTINGS });
    await connectClaudeCode(paths, setup);
    const [mcp, settings] = [await readFile(paths.mcp, "utf8"), await readFile(paths.settings, "utf8")];
    expect(await connectClaudeCode(paths, setup)).toEqual({ mcp: null, settings: null });
    expect([await readFile(paths.mcp, "utf8"), await readFile(paths.settings, "utf8")]).toEqual([mcp, settings]);
  });

  it("points the hook at a new shim in place instead of adding a second one", async () => {
    const { paths } = await home({ settings: OTHER_SETTINGS });
    await connectClaudeCode(paths, setup);
    const next = { command: "/new/frameshell", platform: "darwin" as const };
    await connectClaudeCode(paths, next);
    const groups = JSON.parse(await readFile(paths.settings, "utf8")).hooks.UserPromptSubmit;
    expect(groups).toHaveLength(2);
    expect(groups[1].hooks).toEqual([{ type: "command", command: claudeCodeHookCommand(next), timeout: 5 }]);
    expect(JSON.parse(await readFile(paths.mcp, "utf8")).mcpServers.frameshell.command).toBe("/new/frameshell");
  });

  it("creates both files when Claude Code has none yet", async () => {
    const { paths } = await home();
    expect(await connectClaudeCode(paths, setup)).toEqual({ mcp: null, settings: null });
    expect((await claudeCodeState(paths, setup)).connected).toBe(true);
  });

  it("writes the hook formatted like the file when that changes nothing else", async () => {
    const other = { theme: "dark" };
    const { paths } = await home({ settings: `${JSON.stringify(other, null, 2)}\n` });
    await connectClaudeCode(paths, setup);
    const expected = { ...other, hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: claudeCodeHookCommand(setup), timeout: 5 }] }] } };
    expect(await readFile(paths.settings, "utf8")).toBe(`${JSON.stringify(expected, null, 2)}\n`);
  });

  it("leaves a file that is not JSON, or whose hooks are not a list, alone", async () => {
    const broken = await home({ settings: "{ broken" });
    await expect(connectClaudeCode(broken.paths, setup)).rejects.toBeInstanceOf(InvalidConfigError);
    expect(await readFile(broken.paths.settings, "utf8")).toBe("{ broken");

    const odd = '{ "hooks": { "UserPromptSubmit": "echo" } }';
    const shape = await home({ settings: odd });
    await expect(connectClaudeCode(shape.paths, setup)).rejects.toBeInstanceOf(InvalidConfigError);
    expect(await readFile(shape.paths.settings, "utf8")).toBe(odd);
  });
});

describe("disconnectClaudeCode", () => {
  it("removes the server and the hook and nothing else", async () => {
    const mcp = '{\n  "mcpServers": {\n    "files": { "command": "npx" }\n  }\n}\n';
    const { paths } = await home({ mcp, settings: OTHER_SETTINGS });
    await connectClaudeCode(paths, setup);
    await disconnectClaudeCode(paths);
    expect(JSON.parse(await readFile(paths.mcp, "utf8"))).toEqual({ mcpServers: { files: { command: "npx" } } });
    expect(JSON.parse(await readFile(paths.settings, "utf8"))).toEqual(JSON.parse(OTHER_SETTINGS));
    expect(await claudeCodeState(paths, setup)).toMatchObject({ server: false, hook: false });
  });

  it("takes the hooks object out again when Frameshell's hook was all it held, and does nothing when not connected", async () => {
    const { paths } = await home({ settings: '{\n  "theme": "dark"\n}\n' });
    await connectClaudeCode(paths, setup);
    await disconnectClaudeCode(paths);
    expect(JSON.parse(await readFile(paths.settings, "utf8"))).toEqual({ theme: "dark" });
    expect(await disconnectClaudeCode(paths)).toEqual({ mcp: null, settings: null });
  });

  it("removes only Frameshell's hook from a group shared with another", async () => {
    const shared = JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "frameshell ask --take" }, { type: "command", command: "echo hi" }] }] } });
    const { paths } = await home({ settings: shared });
    await disconnectClaudeCode(paths);
    expect(JSON.parse(await readFile(paths.settings, "utf8"))).toEqual({ hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "echo hi" }] }] } });
  });
});

describe("frameshell setup claude-code", () => {
  it("connects, reports status as JSON, and removes, against CLAUDE_CONFIG_DIR", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fs-cc-cli-"));
    const env = { CLAUDE_CONFIG_DIR: dir };
    const run = async (args: string[]) => {
      let stdout = "";
      let stderr = "";
      const code = await runSetup(args, { stdout: (t) => (stdout += t), stderr: (t) => (stderr += t), env });
      return { code, stdout, stderr };
    };
    expect((await run(["claude-code", "--status", "--json"])).stdout).toContain('"connected": false');
    const connected = await run(["claude-code", "--command", "/opt/frameshell"]);
    expect(connected.code).toBe(0);
    expect(connected.stdout).toContain("Restart running Claude Code sessions");
    expect(JSON.parse((await run(["claude-code", "--command", "/opt/frameshell", "--status", "--json"])).stdout).connected).toBe(true);
    expect((await run(["claude-code", "--remove"])).code).toBe(0);
    expect(JSON.parse((await run(["claude-code", "--command", "/opt/frameshell", "--status", "--json"])).stdout).connected).toBe(false);
    expect((await run(["other"])).code).toBe(2);
  });
});
