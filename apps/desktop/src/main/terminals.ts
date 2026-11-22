import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import * as pty from "node-pty";
import { agentCommands, agentOfCommand } from "@frameshell/protocol";
import { WindowsProcessTable, descendantCommands, foregroundCommand } from "./agent-detect.js";
import { OutputRing, type OutputRingLimits } from "./output-ring.js";
import type { TerminalLaunch } from "./terminal-launch.js";

/** Where terminal output, exits and agent changes go; main forwards them to the renderer and daemon. */
export interface TerminalEvents {
  onData(id: string, data: string): void;
  onExit(id: string, exitCode: number): void;
  /**
   * The agent CLI in the terminal's foreground changed: `agent` is its label,
   * null once it quit or the terminal closed. `session` is the terminal's
   * `FRAMESHELL_SESSION` (null when its launch set none).
   */
  onAgent?(id: string, session: string | null, agent: string | null): void;
}

/** Options for {@link TerminalManager}. */
export interface TerminalManagerOptions {
  /** Agent label of a shell's foreground command, or null. Default: `ps` + {@link agentOfCommand}; on Windows the commands under the shell. */
  detectAgent?: ((shellPid: number) => Promise<string | null>) | null;
  /** How often to look at each terminal's foreground, ms. */
  agentPollMs?: number;
  /**
   * Call `detectAgent` on every poll instead of only when node-pty's foreground name changed. Default: on Windows,
   * where that name stays the shell's.
   */
  probeEveryPoll?: boolean;
  /** Output kept per terminal for {@link TerminalManager.attach}. Default: about 10,000 lines, 4 MiB. */
  outputLimits?: OutputRingLimits;
}

/** Output is flushed at most this often: one IPC message per burst instead of per chunk. */
const FLUSH_MS = 5;
/** Agents take seconds before their first command: a second's lag in noticing one is harmless. */
const AGENT_POLL_MS = 1000;
/** On Windows each poll reads the process table (one shared query), so it looks less often. */
const WINDOWS_POLL_MS = 2000;
/**
 * A foreground found not to be an agent is looked at again for this long: Node CLIs
 * (Claude Code, Codex, ...) show as `node` until they set their process title.
 */
const TITLE_SETTLE_MS = 5000;
/**
 * How long a killed shell has to exit after the hang-up before it gets SIGKILL (not Windows). Bash can catch the
 * hang-up while readline is finishing a line and go back to its prompt, so the tab would never close.
 */
const KILL_GRACE_MS = 2000;
/** Longest {@link TerminalManager.killAll} waits for shells to exit: quitting must not hang on one. */
const EXIT_WAIT_MS = 5000;

/**
 * Whether process `pid` still exists. A shell that exited but whose `onExit` has not arrived yet (node-pty waits
 * for trailing output first) is not: killing it throws or logs on Windows, so {@link TerminalManager} skips that and
 * waits for the exit event.
 */
export function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

interface Entry {
  pty: pty.IPty;
  /** Settles when the shell has exited. */
  exited: Promise<void>;
  buffer: string;
  timer: NodeJS.Timeout | undefined;
  /** Send the buffered output now. */
  flush: () => void;
  session: string | null;
  /** Shell program name: while the foreground has it, no agent runs. */
  shell: string;
  agent: string | null;
  /** Foreground name (node-pty's cheap `process`) the agent was last looked up for. */
  probed: string | null;
  /** When the {@link Entry.probed} foreground was first looked up, ms since epoch. */
  probedSince: number;
  poll: NodeJS.Timeout | undefined;
  probing: boolean;
}

/** One process table for every window's terminals on Windows. */
let windowsTable: WindowsProcessTable | undefined;

/**
 * Detection from `ps` on Unix. Windows has no foreground process groups to read: there the first agent among the
 * commands under the shell is it (ADR 0048).
 */
function defaultDetect(): ((shellPid: number) => Promise<string | null>) | null {
  const commands = agentCommands(process.env);
  if (process.platform === "win32") {
    return async (shellPid) => {
      windowsTable ??= new WindowsProcessTable();
      for (const argv of descendantCommands(await windowsTable.snapshot(), shellPid)) {
        const agent = agentOfCommand(argv, commands);
        if (agent) return agent;
      }
      return null;
    };
  }
  return async (shellPid) => {
    const argv = await foregroundCommand(shellPid);
    return argv ? agentOfCommand(argv, commands) : null;
  };
}

