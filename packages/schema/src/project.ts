import { z } from "zod";
import { SCHEMA_VERSION, type ParseResult, formatIssues } from "./common.js";

/** Canonical `$schema` URL for `frameshell.json`, matching the generated JSON Schema `$id`. */
export const PROJECT_SCHEMA_URL = `https://frameshell.dev/schema/v${SCHEMA_VERSION}/project.json`;

/**
 * Zod model of `frameshell.json` (SPEC §5.2). Source of truth: the published
 * JSON Schema is generated from it. Unknown keys are rejected so typos surface.
 */
export const ProjectConfigSchema = z
  .object({
    $schema: z.string().optional(),
    schemaVersion: z.literal(SCHEMA_VERSION),
    name: z.string().min(1),
    fps: z.number().positive(),
    resolution: z.strictObject({
      width: z.int().positive(),
      height: z.int().positive(),
    }),
    sampleRate: z.int().positive(),
    /** Project-relative path of the exported sequence. */
    main: z.string().min(1),
    /** Plugin name to pinned version (SPEC §8.3). */
    plugins: z.record(z.string(), z.string()).default({}),
    transcription: z
      .strictObject({
        provider: z.string(),
        model: z.string().optional(),
        language: z.string().optional(),
      })
      .optional(),
    binaries: z.record(z.string(), z.string()).optional(),
    export: z
      .strictObject({
        defaultPreset: z.string().optional(),
        /** Integrated loudness target in LUFS. */
        loudness: z.number().optional(),
      })
      .optional(),
  })
  .strict();

/** Validated `frameshell.json` content. */
export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;

/**
 * Validate unknown input (usually parsed JSON) as a project config.
 * Never throws; `error` names each offending field path.
 */
export function parseProjectConfig(input: unknown): ParseResult<ProjectConfig> {
  const result = ProjectConfigSchema.safeParse(input);
  return result.success
    ? { ok: true, value: result.data }
    : { ok: false, error: formatIssues(result.error) };
}

/** Defaults written by `frameshell init`. 1080p30, 48 kHz. */
export function createProjectConfig(name: string): ProjectConfig {
  return {
    $schema: PROJECT_SCHEMA_URL,
    schemaVersion: SCHEMA_VERSION,
    name,
    fps: 30,
    resolution: { width: 1920, height: 1080 },
    sampleRate: 48000,
    main: "timelines/main.json",
    plugins: {},
  };
}
