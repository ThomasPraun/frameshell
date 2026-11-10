import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { ErrorCode, type FormatChange, type FormatInfo, RpcError } from "@frameshell/protocol";
import {
  BUILTIN_FORMATS,
  BUILTIN_FORMAT_IDS,
  type FormatEntry,
  type FormatSource,
  primaryFormatId,
  projectFormats,
} from "@frameshell/schema";
import { appendJsonLine, readJsonLines } from "./fs-util.js";

/**
 * Journal of `frameshell.json` format edits (ADR 0027): one JSON line per change with the list before and
 * after. Timeline ids hold no `.`, so it never collides with a timeline journal in the same folder.
 */
export const FORMAT_JOURNAL = ".frameshell/history/project.config.jsonl";

/** One line of {@link FORMAT_JOURNAL}. `before`/`after` null: `frameshell.json` had no `formats`. */
export interface FormatJournalEntry {
  id: string;
  op: "format.add" | "format.remove";
  args: Record<string, unknown>;
  author: string;
  at: string;
  before: FormatEntry[] | null;
  after: FormatEntry[] | null;
  /** The call that undoes this change, as `format.add`/`format.remove` returned it. */
  undo: FormatChange["undo"];
}

/** What {@link FormatService} needs from the project registry. */
export interface FormatServiceOptions {
  /** Validated `frameshell.json` of the project rooted at `root`. */
  readConfig(root: string): Promise<FormatSource>;
  /** Replace `formats` (null removes it), keeping every other key; see `ProjectRegistry.writeFormats`. */
  writeFormats(root: string, formats: FormatEntry[] | null): Promise<unknown>;
  /** Clock for journal times. Default `new Date()`. */
  now?: () => Date;
}

/** Formats of a project as the wire reports them, primary first. */
export function formatInfos(config: FormatSource): FormatInfo[] {
  return projectFormats(config).map((format, index) => info(format, index === 0));
}

/** Built-in formats with their canvases. */
export function builtinFormatInfos(): FormatInfo[] {
  return BUILTIN_FORMAT_IDS.map((id) => info({ id, ...BUILTIN_FORMATS[id]! }, false));
}

/** The {@link FORMAT_JOURNAL} line with id `op` in the project rooted at `root`, or null. */
export async function findFormatChange(root: string, op: string): Promise<FormatJournalEntry | null> {
  for (const value of await readJsonLines(join(root, ...FORMAT_JOURNAL.split("/")))) {
    const entry = value as Partial<FormatJournalEntry> | null;
    if (entry?.id === op && entry.undo) return entry as FormatJournalEntry;
  }
  return null;
}

/** `FormatNotFound` for `id`, listing the project's formats. */
export function formatNotFound(id: string, config: FormatSource): RpcError {
  const available = projectFormats(config).map((format) => format.id);
  return new RpcError(
    ErrorCode.FormatNotFound,
    `The project has no format "${id}". Its formats: ${available.join(", ")}. Add one: \`frameshell format add <id>\` ` +
      `(built-in: ${BUILTIN_FORMAT_IDS.join(", ")}).`,
    { format: id, available },
  );
}

/**
 * `format.add` / `format.remove` (ADR 0027 decision 11): edits `formats` in `frameshell.json`, one change at a
 * time per project, each journaled with the call that undoes it.
 */
export class FormatService {
  readonly #options: FormatServiceOptions;
  /** Per root: the change in progress, so two edits never read the same file state. */
  readonly #queues = new Map<string, Promise<unknown>>();

  constructor(options: FormatServiceOptions) {
    this.#options = options;
  }

