// The brief of a video made from an idea (#472, #752): its prompt typed into the agent, and whether this viewer has
// used it. Used by Welcome (choices), AgentGuide, the timeline's and Plugins' empty states.
import { useEffect, useState } from "react";
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
    brief.about ?? "",
  );
}

/** The window's brief, read once from the project's `brief.md`: undefined while reading, null when there is none. */
let shared: Promise<IdeaBrief | null> | null = null;

/** The brief of this window's project (`brief.md`): undefined while it is read, null when not made from an idea. */
export function useIdea(): IdeaBrief | null | undefined {
  const [brief, setBrief] = useState<IdeaBrief | null | undefined>(undefined);
  useEffect(() => {
    let current = true;
    shared ??= window.frameshell.project.readIdea().catch(() => null);
    void shared.then((read) => {
      if (current) setBrief(read);
    });
    return () => {
      current = false;
    };
  }, []);
  return brief;
}

/** `localStorage` key of "this viewer used or put away the idea's prompt" in the project named `project`. */
function usedKey(project: string): string {
  return `frameshell.idea.used:${project}`;
}

/** Whether this viewer already used (typed or copied) or put away the prompt of the project's idea. */
export function ideaUsed(project: string): boolean {
  try {
    return localStorage.getItem(usedKey(project)) === "1";
  } catch {
    return false;
  }
}

/** Remember that the prompt was used (or offered again, with `used: false`). */
export function setIdeaUsed(project: string, used: boolean): void {
  try {
    localStorage.setItem(usedKey(project), used ? "1" : "0");
  } catch {
    // Storage blocked: the prompt is offered again next time.
  }
}
