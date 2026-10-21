import { z } from "zod";
import { SCHEMA_VERSION, type ParseResult, formatIssues } from "./common.js";

/** Canonical `$schema` URL for `frameshell.json`, matching the generated JSON Schema `$id`. */
export const PROJECT_SCHEMA_URL = `https://frameshell.dev/schema/v${SCHEMA_VERSION}/project.json`;

/** Smallest snap search half-width, seconds: DTW onset error reaches ±500 ms (ADR 0003). */
export const MIN_SNAP_WINDOW_S = 0.5;
/** Largest snap search half-width, seconds; wider reaches into neighbouring sentences. */
export const MAX_SNAP_WINDOW_S = 10;

/** What a project makes (ADR 0017): `video` (default) or `image`, one still frame exported as a picture. */
export const ProjectKindSchema = z
  .enum(["video", "image"])
  .describe(
    "What the project makes. `video` (default when absent): a timeline exported as a video. `image`: one still picture, " +
      "the timeline's first frame, exported with `frame`; video tracks are its layers, first track at the bottom.",
  );

/** See {@link ProjectKindSchema}. */
export type ProjectKind = z.infer<typeof ProjectKindSchema>;

/** Kind of a project config; `video` when it declares none. */
export function projectKind(config: { kind?: ProjectKind | undefined }): ProjectKind {
  return config.kind ?? "video";
}

const snapWindowFix =`Use ${MIN_SNAP_WINDOW_S} to ${MAX_SNAP_WINDOW_S}, or remove \`editing.snapWindow\` for the default ${MIN_SNAP_WINDOW_S}.`;

/**
 * Zod model of `frameshell.json` (SPEC §5.2). Source of truth: the published
 * JSON Schema is generated from it. Unknown keys are rejected so typos surface.
 */
export const ProjectConfigSchema = z
  .object({
    $schema: z.string().optional(),
    schemaVersion: z.literal(SCHEMA_VERSION),
    name: z.string().min(1),
    kind: ProjectKindSchema.optional(),
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
    editing: z
      .strictObject({
        /** Default cut/trim snap half-width, seconds; per-operation `snapWindow` overrides. */
        snapWindow: z
          .number()
          .min(MIN_SNAP_WINDOW_S, {
            error: (issue) =>
              `snap window ${String(issue.input)} s is below the ${MIN_SNAP_WINDOW_S} s minimum (word timestamps can be off by 500 ms, ADR 0003). ${snapWindowFix}`,
          })
          .max(MAX_SNAP_WINDOW_S, {
            error: (issue) => `snap window ${String(issue.input)} s is above the ${MAX_SNAP_WINDOW_S} s maximum. ${snapWindowFix}`,
          })
          .optional()
          .describe(
            "Default search half-width for moving cut and trim edges into audio pauses, seconds, 0.5 to 10. " +
              "Default 0.5. A `snapWindow` passed to an operation (CLI `--snap-window`) overrides it.",
          ),
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
