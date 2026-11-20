// Edits of other programs' config files (JSON: Claude Desktop, Claude Code, Gemini CLI; Codex's TOML goes through
// `editConfigFile` too): change only Frameshell's entries, keep every other byte, back up first. Shared by the app's
// "Connect …" buttons and `frameshell setup`.
import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import type { ParseError } from "jsonc-parser";

// Required, not imported: its Node entry is UMD (no ESM named exports), while bundlers pick its ESM build.
const { applyEdits, modify, parse } = createRequire(import.meta.url)("jsonc-parser") as typeof import("jsonc-parser");

/** The config is not valid (or not the shape Frameshell edits): Frameshell leaves it alone. `detail` follows the file name. */
export class InvalidConfigError extends Error {
  constructor(
    readonly file: string,
    detail = "is not valid JSON",
  ) {
    super(`${file} ${detail}`);
  }
}

/** Key of Frameshell's server under `mcpServers` (Codex: under `mcp_servers`). */
export const SERVER_KEY = "frameshell";

/**
 * Seconds an MCP client may wait for one Frameshell tool call. The blocking waits (`proposal_wait`, `inbox_wait`) last
 * up to 3600 s, far over the clients' defaults (Codex: 60 s); renders and other jobs return at once and are polled.
 */
export const TOOL_TIMEOUT_S = 3600;

/** A place in a JSON document: object keys and array indexes. */
export type JsonPath = (string | number)[];

/** Parse JSON with comments and trailing commas; throws {@link InvalidConfigError} unless the top level is an object. */
export function parseConfig(text: string, file: string): Record<string, unknown> {
  const errors: ParseError[] = [];
  const value = parse(text, errors, { allowTrailingComma: true }) as unknown;
  if (errors.length > 0 || !value || typeof value !== "object" || Array.isArray(value)) {
    throw new InvalidConfigError(file);
  }
  return value as Record<string, unknown>;
}

/** The value at `path` of a parsed config, or undefined. */
export function valueAt(config: unknown, path: JsonPath): unknown {
  let current = config;
  for (const key of path) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string | number, unknown>)[key];
  }
  return current;
}

/**
 * `text` with `value` set at `path` (removed when undefined; `insert`: put it into the array at that index instead of
 * replacing the item there). Formatted like the file's tool writes it when that leaves every other byte as it was
 * (checked by taking the value out again); else inserted as is, unformatted, so a file someone formatted by hand keeps
 * its layout.
 */
export function withValue(text: string, path: JsonPath, value: unknown, insert = false): string {
  const formattingOptions = { insertSpaces: true, tabSize: 2, eol: text.includes("\r\n") ? "\r\n" : "\n" };
  const options = insert ? { isArrayInsertion: true } : {};
  const formatted = applyEdits(text, modify(text, path, value, { ...options, formattingOptions }));
  const plain = applyEdits(text, modify(text, path, value, options));
  const undo = (edited: string) => {
    try {
      return applyEdits(edited, modify(edited, path, undefined, {}));
    } catch {
      // Nothing left at `path` to take out (it was a removal).
      return edited;
    }
  };
  if (value !== undefined && valueAt(parse(text), path.slice(0, -1)) === undefined) return formatted;
  return undo(formatted) === undo(plain) ? formatted : plain;
}

/**
 * Change the config at `file` through `change(text)`, which returns the new text or null for no change. A missing file
 * is `missing` (default `{}`) to `change`, and is created only when something changes. The file as it was goes to
 * `<file>.frameshell-backup` first. Returns the backup path, or null when nothing was backed up (no file, or no change).
 */
export async function editConfigFile(file: string, change: (text: string) => string | null, missing = "{}\n"): Promise<string | null> {
  const before = await readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  const after = change(before ?? missing);
  if (after === null || after === before) return null;
  await mkdir(dirname(file), { recursive: true });
  let backup: string | null = null;
  if (before !== null) {
    backup = `${file}.frameshell-backup`;
    await copyFile(file, backup);
  }
  // Written beside and renamed: the other program never reads half a file.
  const temp = join(dirname(file), `.${SERVER_KEY}-${process.pid}.tmp`);
  await writeFile(temp, after);
  await rename(temp, file);
  return backup;
}

/** Frameshell's server as an MCP client runs it. */
export interface ServerEntry {
  command: string;
  args: string[];
}

/**
 * The entry running `shim mcp`. On Windows through `cmd /c`: Claude Desktop and Claude Code start servers without a
 * shell, which cannot run a `.cmd` file directly.
 */
export function serverEntry(shim: string, platform: NodeJS.Platform): ServerEntry {
  return platform === "win32" ? { command: "cmd", args: ["/c", shim, "mcp"] } : { command: shim, args: ["mcp"] };
}

/** How an AI app is told to run Frameshell. */
export interface ServerSetup {
  /** The `frameshell` executable: a bare name on PATH, or the full path of the app's shim. */
  command: string;
  platform: NodeJS.Platform;
}

/** What an app's config says about Frameshell's server. */
export interface ServerState {
  /** The app's folder exists: it is (or was) installed. */
  installed: boolean;
  /** The config has the `frameshell` server running the wanted command and args. */
  connected: boolean;
  /** The config has a `frameshell` server that runs something else (an older shim, a dev build, a hand edit). */
  different: boolean;
}

/** Whether a config's server entry runs `want`, whatever else it holds (timeouts, env). */
export function sameEntry(current: unknown, want: ServerEntry): boolean {
  const entry = current as { command?: unknown; args?: unknown } | null | undefined;
  return entry?.command === want.command && JSON.stringify(entry.args) === JSON.stringify(want.args);
}

/** Where the JSON apps (Claude Desktop, Gemini CLI) keep Frameshell's server. */
const MCP_SERVER_PATH: JsonPath = ["mcpServers", SERVER_KEY];

/** Read the state of the JSON config at `file` for `entry`. Throws {@link InvalidConfigError} for a file that is not JSON. */
export async function mcpServerState(file: string, entry: ServerEntry, installed: boolean): Promise<ServerState> {
  const text = await readFile(file, "utf8").catch(() => null);
  if (text === null) return { installed, connected: false, different: false };
  const current = valueAt(parseConfig(text, file), MCP_SERVER_PATH);
  const connected = sameEntry(current, entry);
  return { installed, connected, different: current !== undefined && !connected };
}

/**
 * Set (or, with undefined, remove) `mcpServers.frameshell` of the JSON config at `file`, keeping every other byte; the
 * file as it was goes to `<file>.frameshell-backup` first. Returns the backup path, or null when there was no file or
 * nothing changed.
 */
export function editMcpServer(file: string, server: object | undefined): Promise<string | null> {
  return editConfigFile(file, (text) => {
    const config = parseConfig(text, file);
    if (!server && valueAt(config, MCP_SERVER_PATH) === undefined) return null;
    return withValue(text, MCP_SERVER_PATH, server);
  });
}
