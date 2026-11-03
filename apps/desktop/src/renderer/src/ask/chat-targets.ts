// Who "Ask agent" reaches (ADR 0025 decision 3): agents in the app's terminals and agents outside it (MCP clients,
// `frameshell ask --wait`), as equals. Pure: the workspace feeds it the terminals and the daemon's targets.
import type { AgentTarget } from "@frameshell/protocol";

/** An app terminal running an agent, as the terminal panel reports it. */
export interface TerminalAgent {
  /** Tab key. */
  key: number;
  /** Menu label, e.g. `Terminal 2 (codex)`. */
  label: string;
}

/** One place a reference can go. */
export type ChatTarget =
  | { kind: "terminal"; id: string; key: number; label: string }
  | { kind: "external"; id: string; target: string; label: string };

/** Display name of an external target: the title its client gave (`Claude Code`), else its client name. */
export function targetName(target: AgentTarget): string {
  return target.title ?? target.client;
}

/**
 * Every target, app terminals first (most recently focused first, as the panel lists them), then connected external
 * targets by id. A target whose connections all closed is left out: references wait for it, but nobody reads now.
 */
export function chatTargets(
  terminals: readonly TerminalAgent[],
  externals: readonly AgentTarget[],
  /** Menu label of an external agent on this project, from its name, e.g. `Claude Code · launch`. */
  label: (name: string) => string,
): ChatTarget[] {
  return [
    ...terminals.map((terminal): ChatTarget => ({ kind: "terminal", id: `terminal:${terminal.key}`, key: terminal.key, label: terminal.label })),
    ...externals
      .filter((target) => target.connections > 0)
      .map((target): ChatTarget => ({ kind: "external", id: `agent:${target.id}`, target: target.id, label: label(targetName(target)) })),
  ];
}

/** Where Cmd/Ctrl+L sends: the target used last while it is still there, else the first. Null when there is none. */
export function shortcutTarget(targets: readonly ChatTarget[], last: string | null): ChatTarget | null {
  return targets.find((target) => target.id === last) ?? targets[0] ?? null;
}

/** External targets with references not read yet, for the status bar. */
export function pendingTargets(externals: readonly AgentTarget[]): { id: string; name: string; pending: number }[] {
  return externals.filter((target) => target.pending > 0).map((target) => ({ id: target.id, name: targetName(target), pending: target.pending }));
}

/** A reference sent to an external target: waiting until it reads, then read. */
export interface Delivery {
  target: string;
  name: string;
  read: boolean;
  /** `Date.now()` of the last change. */
  at: number;
}

/** The delivery after target `read` read its references (`target.changed`): read when it is the one waited for. */
export function deliveryAfterRead(delivery: Delivery | null, read: string | null, now: number): Delivery | null {
  if (!delivery || delivery.read || read === null || read !== delivery.target) return delivery;
  return { ...delivery, read: true, at: now };
}
