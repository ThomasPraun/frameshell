// Connect Claude Desktop: a `frameshell` entry in its MCP config, which starts `frameshell mcp` outside any
// project, so the server follows the app window the user works in (ADR 0014). The JSON editing is shared with
// Connect Claude Code (`@frameshell/cli`, `config-file.ts`).
import { readdirSync } from "node:fs";
import { stat } from "node:fs/promises";
import { dirname, posix, win32 } from "node:path";
import { InvalidConfigError, SERVER_KEY, type ServerEntry, type ServerState, editMcpServer, mcpServerState, serverEntry } from "@frameshell/cli";

export { InvalidConfigError, SERVER_KEY, type ServerEntry, serverEntry };

/** List the entry names in `dir`; empty when it cannot be read. */
export type ListDir = (dir: string) => string[];

const listDir: ListDir = (dir) => {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
};

/**
 * Where Claude Desktop keeps `claude_desktop_config.json`; undefined where there is no Claude Desktop (Linux).
 * On Windows the Microsoft Store (MSIX) install reads its config from the package's private AppData
 * (`%LOCALAPPDATA%\Packages\Claude_<id>\LocalCache\Roaming\Claude`), which an unpackaged app does not see
 * as `%APPDATA%\Claude`, so a `Claude_*` package wins over the plain folder. `list` reads a folder (tests).
 */
export function claudeDesktopConfigPath(platform: NodeJS.Platform, home: string, env: NodeJS.ProcessEnv, list: ListDir = listDir): string | undefined {
  return claudeDesktopConfig(platform, home, env, list)?.file;
}

/** The config file and the folder whose presence says Claude Desktop is installed. */
export interface ClaudeDesktopConfig {
  /** `claude_desktop_config.json`. */
  file: string;
  /** The MSIX package folder, or the folder holding `file`. */
  installDir: string;
}

/** {@link claudeDesktopConfigPath} with the folder that says Claude Desktop is installed. */
export function claudeDesktopConfig(platform: NodeJS.Platform, home: string, env: NodeJS.ProcessEnv, list: ListDir = listDir): ClaudeDesktopConfig | undefined {
  if (platform === "darwin") {
    const file = posix.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
    return { file, installDir: posix.dirname(file) };
  }
  if (platform === "win32") {
    const packages = win32.join(env["LOCALAPPDATA"] ?? win32.join(home, "AppData", "Local"), "Packages");
    const name = list(packages).filter((entry) => entry.startsWith("Claude_")).sort()[0];
    if (name) {
      const installDir = win32.join(packages, name);
      return { file: win32.join(installDir, "LocalCache", "Roaming", "Claude", "claude_desktop_config.json"), installDir };
    }
    const appData = env["APPDATA"] ?? win32.join(home, "AppData", "Roaming");
    const file = win32.join(appData, "Claude", "claude_desktop_config.json");
    return { file, installDir: win32.dirname(file) };
  }
  return undefined;
}

/** What the config says about Frameshell. */
export type ClaudeDesktopState = ServerState;

/**
 * Read the state of the config at `file` for `entry`; Claude Desktop counts as installed when `installDir`
 * (default: the folder holding `file`) exists. Throws {@link InvalidConfigError} for a file that is not JSON.
 */
export async function claudeDesktopState(file: string, entry: ServerEntry, installDir = dirname(file)): Promise<ClaudeDesktopState> {
  const installed = await stat(installDir).then(
    (info) => info.isDirectory(),
    () => false,
  );
  return mcpServerState(file, entry, installed);
}

/**
 * Add (or point again) the `frameshell` server as `entry`. Edits only that key, so the rest of the file keeps
 * its bytes; the file as it was goes to `<file>.frameshell-backup` first. Returns the backup path, or null when
 * there was no file.
 */
export function connectClaudeDesktop(file: string, entry: ServerEntry): Promise<string | null> {
  return editMcpServer(file, entry);
}

/** Remove the `frameshell` server, and nothing else. Returns the backup path, or null when there was no file. */
export function disconnectClaudeDesktop(file: string): Promise<string | null> {
  return editMcpServer(file, undefined);
}