  /** Add format `id` (a built-in, or a custom one with an even size) at `index` (default last; 0 is the primary's). */
  add(root: string, params: { id: string; width?: number | undefined; height?: number | undefined; index?: number | undefined }, author: string): Promise<FormatChange> {
    return this.#serial(root, async () => {
      const config = await this.#options.readConfig(root);
      const refuse = (reason: string, message: string, field?: string) =>
        new RpcError(ErrorCode.InvalidOperation, message, { op: "format.add", reason, ...(field ? { field } : {}) });
      if (config.kind === "image") {
        throw refuse("image project", "Image projects have one frame (ADR 0017): they take no formats. Export a picture with `frameshell frame`.");
      }
      const current = projectFormats(config);
      if (current.some((format) => format.id === params.id)) {
        throw refuse("exists", `The project already has format ${params.id}. List them: \`frameshell format list\`.`, "id");
      }
      const size = sizeFor(params, refuse);
      const at = Math.min(Math.max(1, params.index ?? current.length), current.length);
      const added: FormatEntry = { id: params.id, ...size };
      const next = [...current.slice(0, at), added, ...current.slice(at)];
      const args = Object.fromEntries(Object.entries(params).filter(([, value]) => value !== undefined));
      return this.#commit(root, config, next, { op: "format.add", args, author }, { method: "format.remove", params: { id: params.id } });
    });
  }

  /** Remove format `id`; the primary stays. Back to one format, `formats` leaves `frameshell.json` when that one is the default. */
  remove(root: string, id: string, author: string): Promise<FormatChange> {
    return this.#serial(root, async () => {
      const config = await this.#options.readConfig(root);
      const current = projectFormats(config);
      const index = current.findIndex((format) => format.id === id);
      if (index === -1) throw formatNotFound(id, config);
      if (index === 0) {
        throw new RpcError(
          ErrorCode.InvalidOperation,
          `Format ${id} is the primary one: it equals the project resolution and always stays. Remove the others instead.`,
          { op: "format.remove", reason: "primary", field: "id" },
        );
      }
      const removed = current[index]!;
      const next = current.filter((format) => format.id !== id);
      const undo = { method: "format.add" as const, params: { id, width: removed.width, height: removed.height, index } };
      return this.#commit(root, config, next, { op: "format.remove", args: { id }, author }, undo);
    });
  }

  async #commit(
    root: string,
    config: FormatSource,
    next: FormatEntry[],
    entry: Pick<FormatJournalEntry, "op" | "args" | "author">,
    undo: FormatChange["undo"],
  ): Promise<FormatChange> {
    const written = isDefault(next, config) ? null : next;
    const id = `op_${randomBytes(4).toString("hex")}`;
    const line: FormatJournalEntry = {
      id,
      ...entry,
      at: (this.#options.now?.() ?? new Date()).toISOString(),
      before: config.formats ? [...config.formats] : null,
      after: written,
      undo,
    };
    // Journal first: a change never reaches frameshell.json without its line.
    await appendJsonLine(join(root, ...FORMAT_JOURNAL.split("/")), line);
    await this.#options.writeFormats(root, written);
    return { dir: root, formats: formatInfos({ ...config, formats: written ?? undefined }), op: id, undo };
  }

  #serial<T>(root: string, work: () => Promise<T>): Promise<T> {
    const run = (this.#queues.get(root) ?? Promise.resolve()).catch(() => {}).then(work);
    this.#queues.set(root, run);
    return run;
  }
}

/** Frame size of a new format: a built-in's canvas, or the custom size given (even). */
function sizeFor(
  params: { id: string; width?: number | undefined; height?: number | undefined },
  refuse: (reason: string, message: string, field?: string) => RpcError,
): { width: number; height: number } {
  const builtin = BUILTIN_FORMATS[params.id];
  if (builtin) {
    const differs = (params.width !== undefined && params.width !== builtin.width) || (params.height !== undefined && params.height !== builtin.height);
    if (differs) {
      throw refuse(
        "builtin size",
        `Built-in format ${params.id} is ${builtin.width}x${builtin.height}. For another size use a custom id, e.g. \`${params.id}-${params.width ?? builtin.width}x${params.height ?? builtin.height}\`.`,
        "width",
      );
    }
    return { width: builtin.width, height: builtin.height };
  }
  if (params.width === undefined || params.height === undefined) {
    throw refuse(
      "size",
      `Custom format ${params.id} needs a frame size: width and height (CLI \`--size 1600x900\`). Built-in ids take none: ${BUILTIN_FORMAT_IDS.join(", ")}.`,
      params.width === undefined ? "width" : "height",
    );
  }
  if (params.width % 2 !== 0 || params.height % 2 !== 0) {
    throw refuse("size", `Format ${params.id} is ${params.width}x${params.height}; video encoders need even sizes.`, params.width % 2 !== 0 ? "width" : "height");
  }
  return { width: params.width, height: params.height };
}

/** True when `formats` is the one format a project without `formats` has: writing none keeps the file as it was. */
function isDefault(formats: readonly FormatEntry[], config: FormatSource): boolean {
  const [only] = formats;
  return formats.length === 1 && only!.id === primaryFormatId(config.resolution) && only!.width === config.resolution.width && only!.height === config.resolution.height;
}

function info(format: FormatEntry, primary: boolean): FormatInfo {
  const builtin = BUILTIN_FORMATS[format.id];
  return { ...format, primary, builtin: builtin !== undefined && builtin.width === format.width && builtin.height === format.height };
}
