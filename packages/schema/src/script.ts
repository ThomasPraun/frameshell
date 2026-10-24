import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { personNameKey } from "./people.js";
import { WordIdSchema } from "./transcript.js";

/**
 * Scripts (`scripts/*.md`, SPEC §5.5, decision 14): plain Markdown with
 * optional conventions. Each level-2 ATX heading (`## Title`) is a scene; its
 * slug is the anchor clips use in `scriptRef` (`scripts/script.md#intro`);
 * a `scriptRef` without `#anchor` refers to the whole script.
 * Optional YAML frontmatter carries `title`, `target_duration`, `aspect`.
 * A scene may name the transcript words it covers with an HTML comment right
 * under its heading, `<!-- words: talk.words.json w_000010..w_000042 -->`
 * (ADR 0015); the transcript file may be left out when one transcript holds the ids.
 * Parsing never fails: problems become `warnings`.
 */

/** Transcript words a scene covers: first and last word id, inclusive, in transcript order. */
export const ScriptWordRangeSchema = z.object({
  transcript: z
    .string()
    .nullable()
    .describe("Transcript file the ids belong to (`talk.words.json`, under `transcripts/`); null when the comment does not name one. Word ids repeat across transcripts."),
  from: WordIdSchema.describe("First word id."),
  to: WordIdSchema.describe("Last word id; equal to `from` for a single word."),
});

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
  words: z.int().describe("Words in the scene body (heading and `words` comment excluded); rough voice-over length at ~2.5 words/s."),
  wordRange: ScriptWordRangeSchema.nullable().describe(
    "Transcript words the scene covers, from a `<!-- words: talk.words.json w_000010..w_000042 -->` comment under the heading; null when absent or malformed.",
  ),
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

/** See {@link ScriptWordRangeSchema}. */
export type ScriptWordRange = z.output<typeof ScriptWordRangeSchema>;
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

/** How takes are compared against a shoot script (ADR 0023). */
export const ShootFollowSchema = z
  .enum(["words", "topics"])
  .describe("`words`: every spoken word is compared. `topics`: a line counts as covered when enough of its content words are said, in any order.");

/** A bracketed mark in a shoot line, never spoken (ADR 0023). */
export const ShootCueSchema = z.object({
  label: z.string().describe("Text before the first `:` inside the brackets (`VISUAL` in `[VISUAL: close-up]`), or all of it (`[PAUSE]`)."),
  text: z.string().nullable().describe("Text after the `:`; null for `[LABEL]`."),
  at: z.int().describe("Index in the line's `words` the cue sits before; equal to the number of words when it closes the line."),
  free: z.boolean().describe("`[FREE: …]`: unscripted speech the take must contain, checked only for presence and length."),
});

/** One line of a shoot script: a non-blank text line, who says it, its spoken words and its cues. */
export const ShootLineSchema = z.object({
  line: z.int().describe("1-based file line."),
  speaker: z.string().nullable().describe("Name from the last `**Name:**`, as written; null when the script names nobody before this line."),
  text: z.string().describe("What is said: the line without the speaker name, cues, comments and Markdown marks."),
  words: z.array(z.string()).describe("Spoken words of `text`, in order; empty for a line of cues only."),
  cues: z.array(ShootCueSchema).describe("Cues in the line, in order."),
});

/** One scene of a shoot script. */
export const ShootSceneSchema = z.object({
  title: z.string().describe("Heading text without `##` and without its timing."),
  slug: z.string().describe("Same anchor as in `script.outline`."),
  line: z.int().describe("1-based file line of the heading."),
  endLine: z.int().describe("1-based last line of the scene."),
  expected: z.number().nullable().describe("Expected length in seconds, from a heading timing like `(0:05–0:40)`; null without one."),
  words: z.int().describe("Spoken words of all its lines."),
  lines: z.array(ShootLineSchema).describe("In file order."),
});

