import { parse as parseYaml } from "yaml";
import { z } from "zod";

/**
 * Scripts (`scripts/*.md`, SPEC §5.5, decision 14): plain Markdown with
 * optional conventions. Each level-2 ATX heading (`## Title`) is a scene; its
 * slug is the anchor clips use in `scriptRef` (`scripts/script.md#intro`);
 * a `scriptRef` without `#anchor` refers to the whole script.
 * Optional YAML frontmatter carries `title`, `target_duration`, `aspect`.
 * Parsing never fails: problems become `warnings`.
 */

/** One scene: a level-2 heading and the lines up to the next one. */
export const ScriptSceneSchema = z.object({
  title: z.string().describe("Heading text without `##` or closing hashes."),
  slug: z
    .string()
    .describe(
      "Anchor for `scriptRef` (`<script path>#<slug>`): GitHub-style, lowercase, unicode letters kept, punctuation dropped, " +
        "spaces to `-`; repeated headings get `-1`, `-2`…",
    ),
  line: z.int().describe("1-based file line of the heading (frontmatter lines count)."),
  endLine: z.int().describe("1-based last line of the scene: the line before the next scene heading, or the last line."),
  words: z.int().describe("Words in the scene body (heading excluded); rough voice-over length at ~2.5 words/s."),
});

/** Frontmatter conventions; each null when absent or invalid. */
export const ScriptMetaSchema = z.object({
  title: z.string().nullable().describe("Frontmatter `title`."),
  targetDuration: z
    .number()
    .nullable()
    .describe("Frontmatter `target_duration` in seconds (written as `60`, `\"90s\"`, `\"1:30\"` or `\"1m30s\"`)."),
  aspect: z.string().nullable().describe("Frontmatter `aspect`, e.g. `9:16`."),
});

/** See {@link ScriptSceneSchema}. */
export type ScriptScene = z.output<typeof ScriptSceneSchema>;
/** See {@link ScriptMetaSchema}. */
export type ScriptMeta = z.output<typeof ScriptMetaSchema>;

/** Result of {@link parseScript}. */
export interface ScriptOutline {
  meta: ScriptMeta;
  /** In file order. */
  scenes: ScriptScene[];
  /** Human-readable; bad frontmatter, duplicate headings. Empty when clean. */
  warnings: string[];
}

/** Slug of an unnamed scene (heading with no letters or digits). */
const UNNAMED = "scene";

/**
 * Parse a script. Only `##` ATX headings (up to 3 spaces of indentation,
 * outside fenced code) are scenes; setext headings are not.
 */
export function parseScript(text: string): ScriptOutline {
  const lines = (text.startsWith("\u{FEFF}") ? text.slice(1) : text).split(/\r?\n/);
  const warnings: string[] = [];
  const { meta, bodyStart } = readFrontmatter(lines, warnings);

  const headings: { title: string; base: string; line: number }[] = [];
  let fence: { char: string; length: number } | null = null;
  for (let index = bodyStart; index < lines.length; index++) {
    const line = lines[index]!;
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1]!;
      if (!fence) fence = { char: marker[0]!, length: marker.length };
      else if (marker[0] === fence.char && marker.length >= fence.length && line.trim() === marker) fence = null;
      continue;
    }
    if (fence) continue;
    const heading = /^ {0,3}##(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/.exec(line);
    if (!heading) continue;
    const title = (heading[1] ?? "").trim();
    headings.push({ title, base: scriptSlug(title) || UNNAMED, line: index + 1 });
  }

  const slugger = new Slugger();
  const scenes = headings.map((heading, i) => {
    const endLine = (headings[i + 1]?.line ?? lines.length + 1) - 1;
    const body = lines.slice(heading.line, endLine).join("\n");
    return { title: heading.title, slug: slugger.slug(heading.base), line: heading.line, endLine, words: countWords(body) };
  });

  const byBase = new Map<string, { title: string; slugs: string[] }>();
  headings.forEach((heading, i) => {
    const group = byBase.get(heading.base) ?? { title: heading.title, slugs: [] };
    group.slugs.push(scenes[i]!.slug);
    byBase.set(heading.base, group);
  });
  for (const { title, slugs } of byBase.values()) {
    if (slugs.length < 2) continue;
    warnings.push(
      `Heading "${title}" appears ${slugs.length} times; anchors ${slugs.join(", ")}. ` +
        "Give scenes distinct headings so scriptRefs do not shift when one is removed.",
    );
  }
  return { meta, scenes, warnings };
}

/**
 * GitHub-style heading anchor, without the duplicate suffix: NFC,
 * lowercase, anything but letters, marks, digits, `_`, `-` and spaces
 * dropped, each space turned into `-`. Empty when nothing is left.
 */
export function scriptSlug(heading: string): string {
  return heading
    .normalize("NFC")
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc}\- ]/gu, "")
    .replace(/ /g, "-");
}

/**
 * Split a `scriptRef` at its last `#` into a `/`-separated project-relative
 * path (leading `./` dropped) and an anchor; `anchor` is null when missing
 * or empty, meaning the whole script.
 */
