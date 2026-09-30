// Which agent CLI runs in a terminal (SPEC §6.2): the terminal's foreground command, matched by name.
import { execFile } from "node:child_process";
import { agentLabel } from "@frameshell/protocol";

/** Agent CLIs known by command name: name → label. */
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
};

/** Programs that run a script named by their first non-flag argument. */
const INTERPRETERS = new Set(["node", "bun", "deno", "python", "python3", "ruby"]);

/**
 * Command name → agent label to detect: {@link KNOWN_AGENTS} changed by
 * `FRAMESHELL_AGENT_COMMANDS`, comma-separated `name=label` (add or relabel),
 * `name` (label = name) or `name=` (never an agent).
 */
export function agentCommands(env: NodeJS.ProcessEnv): Record<string, string> {
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
 * Agent label of a foreground command line (`argv`, program first), or null.
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

/**
 * Command line of the foreground process group of the terminal whose shell
 * is `shellPid`, via `ps` (what a process set as its title, as Node CLIs do,
 * shows there). Null when the shell itself is in the foreground, on Windows
 * (no foreground process groups) or when `ps` fails.
 */
export async function foregroundCommand(shellPid: number): Promise<string[] | null> {
  if (process.platform === "win32") return null;
  const group = Number((await ps(["-o", "tpgid=", "-p", String(shellPid)]))?.trim());
  if (!Number.isInteger(group) || group <= 0 || group === shellPid) return null;
  const line = (await ps(["-ww", "-o", "args=", "-p", String(group)]))?.trim();
  return line ? line.split(/\s+/) : null;
}

function ps(args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("ps", args, { encoding: "utf8", timeout: 2000, env: { ...process.env, LC_ALL: "C" } }, (error, stdout) =>
      resolve(error ? null : stdout),
    );
  });
}
