import {
  ErrorCode,
  type EventParams,
  type MethodResult,
  RpcError,
  type UiCommand,
  type UiState,
  type UiView,
} from "@frameshell/protocol";

/** Where a window's navigation commands go: its daemon connection. */
export interface UiSink {
  /** Send one notification. Must not throw; a closed connection drops it. */
  notify(method: "ui.command", params: EventParams<"ui.command">): void;
}

/** Project a window registered for: hub key (canonical root), root as named, and the `cwd` it was resolved from. */
export interface UiProject {
  key: string;
  dir: string;
  cwd?: string;
}

/** Options for {@link UiBroker}. */
export interface UiBrokerOptions {
  /** How long a command waits for the app's `ui.reply`. Default {@link DEFAULT_UI_TIMEOUT_MS}. */
  timeoutMs?: number;
}

/** Long enough for a busy renderer (first paint of a large timeline), short enough for a model to retry. */
export const DEFAULT_UI_TIMEOUT_MS = 5_000;

interface Window {
  sink: UiSink;
  view: string;
  project: UiProject;
  state: UiView;
  updatedAt: Date;
  /** Order of the last publish: the newest window of a project gets its commands. */
  seq: number;
}

interface Pending {
  window: Window;
  command: UiCommand;
  resolve: (state: UiState) => void;
  reject: (error: RpcError) => void;
  timer: NodeJS.Timeout;
}

/**
 * Daemon side of SPEC §7b UI state and navigation. App windows publish what
 * they show per project; `ui.state` answers from the newest one; navigation
 * commands go to it as `ui.command` notifications and resolve with the state
 * it replies. The only broker between MCP and the app: neither talks to the
 * other directly.
 */
export class UiBroker {
  readonly #timeoutMs: number;
  /** Windows by sink, then window id: one connection (the app's main process) serves several windows. */
  readonly #windows = new Map<UiSink, Map<string, Window>>();
  readonly #pending = new Map<string, Pending>();
  #seq = 0;
  #ids = 0;

  constructor(options: UiBrokerOptions = {}) {
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_UI_TIMEOUT_MS;
  }

  /** Project window `view` of `sink` registered for; undefined before its first publish. */
  registered(sink: UiSink, view: string): UiProject | undefined {
    return this.#windows.get(sink)?.get(view)?.project;
  }

  /** Record what window `view` of `sink` shows for `project`; it becomes the project's newest window. */
  publish(sink: UiSink, view: string, project: UiProject, state: UiView): void {
    let views = this.#windows.get(sink);
    if (!views) this.#windows.set(sink, (views = new Map()));
    const update = { project, state, updatedAt: new Date(), seq: ++this.#seq };
    // Updated in place: a pending command keeps pointing at its window.
    const window = views.get(view);
    if (window) Object.assign(window, update);
    else views.set(view, { sink, view, ...update });
  }

  /** `ui.state` of the project keyed `key`. */
  state(key: string): MethodResult<"ui.state"> {
    const window = this.#newest(key);
    return window ? { connected: true, ...snapshot(window) } : { connected: false };
  }

  /**
   * Send `command` to the project's newest window and resolve with its state
   * after it. Rejects with `UiNotConnected` (no window, or it went away) or
   * `UiCommandFailed` (refused, or no reply within the timeout).
   */
  command(key: string, command: UiCommand): Promise<UiState> {
    const window = this.#newest(key);
    if (!window) return Promise.reject(notConnected(key));
    const id = `u_${++this.#ids}`;
    return new Promise<UiState>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(failed(command, `the app did not answer within ${this.#timeoutMs / 1000} s`));
      }, this.#timeoutMs);
      timer.unref?.();
      this.#pending.set(id, { window, command, resolve, reject, timer });
      window.sink.notify("ui.command", { project: window.project.dir, view: window.view, id, command });
    });
  }

  /** Window `view` of `sink` answered command `id`; `state` is what it shows now. Stale ids are ignored. */
  reply(sink: UiSink, view: string, id: string, error: string | null, state: UiView): void {
    const window = this.#windows.get(sink)?.get(view);
    if (!window) return;
    Object.assign(window, { state, updatedAt: new Date() });
    const pending = this.#pending.get(id);
    if (pending?.window !== window) return;
    this.#settle(id, pending);
    if (error === null) pending.resolve(snapshot(window));
    else pending.reject(failed(pending.command, error));
  }

  /** Window `view` of `sink` no longer shows a project. */
  detach(sink: UiSink, view: string): void {
    const views = this.#windows.get(sink);
    const window = views?.get(view);
    if (!window) return;
    views!.delete(view);
    this.#abandon(window);
  }

  /** Forget every window of a closed connection. */
  drop(sink: UiSink): void {
    const views = this.#windows.get(sink);
    if (!views) return;
    this.#windows.delete(sink);
    for (const window of views.values()) this.#abandon(window);
  }

  #newest(key: string): Window | undefined {
    let newest: Window | undefined;
    for (const views of this.#windows.values()) {
      for (const window of views.values()) {
        if (window.project.key === key && (!newest || window.seq > newest.seq)) newest = window;
      }
    }
    return newest;
  }

  /** Commands a gone window can no longer answer fail at once, not at the timeout. */
  #abandon(window: Window): void {
    for (const [id, pending] of this.#pending) {
      if (pending.window !== window) continue;
      this.#settle(id, pending);
      pending.reject(notConnected(window.project.dir));
    }
  }

  #settle(id: string, pending: Pending): void {
    clearTimeout(pending.timer);
    this.#pending.delete(id);
  }
}

function snapshot(window: Window): UiState {
  return { ...window.state, project: window.project.dir, updatedAt: window.updatedAt.toISOString() };
}

function notConnected(project: string): RpcError {
  return new RpcError(ErrorCode.UiNotConnected, `No Frameshell app window shows ${project}.`, {
    project,
    hint: "Ask the user to open the project in the Frameshell app (`--project <dir>` or File > Open Folder), then retry.",
  });
}

function failed(command: UiCommand, reason: string): RpcError {
  return new RpcError(ErrorCode.UiCommandFailed, `The app could not ${command.kind}: ${reason}`, { command: command.kind, reason });
}
