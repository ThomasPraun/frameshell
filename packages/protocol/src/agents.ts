// Agent labels (SPEC §6.2): which agent CLI (Claude Code, Codex, …) ran a terminal session's operations.
import { z } from "zod";

/** Pattern of an agent label: lowercase letters, digits, `.`, `_`, `-`; starts with a letter or digit; ≤ 32 chars. */
export const AGENT_LABEL_PATTERN = "[a-z0-9][a-z0-9._-]{0,31}";

/** An agent label, e.g. `claude`, `codex`, `gemini`. */
export const AgentLabelSchema = z
  .string()
  .regex(new RegExp(`^${AGENT_LABEL_PATTERN}$`), "must be lowercase letters, digits, `.`, `_` or `-`, at most 32")
  .describe("Agent CLI running in the terminal, as a short lowercase label, e.g. `claude`, `codex`, `gemini`.");

/**
 * Label for a free-form agent name (`FRAMESHELL_AGENT`, a process name):
 * lowercased, runs of other characters turned into `-`, trimmed, capped.
 * Null when nothing usable is left.
 */
export function agentLabel(name: string): string | null {
  const label = name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[._-]+/, "")
    .slice(0, 32)
    .replace(/-+$/, "");
  return label === "" ? null : label;
}

/**
 * Journal author of operations an agent ran from terminal `session`:
 * `agent:<label>:<session>`, or `agent:<label>` without a session.
 */
export function agentAuthor(label: string, session: string | null): string {
  return session ? `agent:${label}:${session}` : `agent:${label}`;
}

/**
 * MCP client names (`clientInfo.name`) of agents that have their own label in app terminals, so one agent keeps one
 * label: Claude Code 2.1.317 sends `claude-code` (read from its build, 2026-11-02; ADR 0025).
 */
const CLIENT_AGENTS: Readonly<Record<string, string>> = {
  "claude-code": "claude",
};

/** Agent label of a client name (MCP `clientInfo.name`, `frameshell ask --as`): a known client's terminal label, else {@link agentLabel}. */
export function clientAgentLabel(client: string): string | null {
  const label = agentLabel(client);
  return label === null ? null : (CLIENT_AGENTS[label] ?? label);
}

/** Agent CLIs known by command name: name → label. The one table app terminals, the CLI and the MCP server share. */
const KNOWN_AGENTS: Readonly<Record<string, string>> = {
  claude: "claude",
  codex: "codex",
  gemini: "gemini",
  aider: "aider",
  opencode: "opencode",
  amp: "amp",
  goose: "goose",
  "cursor-agent": "cursor-agent",
  qwen: "qwen",
  copilot: "copilot",
  crush: "crush",
  // Short name: `FRAMESHELL_AGENT_COMMANDS=pi=` stops it matching an unrelated `pi` program.
  pi: "pi",
};

/** Programs that run a script named by their first non-flag argument. */
const INTERPRETERS = new Set(["node", "bun", "deno", "python", "python3", "ruby"]);

/**
 * Command name → agent label to detect: the known agents changed by
 * `FRAMESHELL_AGENT_COMMANDS`, comma-separated `name=label` (add or relabel),
 * `name` (label = name) or `name=` (never an agent).
 */
export function agentCommands(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const commands: Record<string, string> = { ...KNOWN_AGENTS };
  for (const entry of (env["FRAMESHELL_AGENT_COMMANDS"] ?? "").split(",")) {
    const [rawName = "", ...rest] = entry.split("=");
    const name = rawName.trim().toLowerCase();
    if (!name) continue;
    const label = rest.length === 0 ? agentLabel(name) : agentLabel(rest.join("="));
    if (label) commands[name] = label;
    else delete commands[name];
  }
  return commands;
}

/**
 * Agent label of a command line (`argv`, program first), or null.
 * Matches the program's name, or for an interpreter (`node`, `python3`, …)
 * its script's, ignoring directories, a login shell's `-` and extensions
 * such as `.exe`, `.cmd` or `.js`.
 */
export function agentOfCommand(argv: readonly string[], commands: Readonly<Record<string, string>> = KNOWN_AGENTS): string | null {
  const [program, ...args] = argv;
  if (program === undefined) return null;
  const name = commandName(program);
  if (Object.hasOwn(commands, name)) return commands[name]!;
  if (!INTERPRETERS.has(name)) return null;
  const script = args.find((arg) => !arg.startsWith("-"));
  if (script === undefined) return null;
  const scriptName = commandName(script);
  return Object.hasOwn(commands, scriptName) ? commands[scriptName]! : null;
}

function commandName(path: string): string {
  return (path.split(/[\\/]/).pop() ?? "")
    .replace(/^-/, "")
    .replace(/\.(exe|cmd|bat|ps1|js|mjs|cjs|py)$/i, "")
    .toLowerCase();
}
