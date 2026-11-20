// "Connect your AI": the AI apps Frameshell adds its MCP server to, one status shape for all of them, each read fresh
// from its settings files. The edits themselves live in the connectors (`claude-desktop.ts`, `@frameshell/cli`).
import { homedir } from "node:os";
import {
  InvalidConfigError,
  type ServerSetup,
  type ServerState,
  claudeCodePaths,
  claudeCodeState,
  codexConfigPath,
  codexState,
  connectClaudeCode,
  connectCodex,
  connectGemini,
  disconnectClaudeCode,
  disconnectCodex,
  disconnectGemini,
  geminiSettingsPath,
  geminiState,
} from "@frameshell/cli";
import { AI_APP_IDS, type AiAppChange, type AiAppId, type AiAppProblem, type AiAppStatus, type AiApps } from "../shared/api.js";
import { SERVER_KEY, claudeDesktopConfigFile, claudeDesktopState, connectClaudeDesktop, disconnectClaudeDesktop, serverEntry } from "./claude-desktop.js";

/** Where the AI apps keep their settings, and the `frameshell` command they are told to run. */
export interface AiAppsPlace {
  home: string;
  /** The variables that move an app's settings (`APPDATA`, `CODEX_HOME`, `CLAUDE_CONFIG_DIR`). */
  env: NodeJS.ProcessEnv;
  setup: ServerSetup;
}

/**
 * The real home and environment. `FRAMESHELL_TEST_HOME` (tests only) puts every app's settings under that folder and
 * ignores the variables that would move them, so a test never reads or writes the real ones.
 */
export function aiAppsPlace(env: NodeJS.ProcessEnv, setup: ServerSetup): AiAppsPlace {
  const test = env["FRAMESHELL_TEST_HOME"];
  return test ? { home: test, env: {}, setup } : { home: homedir(), env, setup };
}

/** One app's settings files and what can be done to them; the backups each change made (null: none). */
interface Connector {
  files: string[];
  state(): Promise<ServerState>;
  connect(): Promise<(string | null)[]>;
  disconnect(): Promise<(string | null)[]>;
}

/** App `id`'s connector at `place`; null where the app does not exist (Claude Desktop on Linux). */
async function connectorOf(id: AiAppId, { home, env, setup }: AiAppsPlace): Promise<Connector | null> {
  switch (id) {
    case "claude-desktop": {
      const file = await claudeDesktopConfigFile(setup.platform, home, env);
      if (!file) return null;
      const entry = serverEntry(setup.command, setup.platform);
      return {
        files: [file],
        state: () => claudeDesktopState(file, entry),
        connect: async () => [await connectClaudeDesktop(file, entry)],
        disconnect: async () => [await disconnectClaudeDesktop(file)],
      };
    }
    case "codex": {
      const file = codexConfigPath(home, env);
      return {
        files: [file],
        state: () => codexState(file, setup),
        connect: async () => [await connectCodex(file, setup)],
        disconnect: async () => [await disconnectCodex(file)],
      };
    }
    case "claude-code": {
      const paths = claudeCodePaths(home, env);
      return {
        files: [paths.mcp, paths.settings],
        state: async () => {
          const { installed, server, hook, connected } = await claudeCodeState(paths, setup);
          return { installed, connected, different: !connected && (server || hook) };
        },
        connect: async () => Object.values(await connectClaudeCode(paths, setup)),
        disconnect: async () => Object.values(await disconnectClaudeCode(paths)),
      };
    }
    case "gemini": {
      const file = geminiSettingsPath(home);
      return {
        files: [file],
        state: () => geminiState(file, setup),
        connect: async () => [await connectGemini(file, setup)],
        disconnect: async () => [await disconnectGemini(file)],
      };
    }
  }
}

function problemOf(error: unknown): AiAppProblem {
  return error instanceof InvalidConfigError ? { kind: "invalid", file: error.file } : { kind: "failed", message: (error as Error).message ?? String(error) };
}

/** What app `id`'s settings say about Frameshell now. Never throws: a file that cannot be read is its `problem`. */
export async function aiAppStatus(id: AiAppId, place: AiAppsPlace): Promise<AiAppStatus> {
  const connector = await connectorOf(id, place);
  if (!connector) return { id, available: false, installed: false, connected: false, different: false, files: [], problem: null };
  try {
    return { id, available: true, ...(await connector.state()), files: connector.files, problem: null };
  } catch (error) {
    return { id, available: true, installed: true, connected: false, different: false, files: connector.files, problem: problemOf(error) };
  }
}

/** Frameshell's server as JSON to paste into apps with no connector, the same entry the connectors write. */
export function serverSnippets(setup: ServerSetup): AiApps["snippets"] {
  const entry = serverEntry(setup.command, setup.platform);
  return {
    mcpServers: JSON.stringify({ mcpServers: { [SERVER_KEY]: entry } }, null, 2),
    vscode: JSON.stringify({ servers: { [SERVER_KEY]: { type: "stdio", ...entry } } }, null, 2),
  };
}

/** Every app's status, in {@link AI_APP_IDS} order, and the snippets for apps with no connector. */
export async function aiApps(place: AiAppsPlace): Promise<AiApps> {
  return { apps: await Promise.all(AI_APP_IDS.map((id) => aiAppStatus(id, place))), snippets: serverSnippets(place.setup) };
}

/**
 * Connect (or disconnect) app `id`: only Frameshell's entries change, each changed file is backed up first. Connect is
 * refused while the app's settings folder does not exist. Never throws: what went wrong is the result's `problem`.
 */
export async function changeAiApp(id: AiAppId, connect: boolean, place: AiAppsPlace): Promise<AiAppChange> {
  const before = await aiAppStatus(id, place);
  const connector = await connectorOf(id, place);
  if (!connector) return { status: before, backups: [], problem: null };
  if (connect && !before.installed) return { status: before, backups: [], problem: { kind: "not-installed" } };
  try {
    const backups = (await (connect ? connector.connect() : connector.disconnect())).filter((file): file is string => file !== null);
    return { status: await aiAppStatus(id, place), backups, problem: null };
  } catch (error) {
    return { status: await aiAppStatus(id, place), backups: [], problem: problemOf(error) };
  }
}
