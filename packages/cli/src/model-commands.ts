import { resolve } from "node:path";
import type { DaemonConnection, ModelListResult, Progress } from "@frameshell/protocol";
import { UsageError } from "./timeline-commands.js";

/** Help text of the `model` commands (#427), in `frameshell --help`. */
export const MODEL_USAGE = `  model list                   Transcription models: the provider's own (size, downloaded), model files registered
                               on this machine (format, state), this machine's defaults, and what this project uses
  model add <id> <file> [--dtw preset]
                               Register a local model file under <id> on this machine: whisper.cpp ggml, gguf or
                               ONNX (pickle files such as .nemo, .pt, .ckpt are refused). Its SHA-256 is stored and
                               written into each transcript made with it. --dtw: the whisper.cpp alignment preset of
                               the model it was trained from (small, large.v3, ...), for precise word starts
  model remove <id>            Forget a registered model (the file stays)
  model default <id|none> [--provider p]
                               This machine's model for projects that name none (none: the provider's own)
  model use <id|default> [--provider p]
                               The project's model: transcription.model in frameshell.json (default removes it)
`;

/** Flags each `model` command takes besides the global ones. */
export const MODEL_FLAGS: Record<string, readonly string[]> = {
  "model list": [],
  "model add": ["dtw"],
  "model remove": [],
  "model default": ["provider"],
  "model use": ["provider"],
};

/** A parsed `model` command; `file` as typed, resolved against the working directory when run. */
export type ModelInvocation =
  | { kind: "model.list" }
  | { kind: "model.add"; id: string; file: string; dtw?: string }
  | { kind: "model.remove"; id: string }
  | { kind: "model.default"; model: string | null; provider?: string }
  | { kind: "transcription.set"; model: string | null; provider?: string };

/** Parse `model <sub> …`; null when the shape is wrong. Throws `UsageError` for a bad flag value. */
export function parseModel(rest: string[], options: { dtw?: string | undefined; provider?: string | undefined }): ModelInvocation | null {
  const [sub, ...args] = rest;
  const provider = options.provider !== undefined ? { provider: options.provider } : {};
  switch (sub) {
    case "list":
      return args.length === 0 ? { kind: "model.list" } : null;
    case "add":
      if (args.length !== 2) return null;
      if (options.dtw !== undefined && options.dtw.trim() === "") throw new UsageError("--dtw takes a preset name, e.g. --dtw large.v3.");
      return { kind: "model.add", id: args[0]!, file: args[1]!, ...(options.dtw !== undefined ? { dtw: options.dtw } : {}) };
    case "remove":
      return args.length === 1 ? { kind: "model.remove", id: args[0]! } : null;
    case "default":
      return args.length === 1 ? { kind: "model.default", model: args[0] === "none" ? null : args[0]!, ...provider } : null;
    case "use":
      return args.length === 1 ? { kind: "transcription.set", model: args[0] === "default" ? null : args[0]!, ...provider } : null;
    default:
      return null;
  }
}

/** Services of the CLI a `model` command needs. */
export interface ModelCommandIo {
  cwd: string;
  json: boolean;
  /** Ask for plugin trust when the project's is undecided, so its providers can list their models. */
  settleTrust(): Promise<void>;
  progress?: ((progress: Progress) => void) | undefined;
}

/** Run a parsed `model` command; human output unless `json`. */
export async function executeModel(conn: DaemonConnection, inv: ModelInvocation, io: ModelCommandIo): Promise<string> {
  const print = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
  const { cwd, json } = io;
  switch (inv.kind) {
    case "model.list": {
      await io.settleTrust();
      const result = await conn.request("model.list", { cwd });
      return json ? print(result) : formatList(result);
    }
    case "model.add": {
      const result = await conn.request(
        "model.add",
        { id: inv.id, file: resolve(cwd, inv.file), options: inv.dtw !== undefined ? { dtw: inv.dtw } : {} },
        io.progress ? { onProgress: io.progress } : {},
      );
      if (json) return print(result);
      const { model } = result;
      return (
        `${result.replaced ? "Replaced" : "Registered"} model ${model.id}: ${model.file} (${model.format}, ${megabytes(model.size)})\n` +
        `  sha256 ${model.sha256}\n  use it: frameshell transcribe <asset> --model ${model.id}, or frameshell model use ${model.id}\n`
      );
    }
    case "model.remove": {
      const result = await conn.request("model.remove", { id: inv.id });
      if (json) return print(result);
      const cleared = result.defaults.length > 0 ? `\n  no longer the default of ${result.defaults.join(", ")}` : "";
      return `Forgot model ${result.removed.id} (the file ${result.removed.file} stays)${cleared}\n`;
    }
    case "model.default": {
      const result = await conn.request("model.default", { model: inv.model, cwd, ...(inv.provider ? { provider: inv.provider } : {}) });
      if (json) return print(result);
      return `Default model of ${result.provider} on this machine: ${result.model ?? "the provider's own"} (was ${result.previous ?? "none"})\n`;
    }
    case "transcription.set": {
      await io.settleTrust();
      const result = await conn.request("transcription.set", { cwd, model: inv.model, ...(inv.provider ? { provider: inv.provider } : {}) });
      if (json) return print(result);
      return `Project model (${result.provider}): ${result.model ?? "default"} (was ${result.previous ?? "default"})\n`;
    }
  }
}

function formatList(result: ModelListResult): string {
  const lines: string[] = [];
  for (const provider of result.providers) {
    lines.push(`${provider.id} models:`);
    for (const model of provider.models) {
      const facts = [model.size !== null ? megabytes(model.size) : null, model.downloaded ? "downloaded" : "downloads on first use"].filter(Boolean);
      lines.push(`  ${model.id}${model.id === provider.defaultModel ? " (provider default)" : ""}  ${facts.join(", ")}`);
    }
  }
  if (result.providersError) lines.push(`Provider models not listed: ${result.providersError}`);
  lines.push(result.models.length > 0 ? `Registered on this machine (${result.registry}):` : `No model files registered on this machine: \`frameshell model add <id> <file>\`.`);
  for (const model of result.models) {
    const state = model.state === "ok" ? "" : model.state === "missing" ? "  FILE MISSING" : "  file changed since registered";
    const options = Object.entries(model.options).map(([key, value]) => `${key}=${value}`).join(" ");
    lines.push(`  ${model.id}  ${model.format}  ${megabytes(model.size)}  ${model.file}${options ? `  ${options}` : ""}${state}`);
  }
  const defaults = Object.entries(result.defaults);
  if (defaults.length > 0) lines.push(`Defaults on this machine: ${defaults.map(([provider, model]) => `${provider} ${model}`).join(", ")}`);
  if (result.project) {
    const { provider, model, effective } = result.project;
    lines.push(`This project: ${provider} ${model ?? "(no transcription.model)"}; transcribe uses ${effective ?? "the provider's default"}`);
  }
  return `${lines.join("\n")}\n`;
}

function megabytes(bytes: number): string {
  return `${Math.round(bytes / 1_000_000)} MB`;
}
