// `frameshell setup claude-code` (ADR 0025 decision 7): the CLI twin of the app's "Connect Claude Code".
import { homedir } from "node:os";
import { parseArgs } from "node:util";
import {
  type ClaudeCodeSetup,
  claudeCodePaths,
  claudeCodeState,
  connectClaudeCode,
  disconnectClaudeCode,
} from "./claude-code-setup.js";

/** Usage of `frameshell setup`. */
export const SETUP_USAGE = `Usage: frameshell setup claude-code [--status | --remove] [--command <path>] [--json]

Connect Claude Code to Frameshell at user level: the MCP server in ~/.claude.json and a UserPromptSubmit
hook (\`frameshell ask --take\`) in ~/.claude/settings.json, so what you send with "Chat about this" in the
app reaches your next message. Only Frameshell's entries change; each changed file is first copied to
<file>.frameshell-backup. Running it again changes nothing.

  --status    Print what is connected and change nothing
  --remove    Take Frameshell's server and hook out again
  --command   The frameshell executable Claude Code runs (default: frameshell, found on PATH)
`;

/** Flags `frameshell setup claude-code` takes besides the global ones. */
export const SETUP_FLAGS: readonly string[] = ["status", "remove", "command"];

/** Process surface of `frameshell setup`. */
export interface SetupIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  env: NodeJS.ProcessEnv;
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
  if (positionals.length !== 1 || positionals[0] !== "claude-code") {
    io.stderr(`\`frameshell setup\` knows one agent, claude-code.\n\n${SETUP_USAGE}`);
    return 2;
  }
  if (values.status && values.remove) {
    io.stderr(`Pick one of --status and --remove.\n\n${SETUP_USAGE}`);
    return 2;
  }
  const setup: ClaudeCodeSetup = { command: values.command ?? "frameshell", platform: process.platform };
  const paths = claudeCodePaths(homedir(), io.env);
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
