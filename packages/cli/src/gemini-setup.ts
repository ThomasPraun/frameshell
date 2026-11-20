// Connect Gemini CLI: Frameshell's MCP server in `~/.gemini/settings.json` (`mcpServers.frameshell`, the same shape as
// Claude Desktop's), through the JSON editing shared in `config-file.ts`.
import { stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type ServerSetup, type ServerState, TOOL_TIMEOUT_S, editMcpServer, mcpServerState, serverEntry } from "./config-file.js";

/** Gemini CLI's user-level settings. */
export function geminiSettingsPath(home: string): string {
  return join(home, ".gemini", "settings.json");
}

/** Frameshell's server as Gemini CLI stores it. `timeout` is milliseconds (its default is 10 minutes, below the blocking waits). */
export function geminiServer(setup: ServerSetup): { command: string; args: string[]; timeout: number } {
  return { ...serverEntry(setup.command, setup.platform), timeout: TOOL_TIMEOUT_S * 1000 };
}

/** What `settings.json` says about Frameshell. */
export type GeminiState = ServerState;

/** Read the state of the file at `file` for `setup`. Throws `InvalidConfigError` for a file that is not JSON. */
export async function geminiState(file: string, setup: ServerSetup): Promise<GeminiState> {
  const installed = await stat(dirname(file)).then(
    (info) => info.isDirectory(),
    () => false,
  );
  return mcpServerState(file, serverEntry(setup.command, setup.platform), installed);
}

/**
 * Add (or point again) the `frameshell` server. Edits only that key; the file as it was goes to
 * `<file>.frameshell-backup` first. Returns the backup path, or null when there was no file or nothing changed.
 */
export async function connectGemini(file: string, setup: ServerSetup): Promise<string | null> {
  if ((await geminiState(file, setup)).connected) return null;
  return editMcpServer(file, geminiServer(setup));
}

/** Remove the `frameshell` server, and nothing else. Same backup as {@link connectGemini}. */
export function disconnectGemini(file: string): Promise<string | null> {
  return editMcpServer(file, undefined);
}
