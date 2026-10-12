// Where "Ask agent" types (ADR 0012): a project's terminals may be docked or in windows of their own.

/** What the target rule needs of a terminal tab. */
export interface AskTab {
  key: number;
  /** Null while the tab's pty is still being created. */
  info: { id: string } | null;
  /** Null while its shell runs. */
  exitCode: number | null;
}

/**
 * The Ask agent target among `tabs`, live ones only: the most recently
 * focused tab running an agent (`agents` by terminal id), else the most
 * recently focused, else the `active` tab, else the first. `focusOrder` holds
 * tab keys, most recent last. Null when no shell runs.
 */
export function askTarget<T extends AskTab>(
  tabs: readonly T[],
  active: number,
  agents: ReadonlyMap<string, string>,
  focusOrder: readonly number[],
): T | null {
  const live = tabs.filter((tab) => tab.exitCode === null);
  const recent = [...focusOrder].reverse().flatMap((key) => live.filter((tab) => tab.key === key));
  return (
    recent.find((tab) => tab.info !== null && agents.has(tab.info.id)) ??
    recent[0] ??
    live.find((tab) => tab.key === active) ??
    live[0] ??
    null
  );
}
