import { open, stat } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { z } from "zod";
import type { ModelFormat, UserModel } from "@frameshell/plugin-api";
import { ErrorCode, type ModelListResult, type Progress, type RegisteredModel, RpcError } from "@frameshell/protocol";
import { readJsonIfExists, sha256File, writeJsonAtomic } from "../fs-util.js";

/** File name of the per-machine model registry inside the config dir. */
export const MODEL_REGISTRY_FILE = "models.json";

const FormatSchema = z.enum(["ggml", "gguf", "onnx"]);

const EntrySchema = z.strictObject({
  file: z.string(),
  format: FormatSchema,
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  size: z.int().nonnegative(),
  /** Modification time at registration: with `size`, decides whether a resolve must hash the file again. */
  mtimeMs: z.number(),
  addedAt: z.string(),
  options: z.record(z.string(), z.string()).default({}),
});

const RegistrySchema = z.strictObject({
  $schema: z.string().optional(),
  models: z.record(z.string(), EntrySchema).default({}),
  defaults: z.record(z.string(), z.string()).default({}),
});

type Registry = z.output<typeof RegistrySchema>;
type Entry = z.output<typeof EntrySchema>;

/** Extensions of pickle-based checkpoints: loading one can run code, so they are never registered. */
const PICKLE_EXTENSIONS = new Set([".nemo", ".pt", ".pth", ".ckpt", ".pkl", ".pickle"]);

/** How to register `id`, for error messages. */
export function registerHint(id: string): string {
  return `Register its file on this machine with \`frameshell model add ${id} <file>\`, or pick another model from \`frameshell model list\`.`;
}

/**
 * Format of the model file at `path`, from its first bytes: whisper.cpp `ggml` (magic `lmgg`), `gguf` (`GGUF`), or
 * `onnx` (`.onnx` file starting with the `ir_version` field of a protobuf ModelProto). Throws
 * `UnsupportedModelFormat` for pickle-based checkpoints (they can run code when loaded) and anything else.
 */
export async function detectModelFormat(path: string): Promise<ModelFormat> {
  const handle = await open(path, "r");
  const head = Buffer.alloc(512);
  let length: number;
  try {
    ({ bytesRead: length } = await handle.read(head, 0, head.length, 0));
  } finally {
    await handle.close();
  }
  const bytes = head.subarray(0, length);
  const ascii = (from: number, to: number) => bytes.subarray(from, to).toString("latin1");
  if (ascii(0, 4) === "lmgg") return "ggml";
  if (ascii(0, 4) === "GGUF") return "gguf";
  const ext = extname(path).toLowerCase();
  if (ext === ".onnx" && bytes[0] === 0x08) return "onnx";
  const pickled =
    PICKLE_EXTENSIONS.has(ext) ||
    (bytes[0] === 0x80 && bytes[1] !== undefined && bytes[1] >= 2 && bytes[1] <= 5) || // pickle protocol 2-5
    ascii(0, 4) === "PK\x03\x04" || // zip: PyTorch checkpoints
    ascii(257, 262) === "ustar"; // tar: NeMo `.nemo`
  if (pickled) {
    throw new RpcError(
      ErrorCode.UnsupportedModelFormat,
      `${path} is a pickle-based checkpoint (PyTorch or NeMo): loading it can run code, so Frameshell does not. ` +
        "Use the model's ggml (whisper.cpp) or ONNX export instead.",
      { file: path, reason: "pickle" },
    );
  }
  throw new RpcError(
    ErrorCode.UnsupportedModelFormat,
    `${path} is not a model file Frameshell reads: expected whisper.cpp ggml, gguf or ONNX (\`.onnx\`).`,
    { file: path, reason: "unknown" },
  );
}

/**
 * Model files the user registered on this machine (`<configDir>/models.json`, #427): id → file, format, SHA-256 at
 * registration and provider options, plus a default model per provider. Projects name only ids, so they stay
 * portable; the file behind an id is per machine. Writes are serialized within the process.
 */
export class ModelRegistry {
  readonly path: string;
  #writing: Promise<unknown> = Promise.resolve();

  constructor(configDir: string) {
    this.path = join(configDir, MODEL_REGISTRY_FILE);
  }

  /** Registered models (state from `stat` only, no hashing) and the defaults. */
  async list(): Promise<Pick<ModelListResult, "registry" | "models" | "defaults">> {
    const registry = await this.#read();
    const models = await Promise.all(Object.entries(registry.models).map(([id, entry]) => describe(id, entry)));
    return { registry: this.path, models: models.sort((a, b) => a.id.localeCompare(b.id)), defaults: registry.defaults };
  }

