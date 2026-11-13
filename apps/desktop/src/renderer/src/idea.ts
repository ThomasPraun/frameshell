// The brief of a video made from an idea (#472) as the prompt typed into the agent; used by Welcome (choices) and AgentGuide.
import type { IdeaBrief } from "../../shared/api.js";
import { t } from "./i18n.js";

/** Rough lengths the Welcome form offers, in seconds. */
export const IDEA_LENGTHS: readonly number[] = [15, 30, 60, 90, 180, 300];

/** The prompt that asks an agent for a motion film from `brief`, in the UI language. */
export function ideaPrompt(brief: IdeaBrief): string {
  return t.agents.idea.prompt(
    brief.name,
    brief.formats.map((id) => t.welcome.formatLabels[id] ?? id).join(", "),
    brief.seconds === null ? "" : t.welcome.durationLabel(brief.seconds),
    brief.url ?? "",
  );
}
