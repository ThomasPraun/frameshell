import type { EventParams, MethodParams, MethodResult, UiCommand, UiView } from "@frameshell/protocol";

type UiMethod = "ui.publish" | "ui.reply" | "ui.detach";

/** Options for {@link UiBridge}. */
export interface UiBridgeOptions {
  /** Daemon request, e.g. `DaemonLink.request`. */
  request<M extends UiMethod>(method: M, params: MethodParams<M>): Promise<MethodResult<M>>;
  /**
   * Hand `command` to window `view` if it still shows `project`; false when
   * it does not (closed, or another project opened since): the command then
   * fails at once instead of timing out.
   */
  deliver(view: string, project: string, message: { id: string; command: UiCommand }): boolean;
}

interface Published {
  cwd: string;
  state: UiView;
  /** A publish request is on its way; `dirty` = a newer state arrived meanwhile. */
  sending: boolean;
  dirty: boolean;
  /** Detached while a publish was in flight: detach once it lands, or the daemon would register the window again. */
  detached: boolean;
}

/**
 * Main-process end of SPEC §7b: forwards what each window shows to the
 * daemon (`ui.publish`) and routes the daemon's `ui.command` to the window,
 * whose answer goes back as `ui.reply`. At most one publish per window is in
 * flight, carrying the newest state: a playing preview reports far more often
 * than the socket needs. The last state is kept to register again after a
 * reconnect ({@link UiBridge.resync}). Windows are keyed by a stable id.
 */
export class UiBridge {
  readonly #options: UiBridgeOptions;
  readonly #windows = new Map<string, Published>();

  constructor(options: UiBridgeOptions) {
    this.#options = options;
  }

  /** Window `view` now shows `state` of the project at `cwd`. */
  publish(view: string, cwd: string, state: UiView): void {
    const known = this.#windows.get(view);
    if (known) Object.assign(known, { cwd, state, dirty: known.sending });
    else this.#windows.set(view, { cwd, state, sending: false, dirty: false, detached: false });
    if (!known?.sending) void this.#send(view);
  }

  /** Window `view` answers command `id`; `error` null when done. Best effort: the daemon times out otherwise. */
  reply(view: string, id: string, error: string | null, state: UiView): void {
    const known = this.#windows.get(view);
    if (known) known.state = state;
    void this.#options.request("ui.reply", { view, id, error, state }).catch(() => undefined);
  }

  /** Window `view` closed or stopped showing its project: `ui_state` must not report it any more. */
  detach(view: string): void {
    const known = this.#windows.get(view);
    if (!known) return;
    this.#windows.delete(view);
    if (known.sending) known.detached = true;
    else void this.#options.request("ui.detach", { view }).catch(() => undefined);
  }

  /** Daemon `ui.command`: to its window, or refused at once when that window is gone. */
  command({ view, project, id, command }: EventParams<"ui.command">): void {
    if (this.#options.deliver(view, project, { id, command })) return;
    const known = this.#windows.get(view);
    if (!known) return;
    this.reply(view, id, "The window that showed the project is closed or shows another project now.", known.state);
  }

  /** The daemon connection was re-established: register every window again. */
  resync(): void {
    for (const [view, known] of this.#windows) {
      if (known.sending) known.dirty = true;
      else void this.#send(view);
    }
  }

  async #send(view: string): Promise<void> {
    const known = this.#windows.get(view);
    if (!known) return;
    known.sending = true;
    known.dirty = false;
    try {
      await this.#options.request("ui.publish", { cwd: known.cwd, view, state: known.state });
    } catch {
      // Daemon unreachable or project gone: the next change or reconnect publishes again.
    }
    known.sending = false;
    // Shown again meanwhile (another project in the same window): that publish re-registers it, no detach.
    if (known.detached && !this.#windows.has(view)) void this.#options.request("ui.detach", { view }).catch(() => undefined);
    else if (known.dirty) void this.#send(view);
  }
}
