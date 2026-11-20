import { ErrorCode, McpError, type Resource, type ResourceTemplate } from "@modelcontextprotocol/sdk/types.js";

/** URI of the skill's entry point, `SKILL.md`. Its other files are `frameshell://skill/<path>`, the path its links use. */
export const SKILL_URI = "frameshell://skill";
/** Template of the other skill files, e.g. `frameshell://skill/reference/cli.md`. */
export const SKILL_FILE_TEMPLATE = `${SKILL_URI}/{path}`;

const MARKDOWN_MIME = "text/markdown";
const ENTRY = "SKILL.md";

/**
 * The agent skill as resources, for MCP clients that never see the project's `.claude/skills` (Claude Desktop).
 * Served from the files bundled into the build, so it needs no project and no daemon.
 */
export class SkillResources {
  readonly #files: ReadonlyMap<string, string>;

  /** `files` maps a path relative to the skill directory (`SKILL.md`, `reference/cli.md`) to its Markdown. */
  constructor(files: Readonly<Record<string, string>>) {
    this.#files = new Map(Object.entries(files));
  }

  /** Whether the skill has an entry point to serve. */
  get available(): boolean {
    return this.#files.has(ENTRY);
  }

  /** One resource per skill file, `SKILL.md` first; empty without a bundled skill. */
  list(): Resource[] {
    if (!this.available) return [];
    return [...this.#files.keys()].sort(entryFirst).map((file) => ({
      uri: uriOf(file),
      name: file === ENTRY ? "skill" : `skill ${file}`,
      title: file === ENTRY ? "Frameshell skill: how to do each kind of work" : `Frameshell skill: ${file}`,
      description: file === ENTRY ? "Read first. Ground rules, work loop and which reference file covers what." : `Reference the skill links to: ${file}.`,
      mimeType: MARKDOWN_MIME,
    }));
  }

  /** The template of skill files, for clients that address one not listed. */
  templates(): ResourceTemplate[] {
    if (!this.available) return [];
    return [{ uriTemplate: SKILL_FILE_TEMPLATE, name: "skill file", description: "A file of the Frameshell skill, by the path its links use (`reference/cli.md`).", mimeType: MARKDOWN_MIME }];
  }

  /** Markdown of `uri`, or null when `uri` is not under {@link SKILL_URI}. Throws {@link McpError} for an unknown skill file. */
  read(uri: string): { uri: string; mimeType: string; text: string } | null {
    if (uri !== SKILL_URI && !uri.startsWith(`${SKILL_URI}/`)) return null;
    const file = uri === SKILL_URI ? ENTRY : safeDecode(uri.slice(SKILL_URI.length + 1));
    const text = this.#files.get(file);
    if (text === undefined) {
      const known = this.available ? ` Files: ${[...this.#files.keys()].sort(entryFirst).join(", ")}.` : "";
      throw new McpError(ErrorCode.InvalidParams, `No skill file ${file} (${uri}).${known} Read ${SKILL_URI} first.`);
    }
    return { uri, mimeType: MARKDOWN_MIME, text };
  }
}

function uriOf(file: string): string {
  return file === ENTRY ? SKILL_URI : `${SKILL_URI}/${file.split("/").map(encodeURIComponent).join("/")}`;
}

function entryFirst(a: string, b: string): number {
  return a === ENTRY ? -1 : b === ENTRY ? 1 : a.localeCompare(b);
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
