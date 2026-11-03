// Connect Claude Code (ADR 0025 decision 7): Frameshell's MCP server in `~/.claude.json` and a `UserPromptSubmit` hook
// in `~/.claude/settings.json`, both at user level. Only Frameshell's entries change (`config-file.ts`).
import { readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  InvalidConfigError,
  type JsonPath,
  SERVER_KEY,
  editConfigFile,
  parseConfig,
  serverEntry,
  valueAt,
  withValue,
} from "./config-file.js";

/** Agent label of Claude Code's targets (`clientAgentLabel`), which the hook reads the inbox of. */
const HOOK_TARGET = "claude";

/** The two files Claude Code keeps its user-level setup in. */
export interface ClaudeCodePaths {
  /** User-scope MCP servers (`mcpServers`). */
  mcp: string;
  /** Hooks (`hooks`). */
  settings: string;
}

/** Where Claude Code keeps user-level settings: under `CLAUDE_CONFIG_DIR` when set, else `~/.claude.json` and `~/.claude/`. */
export function claudeCodePaths(home: string, env: NodeJS.ProcessEnv): ClaudeCodePaths {
  const dir = env["CLAUDE_CONFIG_DIR"];
  if (dir) return { mcp: join(dir, ".claude.json"), settings: join(dir, "settings.json") };
  return { mcp: join(home, ".claude.json"), settings: join(home, ".claude", "settings.json") };
}

/** How Claude Code is told to run Frameshell. */
export interface ClaudeCodeSetup {
  /** The `frameshell` executable: a bare name on PATH, or the full path of the app's shim. */
  command: string;
  platform: NodeJS.Platform;
}

/** Frameshell's server as Claude Code stores user-scope servers (what `claude mcp add --scope user` writes). */
export function claudeCodeServer(setup: ClaudeCodeSetup): { type: "stdio"; command: string; args: string[]; env: Record<string, never> } {
  return { type: "stdio", ...serverEntry(setup.command, setup.platform), env: {} };
}

/**
 * The hook command. `--hook` reads the prompt's JSON on stdin for the directory, `--target claude` names the inbox:
 * a hook process is no agent target itself. Quoted when the path needs it.
 */
export function claudeCodeHookCommand(setup: ClaudeCodeSetup): string {
  const command = /^[\w@%+=:,./\\-]+$/.test(setup.command) ? setup.command : `"${setup.command}"`;
  return `${command} ask --take --target ${HOOK_TARGET} --hook`;
}

/** Seconds Claude Code waits for the hook; it normally ends in well under one. */
const HOOK_TIMEOUT_S = 5;

const SERVER_PATH: JsonPath = ["mcpServers", SERVER_KEY];
const HOOKS_PATH: JsonPath = ["hooks", "UserPromptSubmit"];