/** Shoot conventions from the frontmatter (ADR 0023). */
export const ShootMetaSchema = z.object({
  shoot: z.boolean().describe("Frontmatter `shoot: true`: the shoot conventions apply."),
  source: z.string().nullable().describe("Frontmatter `source`: the person's own script this one was written from (project-relative or absolute); never written."),
  sourceHash: z.string().nullable().describe("Frontmatter `source_hash`: first 12 hex digits of the source's SHA-256 when this script was written."),
  follow: ShootFollowSchema,
});

/** See {@link ShootCueSchema}. */
export type ShootCue = z.output<typeof ShootCueSchema>;
/** See {@link ShootLineSchema}. */
export type ShootLine = z.output<typeof ShootLineSchema>;
/** See {@link ShootSceneSchema}. */
export type ShootScene = z.output<typeof ShootSceneSchema>;
/** See {@link ShootMetaSchema}. */
export type ShootMeta = z.output<typeof ShootMetaSchema>;

/** Result of {@link parseShootScript}. */
export interface ShootScript {
  meta: ScriptMeta;
  shoot: ShootMeta;
  /** In file order, with the same slugs as {@link parseScript}. */
  scenes: ShootScene[];
  /** Speaker names in order of first use; the first spelling of names equal ignoring case. */
  speakers: string[];
  /** {@link ScriptOutline.warnings} plus shoot convention problems. Empty when clean. */
  warnings: string[];
}

/** Slug of an unnamed scene (heading with no letters or digits). */
const UNNAMED = "scene";

/**
 * Parse a script. Only `##` ATX headings (up to 3 spaces of indentation,
 * outside fenced code) are scenes; setext headings are not. In a shoot
 * script (`shoot: true`) a closing timing, `## Hook (0:00–0:05)`, is left out
 * of the title and slug, so retiming a scene keeps its `scriptRef`.
 */
export function parseScript(text: string): ScriptOutline {
  return scanScript(text).outline;
}

/** Everything {@link parseScript} and {@link parseShootScript} share. */
interface ScriptScan {
  outline: ScriptOutline;
  lines: string[];
  /** Frontmatter mapping; null when absent or unreadable. */
  fields: Record<string, unknown> | null;
  bodyStart: number;
  /** Per scene: seconds from a closing heading timing (shoot scripts only), or null. */
  expected: (number | null)[];
  /** Per file line (0-based): inside a fenced block, fence lines included. */
  fenced: boolean[];
}

