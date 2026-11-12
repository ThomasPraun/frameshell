import { ErrorCode, type FormatChange, type FormatInfo, RpcError } from "@frameshell/protocol";
import {
  BUILTIN_FORMATS,
  BUILTIN_FORMAT_IDS,
  type FormatEntry,
  type FormatSource,
  primaryFormatId,
  projectFormats,
} from "@frameshell/schema";
import type { ConfigChanger, ConfigDocument, ConfigJournal } from "./config/journal.js";
import { FORMAT_RULES, formatState, formatsFromState } from "./config/project-doc.js";
import type { TxRef } from "./timeline/service.js";

/** What {@link FormatService} needs: the project config and the journal its changes go through. */
export interface FormatServiceOptions {
  /** Validated `frameshell.json` of the project rooted at `root`. */
  readConfig(root: string): Promise<FormatSource>;
  /** Journal with the `project` document ({@link projectConfigDocument}): one change at a time per project. */
  journal: ConfigJournal;
  /** Applies a change, or holds it in review mode (`TimelineService.changeConfig`). */
  change: ConfigChanger;
}

/**
 * The `project` config document (ADR 0036) over `formats` of `frameshell.json`. Writing back the one format a
 * project without `formats` has removes `formats`, so the file stays as it was.
 */
export function projectConfigDocument(options: {
  readConfig(root: string): Promise<FormatSource>;
  /** Replace `formats` (null removes it), keeping every other key; see `ProjectRegistry.writeFormats`. */
  writeFormats(root: string, formats: FormatEntry[] | null): Promise<unknown>;
}): ConfigDocument {
  return {
    rules: FORMAT_RULES,
    read: async (root) => formatState((await options.readConfig(root)).formats),
    write: async (root, state) => {
      const config = await options.readConfig(root);
      const list = formatsFromState(projectFormats(config)[0]!, state);
      await options.writeFormats(root, isDefault(list, config) ? null : list);
    },
    // Keys alone cannot repeat an id; only a format named like a new primary (the resolution changed) can clash.
    check: async (root, state) => {
      const primary = projectFormats(await options.readConfig(root))[0]!;
      return Object.keys(state).filter((key) => key === `format:${primary.id}`);
    },
  };
}

/** Formats of a project as the wire reports them, primary first. */
export function formatInfos(config: FormatSource): FormatInfo[] {
  return projectFormats(config).map((format, index) => info(format, index === 0));
}

/** Built-in formats with their canvases. */
export function builtinFormatInfos(): FormatInfo[] {
  return BUILTIN_FORMAT_IDS.map((id) => info({ id, ...BUILTIN_FORMATS[id]! }, false));
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
 * `format.add` / `format.remove` (ADR 0027 decision 11): edits `formats` in `frameshell.json` through the config
 * journal (ADR 0036), one change at a time per project, each in the caller's transaction with the call that undoes it.
 * In review mode (ADR 0019) it is made on the open proposal's formats and waits there.
 */
export class FormatService {
  readonly #options: FormatServiceOptions;

  constructor(options: FormatServiceOptions) {
    this.#options = options;
  }

  /** Add format `id` (a built-in, or a custom one with an even size) at `index` (default last; 0 is the primary's). */
  add(
    root: string,
    params: { id: string; width?: number | undefined; height?: number | undefined; index?: number | undefined },
    author: string,
    tx: TxRef,
  ): Promise<FormatChange> {
    return this.#options.journal.serial(root, async () => {
      const config = await this.#options.readConfig(root);
      const refuse = (reason: string, message: string, field?: string) =>
        new RpcError(ErrorCode.InvalidOperation, message, { op: "format.add", reason, ...(field ? { field } : {}) });
      if (config.kind === "image") {
        throw refuse("image project", "Image projects have one frame (ADR 0017): they take no formats. Export a picture with `frameshell frame`.");
      }
      const size = sizeFor(params, refuse);
      const args = Object.fromEntries(Object.entries(params).filter(([, value]) => value !== undefined));
      return this.#change(root, config, { author, tx }, (current) => {
        if (current.some((format) => format.id === params.id)) {
          throw refuse("exists", `The project already has format ${params.id}. List them: \`frameshell format list\`.`, "id");
        }
        const at = Math.min(Math.max(1, params.index ?? current.length), current.length);
        const added: FormatEntry = { id: params.id, ...size };
        const next = [...current.slice(0, at), added, ...current.slice(at)];
        return { op: "format.add", args, undo: { method: "format.remove", params: { id: params.id } }, next };
      });
    });
  }

  /** Remove format `id`; the primary stays. Back to one format, `formats` leaves `frameshell.json` when that one is the default. */
  remove(root: string, id: string, author: string, tx: TxRef): Promise<FormatChange> {
    return this.#options.journal.serial(root, async () => {
      const config = await this.#options.readConfig(root);
      return this.#change(root, config, { author, tx }, (current) => {
        const index = current.findIndex((format) => format.id === id);
        if (index === -1) throw formatNotFound(id, { ...config, formats: current });
        if (index === 0) {
          throw new RpcError(
            ErrorCode.InvalidOperation,
            `Format ${id} is the primary one: it equals the project resolution and always stays. Remove the others instead.`,
            { op: "format.remove", reason: "primary", field: "id" },
          );
        }
        const removed = current[index]!;
        const next = current.filter((format) => format.id !== id);
        return { op: "format.remove", args: { id }, undo: { method: "format.add", params: { id, width: removed.width, height: removed.height, index } }, next };
      });
    });
  }

  /** Run `edit` on the formats the change applies to (the open proposal's in review mode) and journal or propose it. */
  async #change(
    root: string,
    config: FormatSource,
    who: { author: string; tx: TxRef },
    edit: (current: FormatEntry[]) => { op: string; args: Record<string, unknown>; undo: FormatChange["undo"]; next: FormatEntry[] },
  ): Promise<FormatChange> {
    const primary = projectFormats(config)[0]!;
    let undo!: FormatChange["undo"];
    const changed = await this.#options.change(root, "project", who, async (base) => {
      const made = edit(formatsFromState(primary, base));
      undo = made.undo;
      return { op: made.op, args: made.args, undo, after: formatState(made.next) };
    });
    const formats = formatsFromState(primary, changed.state);
    return { dir: root, formats: formatInfos({ ...config, formats }), op: changed.operation.id, tx: changed.operation.tx, undo, proposal: changed.proposal };
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