/**
 * Real pseudo-terminals (node-pty; ConPTY on Windows) for one project window.
 * A terminal lives until it is killed: its views come and go (ADR 0012), and
 * {@link TerminalManager.attach} replays its recent output into a new one.
 * Sessions die with the window (SPEC §3.2).
 */
export class TerminalManager {
  readonly #terminals = new Map<string, Entry>();
  /** Recent output per terminal, kept after its shell exits until the terminal is killed. */
  readonly #output = new Map<string, OutputRing>();
  /** What a view needs to show each terminal not killed yet, in creation order: {@link TerminalManager.list}. */
  readonly #listed = new Map<string, { session: string; shell: string; exitCode: number | null }>();
  readonly #detect: ((shellPid: number) => Promise<string | null>) | null;
  readonly #pollMs: number;
  /** Look up the agent on every poll: node-pty's foreground name is the shell's for good on Windows. */
  readonly #probeEveryPoll: boolean;
  readonly #outputLimits: OutputRingLimits | undefined;

  constructor(
    private readonly events: TerminalEvents,
    options: TerminalManagerOptions = {},
  ) {
    this.#detect = options.detectAgent === undefined ? defaultDetect() : options.detectAgent;
    const windows = process.platform === "win32";
    this.#pollMs = options.agentPollMs ?? (windows ? WINDOWS_POLL_MS : AGENT_POLL_MS);
    this.#probeEveryPoll = options.probeEveryPoll ?? windows;
    this.#outputLimits = options.outputLimits;
  }

