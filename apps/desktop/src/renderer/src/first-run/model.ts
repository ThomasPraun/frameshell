// The first-run checklist (#787): four steps from a new project to an exported video, each ticked from what the
// project already shows. Pure: the component feeds it what it reads.
import type { FileNode } from "../../../shared/api.js";

/** The steps, in the order the checklist lists them (the same four as "How it goes" on the welcome screen). */
export const FIRST_RUN_STEPS = ["connect", "footage", "cut", "export"] as const;

/** One step of the checklist. */
export type FirstRunStep = (typeof FIRST_RUN_STEPS)[number];

/** What the checklist reads from the project and the machine. */
export interface FirstRunFacts {
  /** An AI app is connected to Frameshell, or an agent outside the app registered as a target of this project. */
  aiConnected: boolean;
  /** Clips on the project's main timeline. */
  clips: number;
  /** Authors of the main timeline's transactions, oldest first. */
  authors: readonly string[];
  /** Project-relative paths of the project's files. */
  files: readonly string[];
}

/** Each step and whether it is done. */
export interface FirstRunState {
  steps: readonly { step: FirstRunStep; done: boolean }[];
  /** How many steps are done. */
  done: number;
}

/** Container extensions an export writes (`render` and the app's File > Export video…). */
const VIDEO = /\.(mp4|mov|webm|mkv|m4v|gif)$/i;

/** An author that is an agent or a terminal command (`agent:<label>:<session>`, `cli`, `cli:<session>`), not a person in the app. */
export function isAgentAuthor(author: string): boolean {
  return (
    author === "cli" || author.startsWith("cli:") || author.startsWith("agent:")
  );
}

/** An author that is the person: an edit in the app (`ui`) or by hand in a project file (`file`). */
export function isPersonAuthor(author: string): boolean {
  return author === "ui" || author === "file";
}

/** The steps as `facts` show them. Connecting counts as done once an agent made a change, whatever reads the settings. */
export function firstRunState(facts: FirstRunFacts): FirstRunState {
  const agentEdit = facts.authors.some(isAgentAuthor);
  const done: Record<FirstRunStep, boolean> = {
    connect: facts.aiConnected || agentEdit,
    footage: facts.clips > 0,
    cut: agentEdit && facts.authors.some(isPersonAuthor),
    export: facts.files.some(
      (path) => path.startsWith("exports/") && VIDEO.test(path),
    ),
  };
  const steps = FIRST_RUN_STEPS.map((step) => ({ step, done: done[step] }));
  return { steps, done: steps.filter((each) => each.done).length };
}

/** Every file path of `tree`, project-relative, depth first. */
export function filePaths(tree: readonly FileNode[]): string[] {
  return tree.flatMap((node) =>
    node.kind === "dir" ? filePaths(node.children) : [node.path],
  );
}

/** The `localStorage` key that remembers the checklist was closed (or finished) in the project at `dir`. */
export function firstRunKey(dir: string): string {
  return `frameshell.firstRun.closed:${dir}`;
}
