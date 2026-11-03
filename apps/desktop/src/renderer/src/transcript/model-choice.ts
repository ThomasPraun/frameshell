// What the transcription model picker (#427) offers, from `model.list`; pure, so it is tested without the app.
import type { ModelListResult } from "@frameshell/protocol";

/** Option value of "Default": the project names no model. */
export const DEFAULT_CHOICE = "";
/** Option value of "Custom file…": never a model id (ids start with a letter or digit). */
export const CUSTOM_CHOICE = "+custom";

/** One option of the picker besides Default and Custom file. */
export interface ModelOption {
  id: string;
  /** Pinned: the provider ships it. Registered: a file on this machine. Unknown: the project names an id this machine lacks. */
  kind: "pinned" | "registered" | "unknown";
  /** Pinned: download bytes, null when unknown. */
  size: number | null;
  /** Pinned: already on this machine. */
  downloaded: boolean;
  /** Registered: the file, and whether it is still as registered. */
  file: string | null;
  state: "ok" | "missing" | "changed" | null;
}

/** The picker's content. */
export interface ModelChoices {
  /** Provider the project transcribes with. */
  provider: string;
  /** Selected value: the project's model id, or {@link DEFAULT_CHOICE}. */
  current: string;
  /** What Default means here: this machine's default for the provider, else the provider's own; null when unknown. */
  defaultModel: string | null;
  pinned: ModelOption[];
  registered: ModelOption[];
  /** The project's model when it is neither pinned nor registered here (only known once the provider listed its models). */
  unknown: ModelOption | null;
  /** Settings a registration may carry for this provider (whisper.cpp `dtw`), with their values. */
  options: { key: string; values: string[] }[];
}

/** {@link ModelChoices} of a `model.list` result for a project. */
export function modelChoices(list: ModelListResult): ModelChoices {
  const provider = list.project?.provider ?? "whisper-cpp";
  const own = list.providers.find((candidate) => candidate.id === provider) ?? null;
  const formats = own?.userModels?.formats ?? null;
  const pinned: ModelOption[] = (own?.models ?? []).map(({ id, size, downloaded }) => ({ id, kind: "pinned", size, downloaded, file: null, state: null }));
  const registered: ModelOption[] = list.models
    .filter((model) => formats === null || formats.includes(model.format))
    .map(({ id, file, state }) => ({ id, kind: "registered", size: null, downloaded: true, file, state }));
  const current = list.project?.model ?? DEFAULT_CHOICE;
  const known = current === DEFAULT_CHOICE || pinned.some((option) => option.id === current) || registered.some((option) => option.id === current);
  const unknown: ModelOption | null = known
    ? null
    : { id: current, kind: own ? "unknown" : "pinned", size: null, downloaded: false, file: null, state: null };
  return {
    provider,
    current,
    defaultModel: list.defaults[provider] ?? own?.defaultModel ?? null,
    pinned,
    registered,
    unknown,
    options: own?.userModels?.options ?? [],
  };
}

/**
 * A model id suggested for a file: its name without extension and without whisper.cpp's `ggml-` prefix, other
 * characters than the daemon's id allows (`ModelIdSchema` in `packages/protocol/src/models.ts`) turned into `-`.
 */
export function modelIdFromFile(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? "";
  const stem = name.includes(".") ? name.slice(0, name.lastIndexOf(".")) : name;
  const id = stem
    .replace(/^ggml-/i, "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[^A-Za-z0-9]+/, "")
    .slice(0, 64);
  return id || "model";
}

/** File name of an absolute path, for compact labels. */
export function fileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}
