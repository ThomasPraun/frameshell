// Connect Claude Desktop: a `frameshell` entry in its MCP config, which starts `frameshell mcp` outside any
// project, so the server follows the app window the user works in (ADR 0014). The JSON editing is shared with
// Connect Claude Code (`@frameshell/cli`, `config-file.ts`).
import { readdir, stat } from "node:fs/promises";
import { dirname, posix, win32 } from "node:path";
import { InvalidConfigError, SERVER_KEY, type ServerEntry, type ServerState, editMcpServer, mcpServerState, serverEntry } from "@frameshell/cli";

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

/** Lists the folder names in a directory; [] when it cannot be read. */
export type ListDirs = (dir: string) => Promise<string[]>;

const listDirs: ListDirs = (dir) =>
  readdir(dir, { withFileTypes: true }).then(
    (entries) => entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name),
    () => [],
  );

/** Whether `dir` is a folder. */
const isDir = (dir: string) =>
  stat(dir).then(
    (info) => info.isDirectory(),
    () => false,
  );

/**
 * Where the installed Claude Desktop reads `claude_desktop_config.json` (#735). On Windows the Microsoft Store and
 * MSIX builds run packaged. Recent ones (6.28899, 2026-11) keep their data in `%LOCALAPPDATA%\Claude-Data\claude_<id>`;
 * earlier ones had `%APPDATA%` redirected to `%LOCALAPPDATA%\Packages\Claude_<id>\LocalCache\Roaming`. An unpackaged
 * app such as Frameshell sees neither through `%APPDATA%`. A `Claude-Data` folder wins, then a package whose `Claude`
 * settings folder exists, then the plain `%APPDATA%\Claude` when it exists, then any Claude package, then
 * {@link claudeDesktopConfigPath}. macOS and Linux are {@link claudeDesktopConfigPath}.
 */
export async function claudeDesktopConfigFile(
  platform: NodeJS.Platform,
  home: string,
  env: NodeJS.ProcessEnv,
  list: ListDirs = listDirs,
  exists: (dir: string) => Promise<boolean> = isDir,
): Promise<string | undefined> {
  const plain = claudeDesktopConfigPath(platform, home, env);
  if (platform !== "win32" || !plain) return plain;
  const local = env["LOCALAPPDATA"] ?? win32.join(home, "AppData", "Local");
  const dataRoot = win32.join(local, "Claude-Data");
  const data = (await list(dataRoot)).filter((name) => /^claude_[a-z0-9]+$/i.test(name)).sort();
  for (const name of data) {
    const dir = win32.join(dataRoot, name);
    if (await exists(dir)) return win32.join(dir, "claude_desktop_config.json");
  }
  const packages = win32.join(local, "Packages");
  const packaged = (await list(packages))
    .filter((name) => /^Claude_[a-z0-9]+$/i.test(name))
    .sort()
    .map((name) => win32.join(packages, name, "LocalCache", "Roaming", "Claude", "claude_desktop_config.json"));
  for (const file of packaged) if (await exists(win32.dirname(file))) return file;
  if (await exists(win32.dirname(plain))) return plain;
  return packaged[0] ?? plain;
}

/** What the config says about Frameshell. */
export type ClaudeDesktopState = ServerState;

/** Read the state of the config at `file` for `entry`. Throws {@link InvalidConfigError} for a file that is not JSON. */
export async function claudeDesktopState(file: string, entry: ServerEntry): Promise<ClaudeDesktopState> {
  const installed = await isDir(dirname(file));
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