function scanScript(text: string): ScriptScan {
  const lines = (text.startsWith("\u{FEFF}") ? text.slice(1) : text).split(/\r?\n/);
  const warnings: string[] = [];
  const { meta, bodyStart, fields } = readFrontmatter(lines, warnings);
  const shoot = fields?.["shoot"] === true;

  const headings: { title: string; base: string; line: number; expected: number | null }[] = [];
  const fenced = lines.map(() => false);
  let fence: { char: string; length: number } | null = null;
  for (let index = bodyStart; index < lines.length; index++) {
    const line = lines[index]!;
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fenceMatch) {
      fenced[index] = true;
      const marker = fenceMatch[1]!;
      if (!fence) fence = { char: marker[0]!, length: marker.length };
      else if (marker[0] === fence.char && marker.length >= fence.length && line.trim() === marker) fence = null;
      continue;
    }
    if (fence) {
      fenced[index] = true;
      continue;
    }
    const heading = /^ {0,3}##(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/.exec(line);
    if (!heading) continue;
    let title = (heading[1] ?? "").trim();
    let expected: number | null = null;
    const timing = shoot ? readTiming(title) : null;
    if (timing) {
      title = timing.title;
      expected = timing.seconds;
      if (expected === null) warnings.push(`Line ${index + 1}: heading timing ends before it starts; expected length ignored.`);
    }
    headings.push({ title, base: scriptSlug(title) || UNNAMED, line: index + 1, expected });
  }

  const slugger = new Slugger();
  const scenes: ScriptScene[] = headings.map((heading, i) => {
    const endLine = (headings[i + 1]?.line ?? lines.length + 1) - 1;
    const bodyLines = lines.slice(heading.line, endLine);
    const slug = slugger.slug(heading.base);
    const { wordRange, commentIndex } = readWordsComment(bodyLines, slug, warnings);
    if (commentIndex !== -1) bodyLines.splice(commentIndex, 1);
    return { title: heading.title, slug, line: heading.line, endLine, words: countWords(bodyLines.join("\n")), wordRange };
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
  return { outline: { meta, scenes, warnings }, lines, fields, bodyStart, expected: headings.map((heading) => heading.expected), fenced };
}

/**
 * Parse a shoot script (ADR 0023): {@link parseScript} plus, per scene, its
 * lines. Each non-blank text line is one line; `**Name:**` at its start
 * names the speaker until the next name; `[LABEL: text]` / `[LABEL]` are
 * cues; Markdown links keep their text. Headings, thematic breaks, HTML
 * comments and fenced code are not spoken. Never fails: problems are warnings.
 * Works without `shoot: true` too, with a warning, so a draft can be checked.
 */
export function parseShootScript(text: string): ShootScript {
  const { outline, lines, fields, bodyStart, expected, fenced } = scanScript(text);
  const warnings = [...outline.warnings];
  const shoot = readShootMeta(fields, warnings);

  const firstScene = outline.scenes[0]?.line ?? lines.length + 1;
  for (let index = bodyStart; index < firstScene - 1; index++) {
    if (!fenced[index] && readLine(lines[index]!) !== null) {
      warnings.push(`Line ${index + 1}: text before the first \`## \` heading is in no scene and is not compared.`);
      break;
    }
  }
  if (outline.scenes.length === 0) warnings.push("No scenes: start each scene with a `## ` heading.");

  const speakers = new Map<string, string>();
  let speaker: string | null = null;
  const unnamed: number[] = [];
  const scenes: ShootScene[] = outline.scenes.map((scene, sceneIndex) => {
    const sceneLines: ShootLine[] = [];
    for (let index = scene.line; index < scene.endLine; index++) {
      if (fenced[index]) continue;
      const read = readLine(lines[index]!);
      if (read === null) continue;
      if (read.speaker !== null) {
        speaker = read.speaker;
        const key = personNameKey(speaker);
        if (!speakers.has(key)) speakers.set(key, speaker);
      }
      if (read.words.length === 0 && read.cues.length === 0) continue;
      if (speaker === null && read.words.length > 0) unnamed.push(index + 1);
      for (const placeholder of read.placeholders) {
        warnings.push(`Line ${index + 1}: placeholder ${placeholder} is still in the script; write what is said, or turn it into a cue.`);
      }
      sceneLines.push({ line: index + 1, speaker, text: read.text, words: read.words, cues: read.cues });
    }
    const words = sceneLines.reduce((total, line) => total + line.words.length, 0);
    if (words === 0 && !sceneLines.some((line) => line.cues.some((cue) => cue.free))) {
      warnings.push(`Scene "${scene.slug}" has nothing to say: no spoken words and no \`[FREE: …]\` slot.`);
    }
    return { title: scene.title, slug: scene.slug, line: scene.line, endLine: scene.endLine, expected: expected[sceneIndex] ?? null, words, lines: sceneLines };
  });
  if (speakers.size > 0 && unnamed.length > 0) {
    warnings.push(`Line${unnamed.length === 1 ? "" : "s"} ${unnamed.join(", ")} come${unnamed.length === 1 ? "s" : ""} before any \`**Name:**\` and ${unnamed.length === 1 ? "has" : "have"} no speaker.`);
  }
  return { meta: outline.meta, shoot, scenes, speakers: [...speakers.values()], warnings };
}

function readShootMeta(fields: Record<string, unknown> | null, warnings: string[]): ShootMeta {
  const meta: ShootMeta = { shoot: false, source: null, sourceHash: null, follow: "words" };
  const value = (key: string) => fields?.[key];
  if (value("shoot") === true) meta.shoot = true;
  else if (value("shoot") === undefined) warnings.push("Not a shoot script: add `shoot: true` to the frontmatter.");
  else warnings.push("Frontmatter `shoot` must be `true`: the shoot conventions do not apply.");
  const follow = value("follow");
  if (follow === "words" || follow === "topics") meta.follow = follow;
  else if (follow !== undefined) warnings.push("Frontmatter `follow` must be `words` or `topics`: `words` used.");
  const source = value("source");
  if (typeof source === "string" && source.trim() !== "") meta.source = source.trim();
  else if (source !== undefined) warnings.push("Frontmatter `source` must be a file path: ignored.");
  const hash = value("source_hash");
  if (typeof hash === "string" && /^[0-9a-f]{12}$/i.test(hash.trim())) meta.sourceHash = hash.trim().toLowerCase();
  else if (hash !== undefined) warnings.push("Frontmatter `source_hash` must be 12 hex digits (the start of the source's SHA-256): ignored.");
  if (meta.source !== null && meta.sourceHash === null) {
    warnings.push("Frontmatter `source` has no `source_hash`: a changed original cannot be noticed. Add the first 12 hex digits of its SHA-256.");
  }
  if (meta.source === null && meta.sourceHash !== null) warnings.push("Frontmatter `source_hash` without `source`: nothing to compare it with.");
  return meta;
}

/** Cue label of unscripted speech. */
const FREE_LABEL = "free";
/** Cue label of something still to be written. */
const TODO_LABEL = "todo";

/** One body line read as a shoot line; null for lines that are never spoken (blank, heading, rule, comment). */
function readLine(raw: string): { speaker: string | null; text: string; words: string[]; cues: ShootCue[]; placeholders: string[] } | null {
  let line = raw.replace(/<!--.*?(?:-->|$)/g, " ").trim();
  if (line === "" || /^#{1,6}(?:\s|$)/.test(line) || /^(?:[-*_]\s*){3,}$/.test(line)) return null;
  line = line.replace(/^(?:>\s?)+/, "").replace(/^(?:[-*+]|\d+[.)])\s+/, "");
  let speaker: string | null = null;
  const name = /^\*\*([^*]+?)\s*:\s*\*\*\s*|^\*\*([^*]+?)\s*\*\*\s*:\s*/.exec(line);
  if (name) {
    speaker = (name[1] ?? name[2]!).trim();
    line = line.slice(name[0].length);
  }
  line = line.replace(/!\[[^\]]*\]\([^)]*\)/g, " ").replace(/\[([^[\]]*)\]\([^)]*\)/g, "$1");

  const cues: ShootCue[] = [];
  const placeholders: string[] = [];
  const spoken: string[] = [];
  let words: string[] = [];
  let rest = 0;
  const say = (segment: string) => {
    for (const placeholder of segment.match(/<[^<>]+>|\{\{[^{}]*\}\}/g) ?? []) placeholders.push(placeholder);
    const clean = segment.replace(/[*_`~]+/g, "").replace(/\s+/g, " ").trim();
    if (clean === "") return;
    spoken.push(clean);
    words = words.concat(clean.match(WORD) ?? []);
  };
  for (const cue of line.matchAll(/\[([^[\]]*)\]/g)) {
    say(line.slice(rest, cue.index));
    rest = cue.index + cue[0].length;
    const body = cue[1]!.trim();
    if (body === "") continue;
    const colon = body.indexOf(":");
    const label = (colon === -1 ? body : body.slice(0, colon)).trim();
    const text = colon === -1 ? null : body.slice(colon + 1).trim() || null;
    const key = label.toLowerCase();
    if (key === TODO_LABEL) placeholders.push(cue[0]);
    cues.push({ label, text, at: words.length, free: key === FREE_LABEL });
  }
  say(line.slice(rest));
  return { speaker, text: spoken.join(" "), words, cues, placeholders };
}

/** Heading timing like `(0:05–0:40)`: `m:ss` or `h:mm:ss`, joined by `–`, `—` or `-`. */
const TIMING = /^(.*?)\s*\(\s*((?:\d+:)?\d{1,2}:\d{2}(?:\.\d+)?)\s*[–—-]\s*((?:\d+:)?\d{1,2}:\d{2}(?:\.\d+)?)\s*\)$/;

/** A heading's closing timing: the title without it, and its length (null when it ends before it starts). */
function readTiming(heading: string): { title: string; seconds: number | null } | null {
  const match = TIMING.exec(heading);
  if (!match) return null;
  const clock = (value: string) => value.split(":").reduce((total, part) => total * 60 + Number(part), 0);
  const seconds = clock(match[3]!) - clock(match[2]!);
  return { title: match[1]!, seconds: seconds > 0 ? Math.round(seconds * 1000) / 1000 : null };
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

/**
 * The `<!-- words: a..b -->` comment on the first non-blank line under a
 * heading. Malformed ones warn and give no range; `commentIndex` is its line
 * in `body`, or -1.
 */
function readWordsComment(body: string[], slug: string, warnings: string[]): { wordRange: ScriptWordRange | null; commentIndex: number } {
  const commentIndex = body.findIndex((line) => line.trim() !== "");
  const none = { wordRange: null, commentIndex: -1 };
  if (commentIndex === -1) return none;
  const comment = /^\s*<!--\s*words\s*:(.*?)-->\s*$/i.exec(body[commentIndex]!);
  if (!comment) return /^\s*<!--\s*words\b/i.test(body[commentIndex]!) ? malformed() : none;
  const range = /^\s*(?:([^\s<>]+)\s+)?(w_\d{6,})(?:\s*\.\.\s*(w_\d{6,}))?\s*$/.exec(comment[1]!);
  if (!range || (range[1] !== undefined && /^w_\d/.test(range[1]))) return malformed();
  return { wordRange: { transcript: range[1] ?? null, from: range[2]!, to: range[3] ?? range[2]! }, commentIndex };

  function malformed() {
    warnings.push(`Scene "${slug}": malformed words comment; write \`<!-- words: w_000010..w_000042 -->\` on one line. Ignored.`);
    return { wordRange: null, commentIndex };
  }
}

