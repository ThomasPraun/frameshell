import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

/** The process that ran the CLI: the user's or agent's shell. */
export interface ShellProbe {
  /** Parent pid of the CLI process. */
  ppid: number;
  /** Opaque start time of process `pid`, or null when unknown. Tells a shell apart from a later one reusing its pid. */
  startTime(pid: number): string | null;
}

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

/** {@link ShellProbe} of this process. */
export function currentShell(): ShellProbe {
  return { ppid: process.ppid, startTime: processStartTime };
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
