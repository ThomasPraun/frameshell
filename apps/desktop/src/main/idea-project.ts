// Planning and checking a project made from an idea, with no footage (#472): folder, formats, brief.
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { BUILTIN_FORMATS, BUILTIN_FORMAT_IDS } from "@frameshell/schema";
import type { IdeaBrief, IdeaProjectPlan } from "../shared/api.js";
import { projectName } from "./video-project.js";

/** Longest name kept for the folder; more is a paste mistake. */
const MAX_NAME = 120;

/** Folder for the project `name` in `parent`, numbered ("name (2)") when a file or folder of that name exists. */
export async function planIdeaProject(place: { parent: string; name: string }): Promise<IdeaProjectPlan> {
  const name = projectName(place.name.slice(0, MAX_NAME));
  for (let n = 1; ; n++) {
    const dir = join(place.parent, n === 1 ? name : `${name} (${n})`);
    if (!(await stat(dir).catch(() => null))) return { parent: place.parent, name, dir };
  }
}

/**
 * The brief cleaned up: name trimmed, formats kept in the order of the built-in list (the first becomes the
 * project's own size), the address normalised. Throws with a message for the person when no project can be made of it.
 */
export function checkIdea(raw: IdeaBrief): IdeaBrief {
  const name = raw.name.trim();
  if (name === "") throw new Error("Give the video a name.");
  const formats = BUILTIN_FORMAT_IDS.filter((id) => raw.formats.includes(id));
  if (formats.length === 0) throw new Error("Choose at least one format.");
  const seconds = raw.seconds;
  if (seconds !== null && !(Number.isFinite(seconds) && seconds > 0)) throw new Error("The length must be a positive number of seconds.");
  return { name, formats, seconds, url: checkUrl(raw.url) };
}

/** `raw` as an http(s) address, or null when empty; throws for anything else, so a typo never reaches an agent. */
function checkUrl(raw: string | null): string | null {
  const text = raw?.trim() ?? "";
  if (text === "") return null;
  const bad = new Error(`${text} is not a web address (https://…).`);
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw bad;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw bad;
  return url.href;
}

/** Canvas of the built-in format `id` that {@link checkIdea} accepted. */
export function formatSize(id: string): { width: number; height: number } {
  const size = BUILTIN_FORMATS[id];
  if (!size) throw new Error(`Unknown format ${id}.`);
  return { width: size.width, height: size.height };
}