/**
 * A spoken word: a letter or digit, then letters, marks, digits, apostrophes, `_` and `-`. A number keeps
 * its separators (`1.500`, `1,5`), so it is said as one number.
 */
const WORD = /\p{N}+(?:[.,]\p{N}+)+|[\p{L}\p{N}][\p{L}\p{M}\p{N}'’_-]*/gu;

function countWords(text: string): number {
  return text.match(WORD)?.length ?? 0;
}

function readFrontmatter(lines: string[], warnings: string[]): { meta: ScriptMeta; bodyStart: number; fields: Record<string, unknown> | null } {
  const meta: ScriptMeta = { title: null, targetDuration: null, aspect: null };
  if (lines[0]?.trimEnd() !== "---") return { meta, bodyStart: 0, fields: null };
  const close = lines.findIndex((line, index) => index > 0 && /^(?:---|\.\.\.)\s*$/.test(line));
  if (close === -1) {
    warnings.push("The script starts with `---` but has no closing `---`: frontmatter ignored.");
    return { meta, bodyStart: 0, fields: null };
  }
  let data: unknown;
  try {
    data = parseYaml(lines.slice(1, close).join("\n"));
  } catch (error) {
    warnings.push(`Frontmatter is not valid YAML, ignored: ${(error as Error).message.split("\n")[0]}`);
    return { meta, bodyStart: close + 1, fields: null };
  }
  if (data === null || data === undefined) return { meta, bodyStart: close + 1, fields: null };
  if (typeof data !== "object" || Array.isArray(data)) {
    warnings.push("Frontmatter must be a YAML mapping (`key: value` lines): ignored.");
    return { meta, bodyStart: close + 1, fields: null };
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
  return { meta, bodyStart: close + 1, fields };
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
