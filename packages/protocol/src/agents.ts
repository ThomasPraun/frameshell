// Agent labels (SPEC §6.2): which agent CLI (Claude Code, Codex, …) ran a terminal session's operations.
import { z } from "zod";

/** Pattern of an agent label: lowercase letters, digits, `.`, `_`, `-`; starts with a letter or digit; ≤ 32 chars. */
export const AGENT_LABEL_PATTERN = "[a-z0-9][a-z0-9._-]{0,31}";

/** An agent label, e.g. `claude`, `codex`, `gemini`. */
export const AgentLabelSchema = z
  .string()
  .regex(new RegExp(`^${AGENT_LABEL_PATTERN}$`), "must be lowercase letters, digits, `.`, `_` or `-`, at most 32")
  .describe("Agent CLI running in the terminal, as a short lowercase label, e.g. `claude`, `codex`, `gemini`.");

/**
 * Label for a free-form agent name (`FRAMESHELL_AGENT`, a process name):
 * lowercased, runs of other characters turned into `-`, trimmed, capped.
 * Null when nothing usable is left.
 */
export function agentLabel(name: string): string | null {
  const label = name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[._-]+/, "")
    .slice(0, 32)
    .replace(/-+$/, "");
  return label === "" ? null : label;
}

/**
 * Journal author of operations an agent ran from terminal `session`:
 * `agent:<label>:<session>`, or `agent:<label>` without a session.
 */
export function agentAuthor(label: string, session: string | null): string {
  return session ? `agent:${label}:${session}` : `agent:${label}`;
}
