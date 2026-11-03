/**
 * Display names of the agents connected to this project (ADR 0025 decision 3),
 * for the status bar while the terminal panel is closed.
 * Hook point for the agent-target registry (#429): until it lands no external agent registers, so the list is empty.
 */
export function useConnectedAgentTargets(): readonly string[] {
  return NO_TARGETS;
}

const NO_TARGETS: readonly string[] = [];
