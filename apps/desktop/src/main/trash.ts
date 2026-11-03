// Move to Trash from the Explorer: what may go, and what the confirm says. The daemon names the uses (`file.uses`).
import { relative, resolve, sep } from "node:path";
import type { MethodResult } from "@frameshell/protocol";
import type { Dict } from "../shared/i18n/index.js";

type Uses = MethodResult<"file.uses">["uses"];

/**
 * Why project-relative `rel` may not go to the Trash, or null when it may: the project itself, its
 * `frameshell.json`, daemon-owned `.frameshell/` (any letter case), and the main timeline `main` (`timelines/<id>.json`) or a folder holding it.
 */
export function trashRefusal(rel: string, main: string, said: Dict["app"]["dialogs"]): string | null {
  const first = rel.split("/")[0]!;
  if (rel === "" || rel === "." || first === "..") return said.trashOutside;
  if (rel === "frameshell.json" || first.toLowerCase() === ".frameshell") return said.trashProjectFile(rel);
  if (rel === main || main.startsWith(`${rel}/`)) return said.trashMainTimeline;
  return null;
}

/** Detail line of the confirm: what goes missing from which timelines, or how to get it back. */
export function trashDetail(uses: Uses, bin: string, said: Dict["app"]["dialogs"]): string {
  if (uses.length === 0) return said.trashRestore(bin);
  const timelines = [...new Set(uses.map((use) => use.timeline))];
  return `${said.trashUsed(uses.length, timelines.join(", "))} ${said.trashRestore(bin)}`;
}

/** Absolute path of project-relative `rel` under `dir`; throws when it leads outside the project or names it. */
export function projectPathOf(dir: string, rel: string): string {
  const path = resolve(dir, rel);
  const back = relative(dir, path);
  if (back === "" || back === ".." || back.startsWith(`..${sep}`) || resolve(dir, back) !== path) {
    throw new Error(`${rel} is not inside the project.`);
  }
  return path;
}
