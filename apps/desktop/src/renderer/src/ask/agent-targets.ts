// The project's agent targets outside the app's terminals (ADR 0025) and what became of the last reference sent to one.
import { useSyncExternalStore } from "react";
import type { AgentTarget } from "@frameshell/protocol";
import { type Delivery, deliveryAfterRead } from "./chat-targets.js";

/** What the store holds. */
export interface AgentTargetsState {
  /** External targets of the window's project, as the daemon lists them. */
  targets: readonly AgentTarget[];
  /** The last reference sent to an external target; null before any. */
  delivery: Delivery | null;
  /** Id of the target "Chat about this" used last (a `ChatTarget` id), for Cmd/Ctrl+L. */
  last: string | null;
}

let state: AgentTargetsState = { targets: [], delivery: null, last: null };
const listeners = new Set<() => void>();
const set = (next: Partial<AgentTargetsState>) => {
  state = { ...state, ...next };
  for (const listener of listeners) listener();
};

/** One store per project window, shared by its detached panels (same renderer). */
export const agentTargets = {
  /** Follow the window's project: read the targets, then every `target.changed`. Returns the stop function. */
  start(): () => void {
    let stopped = false;
    const load = () =>
      void window.frameshell.agents.targets().then(
        (targets) => !stopped && set({ targets }),
        () => undefined,
      );
    const off = window.frameshell.agents.onTargets((change) => {
      if (!change) return load();
      set({ targets: change.targets, delivery: deliveryAfterRead(state.delivery, change.read, Date.now()) });
    });
    load();
    return () => {
      stopped = true;
      off();
      set({ targets: [], delivery: null });
    };
  },
  get: (): AgentTargetsState => state,
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  /** Remember `id` as the target used last. */
  use(id: string): void {
    if (state.last !== id) set({ last: id });
  },
  /** A reference went to external target `target` (`name` for the status bar); `read`: a waiting reader took it at once. */
  sent(target: string, name: string, read: boolean): void {
    set({ delivery: { target, name, read, at: Date.now() } });
  },
};

/** {@link agentTargets} as React state. */
export function useAgentTargets(): AgentTargetsState {
  return useSyncExternalStore(agentTargets.subscribe, agentTargets.get);
}
