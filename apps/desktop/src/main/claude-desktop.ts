// Connect Claude Desktop (#191): a `frameshell` entry in its MCP config, which starts `frameshell mcp` outside any
// project, so the server follows the app window the user works in (ADR 0014).
import { copyFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join, posix, win32 } from "node:path";
import { createRequire } from "node:module";
import type { ParseError } from "jsonc-parser";

// Required, not imported: its Node entry is UMD (no ESM named exports), while bundlers pick its ESM build.
const { applyEdits, modify, parse } = createRequire(import.meta.url)("jsonc-parser") as typeof import("jsonc-parser");

/** The config is not JSON: Frameshell leaves it alone. */
export class InvalidConfigError extends Error {
  constructor(readonly file: string) {
    super(`${file} is not valid JSON`);
  }
}

/** Key of Frameshell's server under `mcpServers`. */
export const SERVER_KEY = "frameshell";

/** Where Claude Desktop keeps `claude_desktop_config.json`; undefined where there is no Claude Desktop (Linux). */
export function claudeDesktopConfigPath(platform: NodeJS.Platform, home: string, env: NodeJS.ProcessEnv): string | undefined {
  if (platform === "darwin") return posix.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
  if (platform === "win32") {
    const appData = env["APPDATA"] ?? win32.join(home, "AppData", "Roaming");
    return win32.join(appData, "Claude", "claude_desktop_config.json");
  }
  return undefined;
}

/** Frameshell's server as Claude Desktop runs it. */
export interface ServerEntry {
  command: string;
  args: string[];
}

/**
 * The entry running `shim mcp`. On Windows through `cmd /c`: Claude Desktop starts servers without a shell, which
 * cannot run a `.cmd` file directly.
 */
export function serverEntry(shim: string, platform: NodeJS.Platform): ServerEntry {
  return platform === "win32" ? { command: "cmd", args: ["/c", shim, "mcp"] } : { command: shim, args: ["mcp"] };
}

/** What the config says about Frameshell. */
export interface ClaudeDesktopState {
  /** Claude Desktop's folder exists: it is (or was) installed. */
  installed: boolean;
  /** The config has the `frameshell` server `entry`. */
  connected: boolean;
}

/** Read the state of the config at `file` for `entry`. */
export async function claudeDesktopState(file: string, entry: ServerEntry): Promise<ClaudeDesktopState> {
  const installed = await stat(dirname(file)).then(
    (info) => info.isDirectory(),
    () => false,
  );
  const text = await readFile(file, "utf8").catch(() => null);
  if (text === null) return { installed, connected: false };
  const current = (parseConfig(text, file)["mcpServers"] as Record<string, unknown> | undefined)?.[SERVER_KEY] as
    | { command?: unknown; args?: unknown }
    | undefined;
  const connected = current?.command === entry.command && JSON.stringify(current.args) === JSON.stringify(entry.args);
  return { installed, connected };
}

/**
 * Add (or point again) the `frameshell` server as `entry`. Edits only that key, so the rest of the file keeps
 * its bytes; the file as it was goes to `<file>.frameshell-backup` first. Returns the backup path, or null when
 * there was no file.
 */
export async function connectClaudeDesktop(file: string, entry: ServerEntry): Promise<string | null> {
  return edit(file, entry);
}

/** Remove the `frameshell` server, and nothing else. Returns the backup path, or null when there was no file. */
export async function disconnectClaudeDesktop(file: string): Promise<string | null> {
  return edit(file, undefined);
}

async function edit(file: string, server: ServerEntry | undefined): Promise<string | null> {
  const before = await readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (before === null && !server) return null;
  const text = before ?? "{}\n";
  const config = parseConfig(text, file);
  if (!server && !(config["mcpServers"] as Record<string, unknown> | undefined)?.[SERVER_KEY]) return null;
  const after = withServer(text, server);
  await mkdir(dirname(file), { recursive: true });
  let backup: string | null = null;
  if (before !== null) {
    backup = `${file}.frameshell-backup`;
    await copyFile(file, backup);
  }
  // Written beside and renamed: Claude Desktop never reads half a file.
  const temp = join(dirname(file), `.${SERVER_KEY}-${process.pid}.tmp`);
  await writeFile(temp, after);
  await rename(temp, file);
  return backup;
}

/**
 * `text` with the server set (or removed). Formatted like Claude Desktop writes the file when that leaves every
 * other byte as it was (checked by taking the entry out again); else inserted as is, unformatted, so a file
 * someone formatted by hand keeps its layout.
 */
function withServer(text: string, server: ServerEntry | undefined): string {
  const path = ["mcpServers", SERVER_KEY];
  const formattingOptions = { insertSpaces: true, tabSize: 2, eol: text.includes("\r\n") ? "\r\n" : "\n" };
  const formatted = applyEdits(text, modify(text, path, server, { formattingOptions }));
  const plain = applyEdits(text, modify(text, path, server, {}));
  const undo = (edited: string) => applyEdits(edited, modify(edited, path, undefined, {}));
  if (server && !parseConfig(text, "")["mcpServers"]) return formatted;
  return undo(formatted) === undo(plain) ? formatted : plain;
}

function parseConfig(text: string, file: string): Record<string, unknown> {
  const errors: ParseError[] = [];
  const value = parse(text, errors, { allowTrailingComma: true }) as unknown;
  if (errors.length > 0 || !value || typeof value !== "object" || Array.isArray(value)) {
    throw new InvalidConfigError(file);
  }
  return value as Record<string, unknown>;
}
