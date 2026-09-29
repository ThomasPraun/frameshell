import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import * as pty from "node-pty";
import type { TerminalLaunch } from "./terminal-launch.js";

/** Where terminal output and exits go; main forwards them to the window's renderer. */
export interface TerminalEvents {
  onData(id: string, data: string): void;
  onExit(id: string, exitCode: number): void;
}

/** Output is flushed at most this often: one IPC message per burst instead of per chunk. */
const FLUSH_MS = 5;

/**
 * Real pseudo-terminals (node-pty; ConPTY on Windows) for one window.
 * Sessions die with the window in v0.1 (SPEC §3.2).
 */
export class TerminalManager {
  readonly #terminals = new Map<string, { pty: pty.IPty; buffer: string; timer: NodeJS.Timeout | undefined }>();

  constructor(private readonly events: TerminalEvents) {}

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
    const entry = { pty: proc, buffer: "", timer: undefined as NodeJS.Timeout | undefined };
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
      clearTimeout(entry.timer);
      flush();
      this.#terminals.delete(id);
      this.events.onExit(id, exitCode);
    });
    this.#terminals.set(id, entry);
    return { id, shell: basename(launch.file).replace(/\.exe$/i, "") };
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

  /** Close a terminal tab: kills its shell and everything in the foreground. */
  kill(id: string): void {
    const entry = this.#terminals.get(id);
    if (!entry) return;
    this.#terminals.delete(id);
    clearTimeout(entry.timer);
    try {
      entry.pty.kill();
    } catch {
      // Already gone.
    }
  }

  /** Kill every terminal, e.g. when the window closes. */
  killAll(): void {
    for (const id of [...this.#terminals.keys()]) this.kill(id);
  }
}