/** A hook command Frameshell wrote (this or an earlier shim path, with or without the later flags). */
function isFrameshellHook(hook: unknown): boolean {
  const command = (hook as { command?: unknown } | null)?.command;
  return typeof command === "string" && /(^|[\s"'/\\])frameshell(\.cmd)?["']?\s+ask\s+--take(\s|$)/.test(command);
}

/** Where Frameshell's hooks sit: `[group, hook]` index pairs under `hooks.UserPromptSubmit`. */
function hookSlots(config: Record<string, unknown>, file: string): [number, number][] {
  const groups = valueAt(config, HOOKS_PATH);
  if (groups === undefined) return [];
  if (!Array.isArray(groups)) throw new InvalidConfigError(file, "has a `hooks.UserPromptSubmit` that is not a list");
  const slots: [number, number][] = [];
  groups.forEach((group, g) => {
    const hooks = (group as { hooks?: unknown } | null)?.hooks;
    if (Array.isArray(hooks)) hooks.forEach((hook, h) => isFrameshellHook(hook) && slots.push([g, h]));
  });
  return slots;
}

/** What the two files say about Frameshell. */
export interface ClaudeCodeState {
  /** Claude Code's folder or `.claude.json` exists: it is (or was) installed. */
  installed: boolean;
  /** `mcpServers.frameshell` runs `setup.command mcp`. */
  server: boolean;
  /** The prompt hook is there with the current command. */
  hook: boolean;
  /** Both. */
  connected: boolean;
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

/** Read the state of the files at `paths` for `setup`. Throws {@link InvalidConfigError} for a file that is not JSON. */
export async function claudeCodeState(paths: ClaudeCodePaths, setup: ClaudeCodeSetup): Promise<ClaudeCodeState> {
  const installed = (await exists(dirname(paths.settings))) || (await exists(paths.mcp));
  const mcp = await readFile(paths.mcp, "utf8").catch(() => null);
  const settings = await readFile(paths.settings, "utf8").catch(() => null);
  const want = claudeCodeServer(setup);
  const current = mcp === null ? undefined : (valueAt(parseConfig(mcp, paths.mcp), SERVER_PATH) as { command?: unknown; args?: unknown } | undefined);
  const server = current?.command === want.command && JSON.stringify(current.args) === JSON.stringify(want.args);
  let hook = false;
  if (settings !== null) {
    const config = parseConfig(settings, paths.settings);
    const groups = valueAt(config, HOOKS_PATH) as { hooks?: { command?: unknown }[] }[] | undefined;
    hook = hookSlots(config, paths.settings).some(([g, h]) => groups?.[g]?.hooks?.[h]?.command === claudeCodeHookCommand(setup));
  }
  return { installed, server, hook, connected: server && hook };
}

/** The backups a change made; a file that did not change, or did not exist, has none. */
export interface ClaudeCodeBackups {
  mcp: string | null;
  settings: string | null;
}

/**
 * Add (or point again at `setup.command`) the MCP server and the hook. Edits only Frameshell's entries and leaves a
 * file that is already right untouched; each changed file is backed up to `<file>.frameshell-backup` first.
 */
export async function connectClaudeCode(paths: ClaudeCodePaths, setup: ClaudeCodeSetup): Promise<ClaudeCodeBackups> {
  const mcp = await editConfigFile(paths.mcp, (text) => {
    parseConfig(text, paths.mcp);
    return withValue(text, SERVER_PATH, claudeCodeServer(setup));
  });
  const settings = await editConfigFile(paths.settings, (text) => {
    let current = text;
    const command = claudeCodeHookCommand(setup);
    const hook = { type: "command", command, timeout: HOOK_TIMEOUT_S };
    const slots = hookSlots(parseConfig(current, paths.settings), paths.settings);
    const [first, ...extra] = slots;
    if (first) {
      const at = [...HOOKS_PATH, first[0], "hooks", first[1]];
      const found = valueAt(parseConfig(current, paths.settings), at) as { command?: unknown };
      if (found.command !== command) current = withValue(current, at, { ...found, command });
    } else {
      const groups = valueAt(parseConfig(current, paths.settings), HOOKS_PATH) as unknown[] | undefined;
      current = groups
        ? withValue(current, [...HOOKS_PATH, groups.length], { hooks: [hook] }, true)
        : withValue(current, HOOKS_PATH, [{ hooks: [hook] }]);
    }
    // Another copy (made by hand) would read the inbox twice per prompt.
    for (const [g, h] of extra.reverse()) current = removeHook(current, paths.settings, g, h);
    return current;
  });
  return { mcp, settings };
}

/** Remove Frameshell's server and hook, and nothing else. Same backups as {@link connectClaudeCode}. */
export async function disconnectClaudeCode(paths: ClaudeCodePaths): Promise<ClaudeCodeBackups> {
  const mcp = await editConfigFile(paths.mcp, (text) => {
    if (valueAt(parseConfig(text, paths.mcp), SERVER_PATH) === undefined) return null;
    return withValue(text, SERVER_PATH, undefined);
  });
  const settings = await editConfigFile(paths.settings, (text) => {
    const slots = hookSlots(parseConfig(text, paths.settings), paths.settings);
    if (slots.length === 0) return null;
    let current = text;
    for (const [g, h] of slots.reverse()) current = removeHook(current, paths.settings, g, h);
    return current;
  });
  return { mcp, settings };
}

/** `text` without hook `h` of group `g`; its group goes too when it was the group's only hook, and empty containers it leaves. */
function removeHook(text: string, file: string, g: number, h: number): string {
  const hooks = valueAt(parseConfig(text, file), [...HOOKS_PATH, g, "hooks"]) as unknown[];
  let current = withValue(text, hooks.length > 1 ? [...HOOKS_PATH, g, "hooks", h] : [...HOOKS_PATH, g], undefined);
  const config = parseConfig(current, file);
  if ((valueAt(config, HOOKS_PATH) as unknown[]).length === 0) {
    current = withValue(current, HOOKS_PATH, undefined);
    const rest = valueAt(parseConfig(current, file), ["hooks"]) as Record<string, unknown>;
    if (Object.keys(rest).length === 0) current = withValue(current, ["hooks"], undefined);
  }
  return current;
}
