import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Per-user Frameshell data directory (trust decisions, later managed binaries, SPEC §9).
 *
 * - `FRAMESHELL_APP_DATA` wins: tests and portable setups.
 * - macOS: `~/Library/Application Support/Frameshell`.
 * - Windows: `%APPDATA%\Frameshell`.
 * - Others: `$XDG_DATA_HOME/frameshell`, default `~/.local/share/frameshell`.
 */
export function resolveAppDataDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const override = env["FRAMESHELL_APP_DATA"];
  if (override) return override;
  if (platform === "darwin") return join(homedir(), "Library", "Application Support", "Frameshell");
  if (platform === "win32") return join(env["APPDATA"] || join(homedir(), "AppData", "Roaming"), "Frameshell");
  return join(env["XDG_DATA_HOME"] || join(homedir(), ".local", "share"), "frameshell");
}
