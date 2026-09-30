import { readFile, readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { type DaemonConnection, type MethodName, isMethodName } from "@frameshell/protocol";
import { ErrorCode, McpError, type Resource, type ResourceTemplate } from "@modelcontextprotocol/sdk/types.js";

/** URI scheme of every resource this server serves. */
const SCHEME = "frameshell://";
/** Script outlines come from the daemon's `script.outline` method once the registry declares it. */
const OUTLINE_METHOD = "script.outline";

/** URI of the project status resource. */
export const STATUS_URI = `${SCHEME}status`;
/** URI of a timeline's compact dump. */
export const timelineUri = (timeline: string) => `${SCHEME}timelines/${encodeURIComponent(timeline)}`;
/** URI of a timeline's history. */
export const historyUri = (timeline: string) => `${timelineUri(timeline)}/history`;
/** URI of a transcript; `file` is relative to `transcripts/`, e.g. `raw-01.words.json`. */
export const transcriptUri = (file: string) => `${SCHEME}transcripts/${encodeURIComponent(file)}`;
/** URI of a script's outline; `file` is relative to `scripts/`, e.g. `launch.md`. */
export const outlineUri = (file: string) => `${SCHEME}scripts/${encodeURIComponent(file)}/outline`;

const JSON_MIME = "application/json";

/**
 * Read side of the MCP server (SPEC §7b): project status, timelines, their
 * history, transcripts and script outlines, as the compact JSON of the
 * matching `--json` CLI output. Everything but transcripts is a daemon call;
 * transcripts are plain project files the daemon wrote, read as they are.
 */
export class ProjectResources {
  readonly #cwd: string;
  readonly #daemon: () => Promise<DaemonConnection>;
  readonly #hasMethod: (method: string) => boolean;

  /**
   * `hasMethod` says whether the daemon registry declares a method; defaults
   * to the linked protocol registry. Tests stub it to cover the outline path
   * before `script.outline` exists (#25, #75).
   */
  constructor(cwd: string, daemon: () => Promise<DaemonConnection>, hasMethod: (method: string) => boolean = isMethodName) {
    this.#cwd = cwd;
    this.#daemon = daemon;
    this.#hasMethod = hasMethod;
  }

  /** Root of the project enclosing the server's directory; null when there is none. */
  async root(): Promise<string | null> {
    const status = await (await this.#daemon()).request("status", { cwd: this.#cwd });
    return status.project?.dir ?? null;
  }

  /** Concrete resources of the project: one per timeline file, transcript and script. */
  async list(): Promise<{ resources: Resource[]; timelines: string[] }> {
    const resources: Resource[] = [
      { uri: STATUS_URI, name: "status", title: "Project status", description: "Daemon, project, plugin trust and background jobs.", mimeType: JSON_MIME },
    ];
    const root = await this.root();
    if (!root) return { resources, timelines: [] };
    const timelines = (await files(join(root, "timelines"), false)).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5));
    for (const timeline of timelines) {
      resources.push(
        { uri: timelineUri(timeline), name: `timeline ${timeline}`, description: `Tracks and clips of timelines/${timeline}.json.`, mimeType: JSON_MIME },
        { uri: historyUri(timeline), name: `history ${timeline}`, description: `Operations on ${timeline} grouped by transaction.`, mimeType: JSON_MIME },
      );
    }
    for (const file of (await files(join(root, "transcripts"), true)).filter((f) => f.endsWith(".words.json"))) {
      resources.push({ uri: transcriptUri(file), name: `transcript ${file}`, description: `Words of transcripts/${file}.`, mimeType: JSON_MIME });
    }
    if (this.#hasMethod(OUTLINE_METHOD)) {
      for (const file of (await files(join(root, "scripts"), true)).filter((f) => f.endsWith(".md"))) {
        resources.push({ uri: outlineUri(file), name: `outline ${file}`, description: `Scenes of scripts/${file}.`, mimeType: JSON_MIME });
      }
    }
    return { resources, timelines };
  }

  /** URI templates, so clients can address resources not listed yet. */
  templates(): ResourceTemplate[] {
    const templates: ResourceTemplate[] = [
      { uriTemplate: `${SCHEME}timelines/{timeline}`, name: "timeline", description: "Compact dump of a timeline (same as `timeline_show`).", mimeType: JSON_MIME },
      { uriTemplate: `${SCHEME}timelines/{timeline}/history`, name: "history", description: "A timeline's operations grouped by transaction (same as `history`).", mimeType: JSON_MIME },
      { uriTemplate: `${SCHEME}transcripts/{file}`, name: "transcript", description: "A transcript file under `transcripts/`, e.g. `raw-01.words.json`: words with ids and source-asset seconds.", mimeType: JSON_MIME },
    ];
    if (this.#hasMethod(OUTLINE_METHOD)) {
      templates.push({ uriTemplate: `${SCHEME}scripts/{file}/outline`, name: "script outline", description: "Scenes of a Markdown script under `scripts/`.", mimeType: JSON_MIME });
    }
    return templates;
  }

  /** Compact JSON text of `uri`. Throws {@link McpError} for unknown URIs or a missing project. */
  async read(uri: string): Promise<string> {
    if (uri === STATUS_URI) return JSON.stringify(await (await this.#daemon()).request("status", { cwd: this.#cwd }));
    const path = uri.startsWith(SCHEME) ? uri.slice(SCHEME.length).split("/") : [];
    const [kind, rawName, rest, ...extra] = path;
    const name = rawName === undefined ? undefined : safeDecode(rawName);
    if (name && extra.length === 0) {
      if (kind === "timelines" && rest === undefined) return this.#call("timeline.show", { timeline: name });
      if (kind === "timelines" && rest === "history") return this.#call("history", { timeline: name });
      if (kind === "transcripts" && rest === undefined) return this.#transcript(name);
      if (kind === "scripts" && rest === "outline" && this.#hasMethod(OUTLINE_METHOD)) return this.#call(OUTLINE_METHOD as MethodName, { file: `scripts/${name}` });
    }
    throw new McpError(ErrorCode.InvalidParams, `Unknown resource ${uri}. List resources, or use the templates under ${SCHEME}.`);
  }

  async #call(method: MethodName, params: Record<string, unknown>): Promise<string> {
    const conn = await this.#daemon();
    // Params are validated by the daemon against the registry.
    return JSON.stringify(await conn.request(method, { cwd: this.#cwd, ...params } as never));
  }

  async #transcript(file: string): Promise<string> {
    const root = await this.#requireRoot();
    const dir = join(root, "transcripts");
    const path = join(dir, file);
    const rel = relative(dir, path);
    if (!file.endsWith(".words.json") || rel.startsWith("..") || rel.split(sep).includes("..")) {
      throw new McpError(ErrorCode.InvalidParams, `Not a transcript: ${file}. Transcripts are \`transcripts/**/*.words.json\`.`);
    }
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch {
      throw new McpError(ErrorCode.InvalidParams, `No transcript transcripts/${file}. Create it with the \`transcribe\` tool.`);
    }
    return JSON.stringify(JSON.parse(text));
  }

  async #requireRoot(): Promise<string> {
    const root = await this.root();
    if (!root) throw new McpError(ErrorCode.InvalidParams, `No Frameshell project encloses ${this.#cwd}. Create one with the \`project_init\` tool.`);
    return root;
  }
}

/** File paths under `dir`, `/`-separated and relative to it; empty when `dir` is missing. */
async function files(dir: string, recursive: boolean): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true, recursive });
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => relative(dir, join(entry.parentPath, entry.name)).split(sep).join("/"))
      .sort();
  } catch {
    return [];
  }
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
