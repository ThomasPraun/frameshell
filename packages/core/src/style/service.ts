import { createHash } from "node:crypto";
import { mkdir, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { ErrorCode, RpcError, type StyleChange, type StyleListResult, type StyleSaveResult, type StyleShowResult } from "@frameshell/protocol";
import {
  MOTION_PERSONALITY_IDS,
  type MotionPersonalityId,
  SAFE_ZONES,
  STYLE_FILE,
  STYLE_PATHS,
  type StyleFile,
  UserStyleIdSchema,
  parseStyleFile,
  resolveStyle,
} from "@frameshell/schema";
import type { ConfigChanger, ConfigEdit, ConfigJournal } from "../config/journal.js";
import { type ConfigState, PLAIN_RULES, configHash, diffConfig } from "../config/patch.js";
import { exists, readJsonIfExists, writeTextAtomic } from "../fs-util.js";
import type { TxRef } from "../timeline/service.js";
import { STYLE_KEY, checkedStyleState, stylePathOf, styleState, styleWritten } from "./doc.js";
import { readStyleFile } from "./read.js";

/** What {@link StyleService} needs. */
export interface StyleServiceOptions {
  /** Folder of the user styles: `<configDir>/styles` of `resolveAppDirs()` (ADR 0028 decision 1). */
  userDir: string;
  /** Journal with the `style` document ({@link styleConfigDocument}): one change at a time per project. */
  journal: ConfigJournal;
  /** Applies a change, or holds it in review mode (`TimelineService.changeConfig`). */
  change: ConfigChanger;
}

const FROM_KEY = `${STYLE_KEY}from`;

/**
 * The project's style guide (ADR 0028): `style.set` and `style.apply` change `style.json` only through the config
 * journal (ADR 0036), in the caller's transaction, held by review mode like a timeline change; `style.save` and
 * `style.list` work on the user styles, which no project inherits from.
 */
export class StyleService {
  readonly #options: StyleServiceOptions;

  constructor(options: StyleServiceOptions) {
    this.#options = options;
  }

  /** Set the value at `path` (null: remove it from the file). */
  set(root: string, path: string, value: unknown, author: string, tx: TxRef): Promise<StyleChange> {
    if (!STYLE_PATHS.includes(path)) {
      throw new RpcError(
        ErrorCode.InvalidOperation,
        `No style value at "${path}". A path names one value, e.g. colors.accent, motion.duration.quick, fonts.display, banned; ` +
          "`frameshell style show` lists every path.",
        { op: "style.set", reason: "path", field: "path", paths: [...STYLE_PATHS] },
      );
    }
    if (value === undefined) {
      throw new RpcError(ErrorCode.InvalidOperation, "style.set needs a `value`; null removes the value from the file.", { op: "style.set", reason: "value", field: "value" });
    }
    const key = STYLE_KEY + path;
    return this.#change(root, { author, tx }, (base) => ({
      op: "style.set",
      args: { path, value },
      undo: { method: "style.set", params: { path, value: base[key] ?? null } },
      after: checkedStyleState(PLAIN_RULES.apply(base, [{ key, value }]), "style.set"),
    }));
  }

  /** Copy user style or personality `name` into the project: value by value, or the whole file with `replace`. */
  async apply(root: string, name: string, replace: boolean, author: string, tx: TxRef): Promise<StyleChange> {
    const source = await this.#source(name);
    return this.#change(root, { author, tx }, (base) => {
      const after: Record<string, unknown> = replace ? { ...source.state } : { ...base, ...source.state };
      if (source.from) after[FROM_KEY] = source.from;
      return { op: "style.apply", args: { name, ...(replace ? { replace } : {}) }, after: checkedStyleState(after, "style.apply") };
    });
  }

  /** Copy the project's `style.json`, without `from`, to user style `name`. */
  async save(root: string, name: string, force: boolean): Promise<StyleSaveResult> {
    const refuse = (reason: string, message: string) => new RpcError(ErrorCode.InvalidOperation, message, { op: "style.save", reason, field: "name" });
    if (isPersonality(name)) throw refuse("personality", `"${name}" is a motion personality: \`style apply ${name}\` would pick the personality. Choose another name.`);
    const file = await readStyleFile(root);
    if (!file) throw refuse("no style", `The project has no ${STYLE_FILE} to save. Set a value first: \`frameshell style set <path> <value>\`.`);
    const path = this.#userPath(name);
    const replaced = await exists(path);
    if (replaced && !force) throw refuse("exists", `User style ${name} exists (${path}). Save under another name, or overwrite it with force (CLI \`--force\`).`);
    const raw = (await readJsonIfExists(join(root, STYLE_FILE))) as Record<string, unknown>;
    delete raw["from"];
    const content = `${JSON.stringify(raw, null, 2)}\n`;
    await mkdir(this.#options.userDir, { recursive: true });
    await writeTextAtomic(path, content);
    return { dir: root, id: name, path, sha256: sha256(content), replaced };
  }

  /** The user styles on this machine, sorted by id, and the personalities. */
  async list(): Promise<StyleListResult> {
    const dir = this.#options.userDir;
    const names = await readdir(dir).catch((error: NodeJS.ErrnoException) => (error.code === "ENOENT" ? [] : Promise.reject(error)));
    const ids = names
      .filter((entry) => entry.endsWith(".json"))
      .map((entry) => entry.slice(0, -".json".length))
      .filter((id) => UserStyleIdSchema.safeParse(id).success)
      .sort();
    const styles = await Promise.all(
      ids.map(async (id) => {
        const bytes = await readFile(this.#userPath(id));
        const parsed = parseText(bytes.toString("utf8"));
        return {
          id,
          sha256: sha256(bytes),
          personality: parsed.ok ? (parsed.value.motion?.personality ?? null) : null,
          error: parsed.ok ? null : parsed.error,
        };
      }),
    );
    return { dir, styles, personalities: [...MOTION_PERSONALITY_IDS] };
  }

  /**
   * `style.show` of keyed `state` (the file's, or an open proposal's version): read from the file itself while
   * the state is the file's, so values written as null keep their `file` source.
   */
  async show(root: string, state: ConfigState): Promise<Omit<StyleShowResult, "view" | "proposal">> {
    const onDisk = await readStyleFile(root);
    let file: StyleFile | null = onDisk;
    if (configHash(styleState(onDisk)) !== configHash(state)) {
      const written = styleWritten(null, state);
      const parsed = written ? parseStyleFile(written) : null;
      file = parsed?.ok ? parsed.value : null;
    }
    if (!file) return { dir: root, path: STYLE_FILE, style: null, from: null, safeZones: [] };
    const style = resolveStyle(file);
    const from = file.from ? { ...file.from, status: await this.#fromStatus(file.from) } : null;
    return { dir: root, path: STYLE_FILE, style, from, safeZones: style.platforms.value.map((id) => SAFE_ZONES[id]) };
  }

  /** Run `edit` on the style state the change applies to (the open proposal's in review mode) and journal or propose it. */
  #change(root: string, who: { author: string; tx: TxRef }, edit: (base: ConfigState) => ConfigEdit): Promise<StyleChange> {
    return this.#options.journal.serial(root, async () => {
      let base: ConfigState = {};
      let after: ConfigState = {};
      const changed = await this.#options.change(root, "style", who, async (state) => {
        const made = edit(state);
        [base, after] = [state, made.after];
        return made;
      });
      const order = (key: string) => (key === FROM_KEY ? -1 : STYLE_PATHS.indexOf(stylePathOf(key)));
      const changes = diffConfig(base, after)
        .sort((a, b) => order(a.key) - order(b.key))
        .map(({ key, before, after: value }) => ({ path: stylePathOf(key), before, after: value }));
      return { dir: root, path: STYLE_FILE, changes, op: changed.operation.id, tx: changed.operation.tx, proposal: changed.proposal };
    });
  }

  /** Keyed state of what `name` sets, and the `from` it records (null for a personality). */
  async #source(name: string): Promise<{ state: ConfigState; from: { id: string; sha256: string } | null }> {
    if (isPersonality(name)) return { state: { [`${STYLE_KEY}motion.personality`]: name }, from: null };
    const path = this.#userPath(name);
    let bytes: Buffer;
    try {
      bytes = await readFile(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const available = (await this.list()).styles.map((style) => style.id);
      throw new RpcError(
        ErrorCode.InvalidOperation,
        `No user style "${name}". User styles: ${available.length > 0 ? available.join(", ") : "none yet (`frameshell style save <name>` makes one)"}. ` +
          `Motion personalities: ${MOTION_PERSONALITY_IDS.join(", ")}.`,
        { op: "style.apply", reason: "not found", field: "name", available, personalities: [...MOTION_PERSONALITY_IDS] },
      );
    }
    const parsed = parseText(bytes.toString("utf8"));
    if (!parsed.ok) throw new RpcError(ErrorCode.InvalidGlobalConfig, `Invalid user style ${path}:\n${parsed.error}`, { path, details: parsed.error });
    // A user style's own `from` (hand-written) is not copied: the project records this one.
    const state = Object.fromEntries(Object.entries(styleState(parsed.value)).filter(([key]) => key !== FROM_KEY));
    return { state, from: { id: name, sha256: sha256(bytes) } };
  }

  async #fromStatus(from: { id: string; sha256: string }): Promise<"same" | "changed" | "missing"> {
    if (!UserStyleIdSchema.safeParse(from.id).success) return "missing";
    const bytes = await readFile(this.#userPath(from.id)).catch(() => null);
    if (!bytes) return "missing";
    return sha256(bytes) === from.sha256 ? "same" : "changed";
  }

  #userPath(id: string): string {
    return join(this.#options.userDir, `${id}.json`);
  }
}

function isPersonality(name: string): name is MotionPersonalityId {
  return (MOTION_PERSONALITY_IDS as readonly string[]).includes(name);
}

function parseText(text: string): ReturnType<typeof parseStyleFile> {
  try {
    return parseStyleFile(JSON.parse(text));
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}

function sha256(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}
