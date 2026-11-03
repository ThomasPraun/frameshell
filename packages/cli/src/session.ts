import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { agentCommands, agentLabel, agentOfCommand, clientAgentLabel } from "@frameshell/protocol";

/** The process that ran the CLI: the user's or agent's shell. */
export interface ShellProbe {
  /** Parent pid of the CLI process. */
  ppid: number;
  /** Opaque start time of process `pid`, or null when unknown. Tells a shell apart from a later one reusing its pid. */
  startTime(pid: number): string | null;
  /** Parent pid and command line of process `pid`, or null when unknown (gone, Windows). */
  process(pid: number): { ppid: number; argv: string[] } | null;
}

/** Ancestors looked at for an agent: a shell, a harness's tool runner and the agent itself are well within it. */
const MAX_ANCESTORS = 8;

/**
 * Terminal session the CLI reports in its handshake (SPEC §6.2):
 * `FRAMESHELL_SESSION` when set and non-empty (app terminals set it), else
 * one generated from the parent shell: `sh-<pid>-<8 hex of pid + start time>`,
 * or `sh-<pid>` when the start time is unknown (Windows). Every call typed in
 * one shell gets the same id, so its operations group into transactions and
 * `tx begin` works. A harness that spawns a new shell per command gets a new
 * session per command; it should set `FRAMESHELL_SESSION` itself.
 */
export function resolveSession(env: NodeJS.ProcessEnv, probe: ShellProbe = currentShell()): string {
  const named = env["FRAMESHELL_SESSION"];
  if (named) return named;
  const started = probe.startTime(probe.ppid);
  if (started === null) return `sh-${probe.ppid}`;
  return `sh-${probe.ppid}-${createHash("sha256").update(`${probe.ppid}\0${started}`).digest("hex").slice(0, 8)}`;
}

/**
 * Agent label the CLI (and MCP server) reports in its handshake (SPEC §6.2).
 * `FRAMESHELL_AGENT` decides when set: empty or unusable = null (not an agent,
 * overriding detection). Otherwise the agent found in the parent process chain
 * (`claude` → its shell → `frameshell`), by the names app terminals detect
 * (`agentCommands`); undefined when none, which leaves it to the app's
 * detection of the terminal.
 */
export function resolveAgent(env: NodeJS.ProcessEnv, probe: ShellProbe = currentShell()): string | null | undefined {
  const named = env["FRAMESHELL_AGENT"];
  if (named !== undefined) return agentLabel(named);
  const commands = agentCommands(env);
  const seen = new Set<number>();
  for (let pid = probe.ppid, depth = 0; pid > 1 && !seen.has(pid) && depth < MAX_ANCESTORS; depth++) {
    seen.add(pid);
    const found = probe.process(pid);
    if (found === null) return undefined;
    const label = agentOfCommand(found.argv, commands);
    if (label !== null) return label;
    pid = found.ppid;
  }
  return undefined;
}

/**
 * Agent label of the MCP server: `FRAMESHELL_AGENT` as {@link resolveAgent}, else the label of the MCP client
 * (`initialize` `clientInfo.name`, ADR 0025 decision 6), else what {@link resolveAgent} finds in the process chain.
 */
export function resolveMcpAgent(
  env: NodeJS.ProcessEnv,
  client: { name: string } | null,
  probe: ShellProbe = currentShell(),
): string | null | undefined {
  if (env["FRAMESHELL_AGENT"] === undefined && client) {
    const label = clientAgentLabel(client.name);
    if (label !== null) return label;
  }
  return resolveAgent(env, probe);
}

/** {@link ShellProbe} of this process. */
export function currentShell(): ShellProbe {
  return { ppid: process.ppid, startTime: processStartTime, process: processInfo };
}

/** Start time from `/proc` on Linux, `ps` on other Unixes; null on Windows (no cheap source) or on failure. */
function processStartTime(pid: number): string | null {
  try {
    if (process.platform === "win32") return null;
    if (process.platform === "linux") {
      // Field 22 (`starttime`, clock ticks since boot); fields restart after the `(comm)` field, which may hold spaces.
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] ?? null;
    }
    const out = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C" },
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000,
    }).trim();
    return out === "" ? null : out;
  } catch {
    return null;
  }
}

/** Parent pid and command line from `ps` (what a process set as its title shows there); null on Windows or on failure. */
function processInfo(pid: number): { ppid: number; argv: string[] } | null {
  if (process.platform === "win32") return null;
  try {
    const out = execFileSync("ps", ["-ww", "-o", "ppid=,args=", "-p", String(pid)], {
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C" },
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000,
    }).trim();
    const match = /^(\d+)\s+(.+)$/.exec(out);
    return match ? { ppid: Number(match[1]), argv: match[2]!.split(/\s+/) } : null;
  } catch {
    return null;
  }
}