  /** True when `id` is registered. */
  async has(id: string): Promise<boolean> {
    return Object.hasOwn((await this.#read()).models, id);
  }

  /** This machine's default model for `provider`, or undefined. */
  async defaultFor(provider: string): Promise<string | undefined> {
    return (await this.#read()).defaults[provider];
  }

  /**
   * Register `file` under `id`, replacing a previous registration. Detects the format (throws
   * `UnsupportedModelFormat`) and hashes the file, reporting progress. Throws `AssetNotFound` when `file` is
   * not a file.
   */
  async add(
    id: string,
    file: string,
    options: Readonly<Record<string, string>>,
    progress: (update: Progress) => void = () => {},
  ): Promise<{ model: RegisteredModel; replaced: boolean }> {
    const path = resolve(file);
    const info = await stat(path).catch(() => null);
    if (!info?.isFile()) throw new RpcError(ErrorCode.AssetNotFound, `Model file ${path} does not exist or is not a file.`, { path });
    const format = await detectModelFormat(path);
    const message = `Hashing model file ${path}`;
    progress({ message, stage: "model-hash", values: { file: path } });
    const sha256 = await sha256File(path, (read) =>
      progress({ message, fraction: info.size > 0 ? read / info.size : 1, stage: "model-hash", values: { file: path } }),
    );
    const entry: Entry = { file: path, format, sha256, size: info.size, mtimeMs: info.mtimeMs, addedAt: new Date().toISOString(), options: { ...options } };
    let replaced = false;
    await this.#update((registry) => {
      replaced = Object.hasOwn(registry.models, id);
      registry.models[id] = entry;
    });
    return { model: await describe(id, entry), replaced };
  }

  /** Forget `id` and clear the defaults naming it. Throws `ModelNotRegistered`. */
  async remove(id: string): Promise<{ removed: RegisteredModel; defaults: string[] }> {
    let removed: Entry | undefined;
    const cleared: string[] = [];
    await this.#update((registry) => {
      removed = registry.models[id];
      if (!removed) throw notRegistered(id, "unknown");
      delete registry.models[id];
      for (const [provider, model] of Object.entries(registry.defaults)) {
        if (model !== id) continue;
        delete registry.defaults[provider];
        cleared.push(provider);
      }
    });
    return { removed: await describe(id, removed!), defaults: cleared };
  }

  /** Set (or with null clear) the default model of `provider`; resolves with the previous one. */
  async setDefault(provider: string, model: string | null): Promise<string | null> {
    let previous: string | null = null;
    await this.#update((registry) => {
      previous = registry.defaults[provider] ?? null;
      if (model === null) delete registry.defaults[provider];
      else registry.defaults[provider] = model;
    });
    return previous;
  }

  /**
   * The file of registered model `id` for a provider that reads `formats`. Hashes the file again only when its
   * size or modification time changed since registration; `changed` is true when its bytes differ. Throws
   * `ModelNotRegistered` (reason `unknown`, `missing-file` or `format`).
   */
  async resolve(id: string, formats: readonly ModelFormat[]): Promise<UserModel> {
    const entry = (await this.#read()).models[id];
    if (!entry) throw notRegistered(id, "unknown");
    const info = await stat(entry.file).catch(() => null);
    if (!info?.isFile()) throw notRegistered(id, "missing-file", entry.file);
    if (!formats.includes(entry.format)) throw notRegistered(id, "format", entry.file, `${entry.format}, expected ${formats.join(" or ")}`);
    const same = info.size === entry.size && info.mtimeMs === entry.mtimeMs;
    const sha256 = same ? entry.sha256 : await sha256File(entry.file);
    return { id, path: entry.file, format: entry.format, sha256, changed: sha256 !== entry.sha256, options: entry.options };
  }

  async #read(): Promise<Registry> {
    let raw: unknown;
    try {
      raw = await readJsonIfExists(this.path);
    } catch (error) {
      throw this.#invalid((error as Error).message);
    }
    const parsed = RegistrySchema.safeParse(raw ?? {});
    if (!parsed.success) throw this.#invalid(z.prettifyError(parsed.error));
    return parsed.data;
  }

  /** Read, change and write the registry, one change at a time. */
  async #update(change: (registry: Registry) => void): Promise<void> {
    const run = this.#writing.then(async () => {
      const registry = await this.#read();
      change(registry);
      await writeJsonAtomic(this.path, registry);
    });
    this.#writing = run.catch(() => {});
    await run;
  }

  #invalid(details: string): RpcError {
    return new RpcError(ErrorCode.InvalidGlobalConfig, `Invalid ${this.path}:\n${details}\nFix it or delete it to register models again.`, {
      path: this.path,
      details,
    });
  }
}

/** The `ModelNotRegistered` error of `id`. */
export function notRegistered(id: string, reason: "unknown" | "missing-file" | "format", file?: string, detail?: string): RpcError {
  const hint = registerHint(id);
  const message =
    reason === "unknown"
      ? `Model "${id}" is not registered on this machine. ${hint}`
      : reason === "missing-file"
        ? `The file of model "${id}" is gone (${file}). Register it again: \`frameshell model add ${id} <file>\`.`
        : `Model "${id}" (${file}) is ${detail}: this provider cannot read it.`;
  return new RpcError(ErrorCode.ModelNotRegistered, message, { id, reason, ...(file ? { file } : {}), hint });
}

async function describe(id: string, entry: Entry): Promise<RegisteredModel> {
  const info = await stat(entry.file).catch(() => null);
  const state = !info?.isFile() ? "missing" : info.size === entry.size && info.mtimeMs === entry.mtimeMs ? "ok" : "changed";
  const { file, format, sha256, size, addedAt, options } = entry;
  return { id, file, format, sha256, size, addedAt, options, state };
}
