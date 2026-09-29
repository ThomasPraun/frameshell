import { homedir } from "node:os";
import { posix, win32 } from "node:path";

/** Per-user machine-local directories of Frameshell (never inside a project). */
export interface AppDirs {
  /** Large regenerable data: managed binaries, models. */
  dataDir: string;
  /** Global `config.json`. */
  configDir: string;
}

/**
 * OS-conventional app directories. `FRAMESHELL_DATA_DIR` / `FRAMESHELL_CONFIG_DIR`
 * override (tests, portable installs). Windows data goes to Local, not Roaming:
 * binaries must not sync across machines.
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
