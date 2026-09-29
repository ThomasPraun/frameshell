import { z } from "zod";
import { SCHEMA_VERSION, type ParseResult, formatIssues } from "./common.js";

/** File at a plugin package root that marks it as a Frameshell plugin (SPEC §8.1). */
export const PLUGIN_MANIFEST_FILE = "frameshell-plugin.json";

/** Canonical `$schema` URL for `frameshell-plugin.json`. */
export const PLUGIN_MANIFEST_SCHEMA_URL = `https://frameshell.dev/schema/v${SCHEMA_VERSION}/plugin.json`;

/**
 * Top-level `frameshell` commands (SPEC §7). A plugin command group may not
 * reuse one: `frameshell <group> <command>` must stay unambiguous.
 */
export const BUILTIN_COMMANDS: readonly string[] = [
  "init", "status", "doctor", "import", "track", "clip", "cut", "timeline", "transcribe", "script",
  "tx", "history", "revert", "render", "frame", "mcp", "plugin", "help", "version",
];

/** npm package name, scoped or not. */
export const PluginNameSchema = z
  .string()
  .regex(/^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/, "must be an npm package name, e.g. `@acme/titles`");

/** Package-relative path that cannot escape the package directory. */
const RelativePath = z
  .string()
  .min(1)
  .refine((p) => !/^([/\\]|[A-Za-z]:)/.test(p) && !p.split(/[/\\]/).includes(".."), {
    message: "must be a relative path inside the plugin package",
  });

const Id = z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "must be lowercase letters, digits and dashes");

/** `<group> <command>`, e.g. `hyperframes new`; the group must not be a built-in command. */
const CommandName = z
  .string()
  .regex(/^[a-z][a-z0-9-]* [a-z][a-z0-9-]*$/, "must be `<group> <command>`, e.g. `hyperframes new`")
  .refine((c) => !BUILTIN_COMMANDS.includes(c.split(" ")[0]!), {
    message: "group shadows a built-in frameshell command",
  });

/**
 * Zod model of `frameshell-plugin.json` (SPEC §8.1). Declares every
 * contribution up front so hosts can list them without running plugin code;
 * the host rejects registrations that differ from the declaration.
 */
export const PluginManifestSchema = z.strictObject({
  $schema: z.string().optional(),
  name: PluginNameSchema.describe("npm package name; must match the installed package."),
  version: z.string().regex(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?$/, "must be a semver version, e.g. `0.1.0`"),
  apiVersion: z.string().regex(/^\d+$/, 'must be a major version string, e.g. "1"').describe("Plugin API major version targeted."),
  main: RelativePath.describe("ES module exporting `activate(api)`."),
  description: z.string().optional(),
  contributes: z
    .strictObject({
      clipTypes: z.array(Id).default([]),
      transcriptionProviders: z.array(Id).default([]),
      commands: z.array(CommandName).default([]),
      exportPresets: z.array(Id).default([]),
      /** Markdown agent skills shipped with the plugin. */
      skills: z.array(RelativePath).default([]),
    })
    .default({ clipTypes: [], transcriptionProviders: [], commands: [], exportPresets: [], skills: [] }),
});

/** Validated `frameshell-plugin.json` content. */
export type PluginManifest = z.infer<typeof PluginManifestSchema>;

/** Validate unknown input as a plugin manifest. Never throws; `error` names each offending field. */
export function parsePluginManifest(input: unknown): ParseResult<PluginManifest> {
  const result = PluginManifestSchema.safeParse(input);
  return result.success ? { ok: true, value: result.data } : { ok: false, error: formatIssues(result.error) };
}

/**
 * Declarative export preset (SPEC §8.2). Aspect ratio follows from
 * `video.width`/`video.height`; `loudness` is the integrated LUFS target.
 */
export const ExportPresetSchema = z.strictObject({
  id: Id,
  label: z.string().optional(),
  container: z.enum(["mp4", "mov", "webm"]),
  video: z.strictObject({
    codec: z.enum(["h264", "h265", "vp9", "prores"]),
    width: z.int().positive(),
    height: z.int().positive(),
    fps: z.number().positive().optional(),
    bitrateKbps: z.int().positive().optional(),
    crf: z.int().min(0).max(63).optional(),
  }),
  audio: z.strictObject({
    codec: z.enum(["aac", "opus", "pcm"]),
    bitrateKbps: z.int().positive().optional(),
    sampleRate: z.int().positive().optional(),
  }),
  loudness: z.number().max(0).optional(),
});

/** Validated export preset. */
export type ExportPreset = z.infer<typeof ExportPresetSchema>;

/** Validate unknown input as an export preset. Never throws. */
export function parseExportPreset(input: unknown): ParseResult<ExportPreset> {
  const result = ExportPresetSchema.safeParse(input);
  return result.success ? { ok: true, value: result.data } : { ok: false, error: formatIssues(result.error) };
}
