// Planning and checking a project made from an idea, with no footage: folder, formats, brief.
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { BUILTIN_FORMATS, BUILTIN_FORMAT_IDS } from "@frameshell/schema";
import type { IdeaBrief, IdeaProjectPlan } from "../shared/api.js";
import { projectName } from "./video-project.js";

/** Longest name kept for the folder; more is a paste mistake. */
const MAX_NAME = 120;

/**
 * Folder for the project `name` in `parent`, numbered ("name (2)") when a file or folder of that name exists.
 * `untitled`: the name when `name` has nothing a folder can be called, in the UI language.
 */
export async function planIdeaProject(place: { parent: string; name: string }, untitled?: string): Promise<IdeaProjectPlan> {
  const name = projectName(place.name.slice(0, MAX_NAME), untitled);
  for (let n = 1; ; n++) {
    const dir = join(place.parent, n === 1 ? name : `${name} (${n})`);
    if (!(await stat(dir).catch(() => null))) return { parent: place.parent, name, dir };
  }
}

/** What {@link checkIdea} says when a brief is refused, in the UI language. */
export interface IdeaMessages {
  ideaNeedName: string;
  ideaNeedFormat: string;
  ideaBadLength: string;
  ideaBadUrl: string;
}

const ENGLISH: IdeaMessages = {
  ideaNeedName: "Give the video a name.",
  ideaNeedFormat: "Choose at least one format.",
  ideaBadLength: "The length must be a positive number of seconds.",
  ideaBadUrl: "That is not a web address. It starts with https://",
};

/**
 * The brief cleaned up: name trimmed, formats kept in the order of the built-in list (the first becomes the
 * project's own size), the address normalised. Throws with a message for the person (`said`, the welcome screen's
 * own words) when no project can be made of it.
 */
export function checkIdea(raw: IdeaBrief, said: IdeaMessages = ENGLISH): IdeaBrief {
  const name = raw.name.trim();
  if (name === "") throw new Error(said.ideaNeedName);
  const formats = BUILTIN_FORMAT_IDS.filter((id) => raw.formats.includes(id));
  if (formats.length === 0) throw new Error(said.ideaNeedFormat);
  const seconds = raw.seconds;
  if (seconds !== null && !(Number.isFinite(seconds) && seconds > 0)) throw new Error(said.ideaBadLength);
  return { name, formats, seconds, url: checkUrl(raw.url, said) };
}

/** `raw` as an http(s) address, or null when empty; throws for anything else, so a typo never reaches an agent. */
function checkUrl(raw: string | null, said: IdeaMessages): string | null {
  const text = raw?.trim() ?? "";
  if (text === "") return null;
  const bad = new Error(said.ideaBadUrl);
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
