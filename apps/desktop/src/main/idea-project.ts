// Planning and checking a project made from an idea, with no footage: folder, formats, brief.
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { BUILTIN_FORMATS, BUILTIN_FORMAT_IDS } from "@frameshell/schema";
import type { IdeaBrief, IdeaProjectPlan } from "../shared/api.js";
import { withScheme } from "../shared/web-address.js";
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
 * The brief cleaned up: name trimmed, the main format (the first given, which becomes the project's own size) first
 * and the others in the order of the built-in list, the address normalised. Throws with a message for the person (`said`, the welcome screen's
 * own words) when no project can be made of it.
 */
export function checkIdea(raw: IdeaBrief, said: IdeaMessages = ENGLISH): IdeaBrief {
  const name = raw.name.trim();
  if (name === "") throw new Error(said.ideaNeedName);
  const given = BUILTIN_FORMAT_IDS.filter((id) => raw.formats.includes(id));
  const main = given.find((id) => id === raw.formats[0]) ?? given[0];
  const formats = main === undefined ? [] : [main, ...given.filter((id) => id !== main)];
  if (formats.length === 0) throw new Error(said.ideaNeedFormat);
  const seconds = raw.seconds;
  if (seconds !== null && !(Number.isFinite(seconds) && seconds > 0)) throw new Error(said.ideaBadLength);
  const about = (raw.about ?? "").trim().slice(0, MAX_ABOUT);
  return { name, formats, seconds, url: checkUrl(raw.url, said), about: about === "" ? null : about };
}

/** Longest "what is it about" kept, in characters: a paragraph or two, not a script. */
export const MAX_ABOUT = 2000;

/** Where a project made from an idea keeps its brief: the agent reads it, and the app's prompt is built from it. */
export const BRIEF_FILE = "brief.md";

/** Opening line of {@link BRIEF_FILE}: the brief as JSON, read back by {@link parseBrief}. */
const BRIEF_MARK = "<!-- frameshell-brief ";

/**
 * {@link BRIEF_FILE} for `brief`: its fields as JSON in a first-line comment (what {@link parseBrief} reads), then
 * the same in words for the person and the agent. English, like every file the agent reads.
 */
export function briefMarkdown(brief: IdeaBrief): string {
  const data = { name: brief.name, formats: brief.formats, seconds: brief.seconds, url: brief.url, about: brief.about ?? null };
  // `--` cannot end the comment early: JSON escapes it as `-\u002d`.
  const json = JSON.stringify(data).replaceAll("--", "-\\u002d");
  const [main, ...others] = brief.formats;
  return [
    `${BRIEF_MARK}${json} -->`,
    `# ${brief.name}`,
    "",
    "The brief of a video made from an idea in the Frameshell app, with no footage. Edit it freely: the app reads the comment above.",
    "",
    ...(brief.about ? ["## What it is about", "", brief.about, ""] : []),
    `- Formats: ${main ?? ""} (main)${others.length > 0 ? `, ${others.join(", ")}` : ""}`,
    ...(brief.seconds !== null ? [`- Length: about ${brief.seconds} seconds`] : []),
    ...(brief.url ? [`- Start from: ${brief.url}`] : []),
    "",
  ].join("\n");
}

/** The brief {@link briefMarkdown} wrote, from the file's text; null when the comment is missing or not a brief. */
export function parseBrief(text: string): IdeaBrief | null {
  const first = text.split(/\r?\n/, 1)[0] ?? "";
  if (!first.startsWith(BRIEF_MARK) || !first.trimEnd().endsWith("-->")) return null;
  try {
    const data = JSON.parse(first.slice(BRIEF_MARK.length, first.trimEnd().length - 3)) as Record<string, unknown>;
    const strings = (value: unknown) => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);
    const text = (value: unknown) => (typeof value === "string" && value !== "" ? value : null);
    const name = text(data["name"]);
    const formats = BUILTIN_FORMAT_IDS.filter((id) => strings(data["formats"]).includes(id));
    if (name === null || formats.length === 0) return null;
    // The main format stays first, as written.
    const main = strings(data["formats"]).find((id) => formats.includes(id))!;
    const seconds = typeof data["seconds"] === "number" && data["seconds"] > 0 ? data["seconds"] : null;
    return { name, formats: [main, ...formats.filter((id) => id !== main)], seconds, url: text(data["url"]), about: text(data["about"]) };
  } catch {
    return null;
  }
}

/**
 * `raw` as an http(s) address, or null when empty; a bare host (`www.example.com/a`) gets `https://` (#752). Throws
 * for anything else, so a typo never reaches an agent.
 */
function checkUrl(raw: string | null, said: IdeaMessages): string | null {
  const given = raw?.trim() ?? "";
  if (given === "") return null;
  const text = withScheme(given);
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
