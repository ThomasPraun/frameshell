// Connect Claude Desktop (#191): a `frameshell` entry in its MCP config, which starts `frameshell mcp` outside any
// project, so the server follows the app window the user works in (ADR 0014). The JSON editing is shared with
// Connect Claude Code (`@frameshell/cli`, `config-file.ts`).
import { readFile, stat } from "node:fs/promises";
import { dirname, posix, win32 } from "node:path";
import { InvalidConfigError, SERVER_KEY, type ServerEntry, editConfigFile, parseConfig, serverEntry, valueAt, withValue } from "@frameshell/cli";

export { InvalidConfigError, SERVER_KEY, type ServerEntry, serverEntry };

/** Where Claude Desktop keeps `claude_desktop_config.json`; undefined where there is no Claude Desktop (Linux). */
export function claudeDesktopConfigPath(platform: NodeJS.Platform, home: string, env: NodeJS.ProcessEnv): string | undefined {
  if (platform === "darwin") return posix.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
  if (platform === "win32") {
    const appData = env["APPDATA"] ?? win32.join(home, "AppData", "Roaming");
    return win32.join(appData, "Claude", "claude_desktop_config.json");
  }
  return undefined;
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
  const current = valueAt(parseConfig(text, file), ["mcpServers", SERVER_KEY]) as { command?: unknown; args?: unknown } | undefined;
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

function edit(file: string, server: ServerEntry | undefined): Promise<string | null> {
  const path = ["mcpServers", SERVER_KEY];
  return editConfigFile(file, (text) => {
    const config = parseConfig(text, file);
    if (!server && valueAt(config, path) === undefined) return null;
    return withValue(text, path, server);
  });
}
