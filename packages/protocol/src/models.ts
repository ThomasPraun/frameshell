import { z } from "zod";

// Transcription models (#427): the provider's pinned models, and model files the user registered on this machine
// (`<configDir>/models.json`). A project names only a model id; the file behind a registered id is per machine.

/** Id of a registered model: what `transcription.model` and `--model` name. */
export const ModelIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, "letters, digits, `.`, `_` and `-`, starting with a letter or digit, at most 64")
  .describe("Model id, e.g. `whisper-es-finetune`: letters, digits, `.`, `_`, `-`; starts with a letter or digit; at most 64 characters.");

/** Format of a registered model file: only formats that cannot run code. */
export const ModelFormatSchema = z
  .enum(["ggml", "gguf", "onnx"])
  .describe("File format, read from the file's first bytes: `ggml` (whisper.cpp), `gguf`, or `onnx`.");

/** One model file registered on this machine. */
export const RegisteredModelSchema = z.object({
  id: z.string(),
  file: z.string().describe("Absolute path of the model file on this machine."),
  format: ModelFormatSchema,
  sha256: z.string().describe("Lowercase hex SHA-256 of the file when it was registered."),
  size: z.int().describe("Bytes when registered."),
  addedAt: z.string().describe("ISO time of registration."),
  options: z.record(z.string(), z.string()).describe("Provider settings stored with it, e.g. `{ \"dtw\": \"large.v3\" }` for whisper.cpp."),
  state: z
    .enum(["ok", "missing", "changed"])
    .describe("`missing`: the file is gone. `changed`: its size or modification time differs from registration (it is used anyway, with a warning)."),
});

/** See {@link RegisteredModelSchema}. */
export type RegisteredModel = z.output<typeof RegisteredModelSchema>;

/** One model a provider ships, as `model.list` reports it. */
export const PinnedModelSchema = z.object({
  id: z.string().describe("Id for `--model` and `transcription.model`."),
  size: z.int().nullable().describe("Download size in bytes; null when unknown."),
  downloaded: z.boolean().describe("True when the file is already on this machine."),
});

/** A transcription provider of the project and the models it ships. */
export const ProviderModelsSchema = z.object({
  id: z.string().describe("Provider id, e.g. `whisper-cpp`."),
  defaultModel: z.string().nullable().describe("Model the provider uses when nobody names one; null when it does not say."),
  models: z.array(PinnedModelSchema),
  userModels: z
    .object({
      formats: z.array(ModelFormatSchema).describe("Formats of registered files it reads."),
      options: z
        .array(z.object({ key: z.string(), values: z.array(z.string()) }))
        .describe("Settings a registration may carry (`model.add` `options`), with the values each takes."),
    })
    .nullable()
    .describe("How the provider reads registered model files; null when it reads none."),
});

/** Result of `model.list`. */
export const ModelListResultSchema = z.object({
  registry: z.string().describe("Absolute path of this machine's model registry (`models.json` in the config dir)."),
  models: z.array(RegisteredModelSchema).describe("Model files registered on this machine, by id."),
  defaults: z.record(z.string(), z.string()).describe("This machine's default model per provider id, used when a project names none."),
  providers: z
    .array(ProviderModelsSchema)
    .describe("Transcription providers of the project at `cwd` with their own models; empty without `cwd` or when its plugins cannot load."),
  providersError: z.string().nullable().describe("Why `providers` is empty although `cwd` was given (e.g. plugins not trusted); null otherwise."),
  project: z
    .object({
      dir: z.string(),
      provider: z.string().describe("`transcription.provider`, else `whisper-cpp`."),
      model: z.string().nullable().describe("`transcription.model` of `frameshell.json`; null when not set."),
      effective: z
        .string()
        .nullable()
        .describe("Model a `transcribe` would use here: the project's, else this machine's default, else the provider's; null when unknown."),
    })
    .nullable()
    .describe("Transcription settings of the project at `cwd`; null without `cwd`."),
});

/** See {@link ModelListResultSchema}. */
export type ModelListResult = z.output<typeof ModelListResultSchema>;
