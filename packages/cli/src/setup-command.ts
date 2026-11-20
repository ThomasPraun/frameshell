// `frameshell setup claude-code | codex | gemini` (ADR 0025 decision 7): the CLI twin of the app's "Connect …" buttons.
import { homedir } from "node:os";
import { parseArgs } from "node:util";
import {
  type ClaudeCodeSetup,
  claudeCodePaths,
  claudeCodeState,
  connectClaudeCode,
  disconnectClaudeCode,
} from "./claude-code-setup.js";
import { codexConfigPath, codexState, connectCodex, disconnectCodex } from "./codex-setup.js";
import { connectGemini, disconnectGemini, geminiSettingsPath, geminiState } from "./gemini-setup.js";
import type { ServerState } from "./config-file.js";

/** Usage of `frameshell setup`. */
export const SETUP_USAGE = `Usage: frameshell setup claude-code|codex|gemini [--status | --remove] [--command <path>] [--json]

claude-code  Connect Claude Code to Frameshell at user level: the MCP server in ~/.claude.json and a
             UserPromptSubmit hook (\`frameshell ask --take\`) in ~/.claude/settings.json, so what you send with
             "Chat about this" in the app reaches your next message.
codex        Connect Codex and the ChatGPT desktop app, which share ~/.codex/config.toml (CODEX_HOME when set):
             the [mcp_servers.frameshell] table.
gemini       Connect Gemini CLI: mcpServers.frameshell in ~/.gemini/settings.json.

Only Frameshell's entries change, every other byte stays; each changed file is first copied to
<file>.frameshell-backup. A file that does not parse is left alone. Running it again changes nothing.
Restart the app afterwards.

  --status    Print what is connected and change nothing
  --remove    Take Frameshell's entries out again
  --command   The frameshell executable the app runs (default: frameshell, found on PATH)
`;

/** The agents `frameshell setup` knows. */
const AGENTS = ["claude-code", "codex", "gemini"] as const;

/** Flags `frameshell setup claude-code` takes besides the global ones. */
export const SETUP_FLAGS: readonly string[] = ["status", "remove", "command"];

/** Process surface of `frameshell setup`. */
export interface SetupIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  env: NodeJS.ProcessEnv;
  /** The user home the apps keep their config under (default: the real one); tests pass a temp dir. */
  home?: string;
}

/** Run `frameshell setup …` (`argv` after `setup`). Returns the exit code: 0 ok, 1 failed, 2 usage error. Never throws. */
export async function runSetup(argv: string[], io: SetupIo): Promise<number> {
  let values;
  let positionals;
  try {
    ({ values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        status: { type: "boolean", default: false },
        remove: { type: "boolean", default: false },
        command: { type: "string" },
        json: { type: "boolean", default: false },
        help: { type: "boolean", default: false },
      },
    }));
  } catch (error) {
    io.stderr(`${(error as Error).message}\n\n${SETUP_USAGE}`);
    return 2;
  }
  if (values.help) {
    io.stdout(SETUP_USAGE);
    return 0;
  }
  const agent = AGENTS.find((name) => name === positionals[0]);
  if (positionals.length !== 1 || !agent) {
    io.stderr(`\`frameshell setup\` takes one agent: ${AGENTS.join(", ")}.\n\n${SETUP_USAGE}`);
    return 2;
  }
  if (values.status && values.remove) {
    io.stderr(`Pick one of --status and --remove.\n\n${SETUP_USAGE}`);
    return 2;
  }
  const setup: ClaudeCodeSetup = { command: values.command ?? "frameshell", platform: process.platform };
  if (agent !== "claude-code") return runSingleFile(agent, setup, values, io);
  const paths = claudeCodePaths(io.home ?? homedir(), io.env);
  try {
    let backups = { mcp: null as string | null, settings: null as string | null };
    if (values.remove) backups = await disconnectClaudeCode(paths);
    else if (!values.status) backups = await connectClaudeCode(paths, setup);
    const state = await claudeCodeState(paths, setup);
    if (values.json) {
      io.stdout(`${JSON.stringify({ ...state, files: paths, backups }, null, 2)}\n`);
      return 0;
    }
    const lines = [
      `Claude Code ${state.installed ? "found" : "not found"}; Frameshell server ${state.server ? "connected" : "not connected"} (${paths.mcp}), prompt hook ${state.hook ? "connected" : "not connected"} (${paths.settings}).`,
    ];
    for (const backup of [backups.mcp, backups.settings]) if (backup) lines.push(`Backup of the previous file: ${backup}`);
    if (!values.status && !values.remove) lines.push("Restart running Claude Code sessions to use it.");
    io.stdout(`${lines.join("\n")}\n`);
    return 0;
  } catch (error) {
    io.stderr(`frameshell: ${(error as Error).message}\n`);
    return 1;
  }
}

/** `setup codex` and `setup gemini`: one config file each. */
async function runSingleFile(agent: "codex" | "gemini", setup: ClaudeCodeSetup, values: { status?: boolean; remove?: boolean; json?: boolean }, io: SetupIo): Promise<number> {
  const target =
    agent === "codex"
      ? singleFile("Codex (and the ChatGPT desktop app)", codexConfigPath(io.home ?? homedir(), io.env), (file) => ({
          state: () => codexState(file, setup),
          connect: () => connectCodex(file, setup),
          remove: () => disconnectCodex(file),
        }))
      : singleFile("Gemini CLI", geminiSettingsPath(io.home ?? homedir()), (file) => ({
          state: () => geminiState(file, setup),
          connect: () => connectGemini(file, setup),
          remove: () => disconnectGemini(file),
        }));
  try {
    let backup: string | null = null;
    if (values.remove) backup = await target.remove();
    else if (!values.status) backup = await target.connect();
    const state = await target.state();
    if (values.json) {
      io.stdout(`${JSON.stringify({ ...state, file: target.file, backup }, null, 2)}\n`);
      return 0;
    }
    const entry = state.connected ? "connected" : state.different ? "set to a different command" : "not connected";
    const lines = [`${target.label} ${state.installed ? "found" : "not found"}; Frameshell server ${entry} (${target.file}).`];
    if (backup) lines.push(`Backup of the previous file: ${backup}`);
    if (!values.status && !values.remove) lines.push("Restart the app to use it.");
    io.stdout(`${lines.join("\n")}\n`);
    return 0;
  } catch (error) {
    io.stderr(`frameshell: ${(error as Error).message}\n`);
    return 1;
  }
}

/** One app's label, config file and the three things done to it. */
function singleFile(
  label: string,
  file: string,
  actions: (file: string) => { state: () => Promise<ServerState>; connect: () => Promise<string | null>; remove: () => Promise<string | null> },
) {
  return { label, file, ...actions(file) };
}
