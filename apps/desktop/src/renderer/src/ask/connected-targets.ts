import { useMemo } from "react";
import { useAgentTargets } from "./agent-targets.js";
import { targetName } from "./chat-targets.js";

/**
 * Display names of the agents outside the app connected to this project (ADR 0025 decisions 3 and 8),
 * for the status bar while the terminal panel is closed.
 */
export function useConnectedAgentTargets(): readonly string[] {
  const { targets } = useAgentTargets();
  return useMemo(() => targets.filter((target) => target.connections > 0).map(targetName), [targets]);
}
