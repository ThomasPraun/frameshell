import { homedir } from "node:os";
import { posix, win32 } from "node:path";

/**
 * Per-user machine-local directories of Frameshell (never inside a project).
 * The one place daemon, CLI and desktop app learn where user-level state lives.
 */
export interface AppDirs {
  /** Large or regenerable state: managed binaries, downloads, caches, desktop app data. Never roams. */
  dataDir: string;
  /** Small user decisions: global `config.json`, project trust (`trust.json`). */
  configDir: string;
}

/**
 * OS-conventional app directories.
 *
 * - macOS: both in `~/Library/Application Support/Frameshell`.
 * - Linux: `$XDG_DATA_HOME/frameshell` (default `~/.local/share`) and `$XDG_CONFIG_HOME/frameshell` (default `~/.config`).
 * - Windows: data in `%LOCALAPPDATA%\Frameshell` (binaries must not roam), config in `%APPDATA%\Frameshell`.
 *
 * `FRAMESHELL_DATA_DIR` / `FRAMESHELL_CONFIG_DIR` override each (tests, portable installs).
 * They are the only overrides.
 */
export function resolveAppDirs(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): AppDirs {
  let dataDir: string;
  let configDir: string;
  if (platform === "win32") {
    dataDir = win32.join(env["LOCALAPPDATA"] || win32.join(home, "AppData", "Local"), "Frameshell");
    configDir = win32.join(env["APPDATA"] || win32.join(home, "AppData", "Roaming"), "Frameshell");
  } else if (platform === "darwin") {
    dataDir = configDir = posix.join(home, "Library", "Application Support", "Frameshell");
  } else {
    dataDir = posix.join(env["XDG_DATA_HOME"] || posix.join(home, ".local", "share"), "frameshell");
    configDir = posix.join(env["XDG_CONFIG_HOME"] || posix.join(home, ".config"), "frameshell");
  }
  return {
    dataDir: env["FRAMESHELL_DATA_DIR"] || dataDir,
    configDir: env["FRAMESHELL_CONFIG_DIR"] || configDir,
  };
}
