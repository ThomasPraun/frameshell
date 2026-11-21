// Terminal tabs after a reload (ADR 0012): main keeps the window's shells across a reload of its page (a language
// change, Ctrl+R), and the terminal panel shows them again instead of starting new ones.
import type { TerminalInfo, TerminalSurvivor } from "../../shared/api.js";

/** A terminal tab as the panel keeps it. */
export interface RestoredTab {
  key: number;
  info: TerminalInfo;
  exitCode: number | null;
  detached: false;
  name: null;
}

/** One docked tab per surviving terminal, keyed 0.. in the order they were opened. */
export function restoredTabs(survivors: readonly TerminalSurvivor[]): RestoredTab[] {
  return survivors.map(({ id, session, shell, exitCode }, key) => ({ key, info: { id, session, shell }, exitCode, detached: false, name: null }));
}