export function splitScriptRef(ref: string): { path: string; anchor: string | null } {
  const hash = ref.lastIndexOf("#");
  const rawPath = hash === -1 ? ref : ref.slice(0, hash);
  const anchor = hash === -1 ? "" : ref.slice(hash + 1);
  const path = rawPath.replace(/\\/g, "/").replace(/^(?:\.\/)+/, "");
  return { path, anchor: anchor === "" ? null : anchor.normalize("NFC") };
}

/**
 * True for a script file: Markdown under `scripts/` (SPEC §4 layout), any
 * depth, extension in any letter case. Takes a project-relative,
 * `/`-separated path, e.g. a {@link splitScriptRef} path.
 */
export function isScriptPath(path: string): boolean {
  return /^scripts\/.+\.md$/i.test(path);
}

/**
 * Why a {@link splitScriptRef} path cannot name a file inside the project,
 * or null when it can. Rejects empty, absolute (`/x`, `//host/x`, `C:x`),
 * NUL, and any `..` segment: `scripts/../../x.md` escapes once joined.
 * Shape only; symlinks leaving the project are the reader's job.
 */
export function scriptRefPathProblem(path: string): string | null {
  if (path === "") return "has no script path";
  if (path.includes("\0")) return "contains a NUL character";
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path)) return "is absolute";
  if (path.split("/").includes("..")) return "leaves the project through `..`";
  return null;
}

/** github-slugger's disambiguation: `x`, `x-1`, `x-2`…, skipping slugs already taken. */
class Slugger {
  readonly #occurrences = new Map<string, number>();

  slug(base: string): string {
    let result = base;
    while (this.#occurrences.has(result)) {
      const count = this.#occurrences.get(base)! + 1;
      this.#occurrences.set(base, count);
      result = `${base}-${count}`;
    }
    this.#occurrences.set(result, 0);
    return result;
  }
}

function countWords(text: string): number {
  return text.match(/[\p{L}\p{N}][\p{L}\p{M}\p{N}'’_-]*/gu)?.length ?? 0;
}

function readFrontmatter(lines: string[], warnings: string[]): { meta: ScriptMeta; bodyStart: number } {
  const meta: ScriptMeta = { title: null, targetDuration: null, aspect: null };
  if (lines[0]?.trimEnd() !== "---") return { meta, bodyStart: 0 };
  const close = lines.findIndex((line, index) => index > 0 && /^(?:---|\.\.\.)\s*$/.test(line));
  if (close === -1) {
    warnings.push("The script starts with `---` but has no closing `---`: frontmatter ignored.");
    return { meta, bodyStart: 0 };
  }
  let data: unknown;
  try {
    data = parseYaml(lines.slice(1, close).join("\n"));
  } catch (error) {
    warnings.push(`Frontmatter is not valid YAML, ignored: ${(error as Error).message.split("\n")[0]}`);
    return { meta, bodyStart: close + 1 };
  }
  if (data === null || data === undefined) return { meta, bodyStart: close + 1 };
  if (typeof data !== "object" || Array.isArray(data)) {
    warnings.push("Frontmatter must be a YAML mapping (`key: value` lines): ignored.");
    return { meta, bodyStart: close + 1 };
  }
  const fields = data as Record<string, unknown>;
  if (fields["title"] !== undefined) {
    if (typeof fields["title"] === "string") meta.title = fields["title"];
    else warnings.push("Frontmatter `title` must be text: ignored.");
  }
  if (fields["target_duration"] !== undefined) {
    meta.targetDuration = parseDuration(fields["target_duration"]);
    if (meta.targetDuration === null) {
      warnings.push('Frontmatter `target_duration` must be seconds, e.g. `60`, `"90s"`, `"1:30"` or `"1m30s"`: ignored.');
    }
  }
  if (fields["aspect"] !== undefined) {
    const aspect = fields["aspect"];
    if (typeof aspect === "string" && /^\d+(?:\.\d+)?:\d+(?:\.\d+)?$/.test(aspect.trim())) meta.aspect = aspect.trim();
    else warnings.push('Frontmatter `aspect` must be `<width>:<height>`, e.g. `"9:16"`: ignored.');
  }
  return { meta, bodyStart: close + 1 };
}

/** Seconds from `60`, `"90s"`, `"2.5 s"`, `"1:30"` or `"1m30s"`; null when unreadable or not positive. */
function parseDuration(value: unknown): number | null {
  let seconds: number | null = null;
  if (typeof value === "number") seconds = value;
  else if (typeof value === "string") {
    const text = value.trim();
    const plain = /^(\d+(?:\.\d+)?)\s*s?$/.exec(text);
    const clock = /^(\d+):([0-5]?\d(?:\.\d+)?)$/.exec(text);
    const units = /^(\d+)\s*m(?:\s*(\d+(?:\.\d+)?)\s*s)?$/.exec(text);
    if (plain) seconds = Number(plain[1]);
    else if (clock) seconds = Number(clock[1]) * 60 + Number(clock[2]);
    else if (units) seconds = Number(units[1]) * 60 + Number(units[2] ?? 0);
  }
  return seconds !== null && Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}
