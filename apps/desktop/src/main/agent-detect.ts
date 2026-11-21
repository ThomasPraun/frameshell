// Which agent CLI runs in a terminal (SPEC §6.2): the terminal's foreground command on macOS and Linux, the commands
// under its shell on Windows; matching is in @frameshell/protocol.
import { type ChildProcessWithoutNullStreams, execFile, spawn } from "node:child_process";

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

/** One process of a Windows process table. */
export interface ProcessRow {
  pid: number;
  parent: number;
  /** Its command line as Windows keeps it: one string, quoted where a part has spaces. */
  command: string;
}

/**
 * Command lines of the processes under `root` (not `root` itself), nearest first: Windows has no foreground process
 * group, so an agent started from the shell is found among its descendants (ADR 0048). Each line is split as
 * {@link splitCommandLine} does; a process without a command line (another user's, a system one) is skipped.
 */
export function descendantCommands(rows: readonly ProcessRow[], root: number): string[][] {
  const children = new Map<number, ProcessRow[]>();
  for (const row of rows) {
    // A reused pid can name itself its parent: never a loop.
    if (row.pid === row.parent) continue;
    children.set(row.parent, [...(children.get(row.parent) ?? []), row]);
  }
  const found: string[][] = [];
  const seen = new Set<number>([root]);
  let level = children.get(root) ?? [];
  while (level.length > 0) {
    const next: ProcessRow[] = [];
    for (const row of level) {
      if (seen.has(row.pid)) continue;
      seen.add(row.pid);
      const argv = splitCommandLine(row.command);
      if (argv.length > 0) found.push(argv);
      next.push(...(children.get(row.pid) ?? []));
    }
    level = next;
  }
  return found;
}

/**
 * A Windows command line split into its parts: spaces separate them except inside double quotes, which are dropped.
 * Enough to read a program and its script (`"C:\Program Files\nodejs\node.exe" C:\…\cli.js`), not every escape
 * rule of the C runtime.
 */
export function splitCommandLine(line: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quoted = false;
  let open = false;
  for (const char of line) {
    if (char === '"') {
      quoted = !quoted;
      open = true;
    } else if (!quoted && /\s/.test(char)) {
      if (open) parts.push(current);
      current = "";
      open = false;
    } else {
      current += char;
      open = true;
    }
  }
  if (open) parts.push(current);
  return parts;
}

/** Rows of `id<TAB>parent<TAB>command line` lines, as {@link WindowsProcessTable} prints them. */
export function parseProcessRows(text: string): ProcessRow[] {
  return text.split(/\r?\n/).flatMap((line) => {
    const [pid = "", parent = "", ...command] = line.split("\t");
    const row = { pid: Number(pid), parent: Number(parent), command: command.join("\t").trim() };
    return Number.isInteger(row.pid) && Number.isInteger(row.parent) && pid !== "" ? [row] : [];
  });
}

const END = "<<frameshell-processes>>";
/** One query: every process with its parent and command line, then the end marker. */
const QUERY = `Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CommandLine | ForEach-Object { "$($_.ProcessId)\`t$($_.ParentProcessId)\`t$($_.CommandLine)" }; "${END}"\n`;
/** A snapshot this recent answers every terminal that asks: one query per poll, however many terminals. */
const SNAPSHOT_MS = 500;
/** The PowerShell quits after this long without a query, so an idle app keeps no process around. */
const IDLE_MS = 15_000;
/** A query that takes longer than this gives up (the PowerShell is restarted on the next one). */
const QUERY_TIMEOUT_MS = 10_000;

/**
 * The Windows process table, read by one long-lived PowerShell (starting one per query would cost a second of CPU
 * every poll). Started on the first query, stopped after {@link IDLE_MS} without one.
 */
export class WindowsProcessTable {
  #shell: ChildProcessWithoutNullStreams | null = null;
  #output = "";
  #waiting: ((text: string | null) => void) | null = null;
  #idle: NodeJS.Timeout | undefined;
  #last: { at: number; rows: Promise<ProcessRow[]> } | null = null;

  /** Every process now, or a snapshot under {@link SNAPSHOT_MS} old. Empty when PowerShell fails. */
  snapshot(): Promise<ProcessRow[]> {
    const now = Date.now();
    if (this.#last && now - this.#last.at < SNAPSHOT_MS) return this.#last.rows;
    const rows = this.#query().then((text) => (text === null ? [] : parseProcessRows(text)));
    this.#last = { at: now, rows };
    return rows;
  }

  /** Stop the PowerShell now. */
  close(): void {
    clearTimeout(this.#idle);
    this.#shell?.kill();
    this.#shell = null;
    this.#waiting?.(null);
    this.#waiting = null;
  }

  async #query(): Promise<string | null> {
    // One query at a time: a second asker waits for the first, then reads a fresh table.
    while (this.#waiting) await new Promise((resolve) => setTimeout(resolve, 50));
    clearTimeout(this.#idle);
    const shell = this.#start();
    if (!shell) return null;
    const text = await new Promise<string | null>((resolve) => {
      const timer = setTimeout(() => {
        this.close();
        resolve(null);
      }, QUERY_TIMEOUT_MS);
      this.#waiting = (result) => {
        clearTimeout(timer);
        resolve(result);
      };
      shell.stdin.write(QUERY);
    });
    this.#waiting = null;
    this.#idle = setTimeout(() => this.close(), IDLE_MS);
    this.#idle.unref?.();
    return text;
  }

  #start(): ChildProcessWithoutNullStreams | null {
    if (this.#shell) return this.#shell;
    try {
      const shell = spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "-"], { windowsHide: true });
      shell.stdout.setEncoding("utf8");
      shell.stdout.on("data", (chunk: string) => {
        this.#output += chunk;
        const end = this.#output.indexOf(END);
        if (end < 0) return;
        const text = this.#output.slice(0, end);
        this.#output = this.#output.slice(end + END.length);
        this.#waiting?.(text);
      });
      const gone = () => {
        if (this.#shell === shell) this.#shell = null;
        this.#output = "";
        this.#waiting?.(null);
      };
      shell.on("error", gone);
      shell.on("exit", gone);
      shell.stdin.on("error", () => {});
      shell.unref();
      // Command lines with accents come through whole.
      shell.stdin.write("[Console]::OutputEncoding = [Text.Encoding]::UTF8\n");
      this.#shell = shell;
      return shell;
    } catch {
      return null;
    }
  }
}