  /** Spawn a shell. `id` addresses the terminal in every later call and event. */
  create(launch: TerminalLaunch, size: { cols: number; rows: number }): { id: string; shell: string } {
    const id = randomUUID();
    const proc = pty.spawn(launch.file, launch.args, {
      name: "xterm-256color",
      cols: Math.max(2, size.cols),
      rows: Math.max(1, size.rows),
      cwd: launch.cwd,
      env: launch.env,
    });
    const shell = basename(launch.file).replace(/\.exe$/i, "");
    let markExited = () => {};
    const output = new OutputRing(this.#outputLimits);
    const entry: Entry = {
      pty: proc,
      exited: new Promise((resolve) => (markExited = resolve)),
      buffer: "",
      timer: undefined,
      flush: () => {
        clearTimeout(entry.timer);
        entry.timer = undefined;
        if (!entry.buffer) return;
        const data = entry.buffer;
        entry.buffer = "";
        output.append(data);
        this.events.onData(id, data);
      },
      session: launch.env["FRAMESHELL_SESSION"] || null,
      shell,
      agent: null,
      probed: null,
      probedSince: 0,
      poll: undefined,
      probing: false,
    };
    proc.onData((data) => {
      entry.buffer += data;
      entry.timer ??= setTimeout(entry.flush, FLUSH_MS);
    });
    proc.onExit(({ exitCode }) => {
      markExited();
      const listed = this.#listed.get(id);
      if (listed) listed.exitCode = exitCode;
      entry.flush();
      this.#terminals.delete(id);
      this.#stopWatching(id, entry);
      this.events.onExit(id, exitCode);
    });
    this.#terminals.set(id, entry);
    this.#output.set(id, output);
    this.#listed.set(id, { session: entry.session ?? "", shell, exitCode: null });
    if (this.#detect) entry.poll = setInterval(() => void this.#watch(id, entry), this.#pollMs);
    return { id, shell };
  }

  /**
   * Terminals not killed yet, oldest first: running ones, and exited ones whose output is still kept. A reloaded
   * window (a language change, Ctrl+R) shows them again instead of starting new shells, so an agent running in one
   * goes on (ADR 0012).
   */
  list(): { id: string; session: string; shell: string; exitCode: number | null; agent: string | null }[] {
    return [...this.#listed].map(([id, listed]) => ({ id, ...listed, agent: this.#terminals.get(id)?.agent ?? null }));
  }

  /** Sessions whose terminal runs an agent now, with its label: to tag them again in a restarted daemon. */
  agents(): { session: string; agent: string }[] {
    return [...this.#terminals.values()].flatMap(({ session, agent }) => (session && agent ? [{ session, agent }] : []));
  }

  /** Look up the agent when the foreground changed, and while it settles; `ps` runs only then, not every poll. */
  async #watch(id: string, entry: Entry): Promise<void> {
    if (entry.probing || !this.#detect) return;
    if (this.#probeEveryPoll) {
      entry.probing = true;
      try {
        const agent = await this.#detect(entry.pty.pid);
        if (this.#terminals.get(id) === entry) this.#setAgent(id, entry, agent);
      } finally {
        entry.probing = false;
      }
      return;
    }
    let name: string;
    try {
      name = basename(entry.pty.process ?? "").replace(/^-/, "");
    } catch {
      return;
    }
    if (name === entry.shell || name === "") {
      entry.probed = null;
      this.#setAgent(id, entry, null);
      return;
    }
    const now = Date.now();
    if (name === entry.probed && (entry.agent !== null || now - entry.probedSince >= TITLE_SETTLE_MS)) return;
    entry.probing = true;
    try {
      const agent = await this.#detect(entry.pty.pid);
      if (this.#terminals.get(id) !== entry) return;
      if (name !== entry.probed) entry.probedSince = now;
      entry.probed = name;
      this.#setAgent(id, entry, agent);
    } finally {
      entry.probing = false;
    }
  }

  #setAgent(id: string, entry: Entry, agent: string | null): void {
    if (entry.agent === agent) return;
    entry.agent = agent;
    this.events.onAgent?.(id, entry.session, agent);
  }

  /** Stop polling; a terminal that ends with an agent reports it gone. */
  #stopWatching(id: string, entry: Entry): void {
    clearInterval(entry.poll);
    this.#setAgent(id, entry, null);
  }

  /**
   * Output a view needs to show the terminal as it stands: its recent
   * output, from a fresh terminal's state (see {@link OutputRing.snapshot}).
   * Output still buffered is sent through `onData` first, so everything sent
   * before this returns is in the snapshot and everything after is not. Null
   * for a terminal never created or already killed; an exited shell's output
   * stays until its terminal is killed.
   */
  attach(id: string): string | null {
    this.#terminals.get(id)?.flush();
    return this.#output.get(id)?.snapshot() ?? null;
  }

  /** True while the terminal's shell runs. */
  has(id: string): boolean {
    return this.#terminals.has(id);
  }

  /** Send keystrokes or pasted text. Unknown ids are ignored: the shell may just have exited. */
  write(id: string, data: string): void {
    this.#terminals.get(id)?.pty.write(data);
  }

  /** TUIs (Claude Code, vim) redraw on SIGWINCH; keep the pty in sync with the visible grid. */
  resize(id: string, cols: number, rows: number): void {
    const entry = this.#terminals.get(id);
    if (!entry || cols < 2 || rows < 1) return;
    try {
      entry.pty.resize(Math.floor(cols), Math.floor(rows));
    } catch {
      // Racing an exit: the fd is already closed.
    }
  }

  /**
   * Close a terminal tab: kills its shell and everything in the foreground,
   * and forgets its output. The exit still reaches `onExit`.
   */
  kill(id: string): void {
    void this.#kill(id);
  }

  /**
   * Kill every terminal (the window closes) and settle once each shell has exited, or after
   * {@link EXIT_WAIT_MS}. The app must not exit before: on Windows node-pty kills a shell that has not
   * printed yet only once it prints, and an Electron exiting first hangs with the pseudoconsole open.
   */
  async killAll(): Promise<void> {
    const exits = [...this.#terminals.keys()].map((id) => this.#kill(id));
    this.#output.clear();
    this.#listed.clear();
    let timer: NodeJS.Timeout | undefined;
    const bound = new Promise<void>((resolve) => (timer = setTimeout(resolve, EXIT_WAIT_MS)));
    await Promise.race([Promise.all(exits), bound]);
    clearTimeout(timer);
  }

  /** Settles when the shell has exited; at once when unknown or already gone. An exited shell is not killed again. */
  #kill(id: string): Promise<void> {
    this.#output.delete(id);
    this.#listed.delete(id);
    const entry = this.#terminals.get(id);
    if (!entry) return Promise.resolve();
    this.#terminals.delete(id);
    clearTimeout(entry.timer);
    this.#stopWatching(id, entry);
    if (!processExists(entry.pty.pid)) return entry.exited;
    try {
      entry.pty.kill();
    } catch {
      // Already gone.
      return Promise.resolve();
    }
    if (process.platform !== "win32") {
      const pty = entry.pty;
      const force = setTimeout(() => {
        try {
          if (processExists(pty.pid)) pty.kill("SIGKILL");
        } catch {
          // Gone meanwhile.
        }
      }, KILL_GRACE_MS);
      void entry.exited.then(() => clearTimeout(force));
    }
    return entry.exited;
  }
}
