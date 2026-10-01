import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import * as pty from "node-pty";
import { agentCommands, agentOfCommand, foregroundCommand } from "./agent-detect.js";
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
  /** Agent label of a shell's foreground command, or null. Default: `ps` + {@link agentOfCommand}; none on Windows. */
  detectAgent?: ((shellPid: number) => Promise<string | null>) | null;
  /** How often to look at each terminal's foreground, ms. */
  agentPollMs?: number;
}

/** Output is flushed at most this often: one IPC message per burst instead of per chunk. */
const FLUSH_MS = 5;
/** Agents take seconds before their first command: a second's lag in noticing one is harmless. */
const AGENT_POLL_MS = 1000;
/**
 * A foreground found not to be an agent is looked at again for this long: Node CLIs
 * (Claude Code, Codex, ...) show as `node` until they set their process title.
 */
const TITLE_SETTLE_MS = 5000;
/** Longest {@link TerminalManager.killAll} waits for shells to exit: quitting must not hang on one. */
const EXIT_WAIT_MS = 5000;

interface Entry {
  pty: pty.IPty;
  /** Settles when the shell has exited. */
  exited: Promise<void>;
  buffer: string;
  timer: NodeJS.Timeout | undefined;
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

/** Detection from `ps` on Unix; Windows has no foreground process groups to read. */
function defaultDetect(): ((shellPid: number) => Promise<string | null>) | null {
  if (process.platform === "win32") return null;
  const commands = agentCommands(process.env);
  return async (shellPid) => {
    const argv = await foregroundCommand(shellPid);
    return argv ? agentOfCommand(argv, commands) : null;
  };
}

/**
 * Real pseudo-terminals (node-pty; ConPTY on Windows) for one window.
 * Sessions die with the window in v0.1 (SPEC §3.2).
 */
export class TerminalManager {
  readonly #terminals = new Map<string, Entry>();
  readonly #detect: ((shellPid: number) => Promise<string | null>) | null;
  readonly #pollMs: number;

  constructor(
    private readonly events: TerminalEvents,
    options: TerminalManagerOptions = {},
  ) {
    this.#detect = options.detectAgent === undefined ? defaultDetect() : options.detectAgent;
    this.#pollMs = options.agentPollMs ?? AGENT_POLL_MS;
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
    const entry: Entry = {
      pty: proc,
      exited: new Promise((resolve) => (markExited = resolve)),
      buffer: "",
      timer: undefined,
      session: launch.env["FRAMESHELL_SESSION"] || null,
      shell,
      agent: null,
      probed: null,
      probedSince: 0,
      poll: undefined,
      probing: false,
    };
    const flush = () => {
      entry.timer = undefined;
      if (!entry.buffer) return;
      const data = entry.buffer;
      entry.buffer = "";
      this.events.onData(id, data);
    };
    proc.onData((data) => {
      entry.buffer += data;
      entry.timer ??= setTimeout(flush, FLUSH_MS);
    });
    proc.onExit(({ exitCode }) => {
      markExited();
      clearTimeout(entry.timer);
      flush();
      this.#terminals.delete(id);
      this.#stopWatching(id, entry);
      this.events.onExit(id, exitCode);
    });
    this.#terminals.set(id, entry);
    if (this.#detect) entry.poll = setInterval(() => void this.#watch(id, entry), this.#pollMs);
    return { id, shell };
  }

  /** Sessions whose terminal runs an agent now, with its label: to tag them again in a restarted daemon. */
  agents(): { session: string; agent: string }[] {
    return [...this.#terminals.values()].flatMap(({ session, agent }) => (session && agent ? [{ session, agent }] : []));
  }

  /** Look up the agent when the foreground changed, and while it settles; `ps` runs only then, not every poll. */
  async #watch(id: string, entry: Entry): Promise<void> {
    if (entry.probing || !this.#detect) return;
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

  /** Close a terminal tab: kills its shell and everything in the foreground. The exit still reaches `onExit`. */
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
    let timer: NodeJS.Timeout | undefined;
    const bound = new Promise<void>((resolve) => (timer = setTimeout(resolve, EXIT_WAIT_MS)));
    await Promise.race([Promise.all(exits), bound]);
    clearTimeout(timer);
  }

  /** Settles when the shell has exited; at once when unknown or already gone. */
  #kill(id: string): Promise<void> {
    const entry = this.#terminals.get(id);
    if (!entry) return Promise.resolve();
    this.#terminals.delete(id);
    clearTimeout(entry.timer);
    this.#stopWatching(id, entry);
    try {
      entry.pty.kill();
    } catch {
      // Already gone.
      return Promise.resolve();
    }
    return entry.exited;
  }
}
