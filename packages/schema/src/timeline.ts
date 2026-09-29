import { z } from "zod";
import { SCHEMA_VERSION, type ParseResult, formatIssues } from "./common.js";

/** Canonical `$schema` URL for `timelines/*.json`. */
export const TIMELINE_SCHEMA_URL = `https://frameshell.dev/schema/v${SCHEMA_VERSION}/timeline.json`;

/**
 * Track shell only: id and kind. Clip models land with the operation engine,
 * so extra keys pass through untouched until then.
 */
const TrackSchema = z.looseObject({
  id: z.string().min(1),
  kind: z.enum(["video", "audio", "subtitles"]),
  name: z.string().optional(),
});

/**
 * Zod model of a timeline file (SPEC §5.3). `revision` guards direct edits
 * (SPEC §6.4); duration is derived, never stored.
 */
export const TimelineSchema = z.strictObject({
  $schema: z.string().optional(),
  schemaVersion: z.literal(SCHEMA_VERSION),
  id: z.string().min(1),
  revision: z.int().nonnegative(),
  tracks: z.array(TrackSchema),
});

/** Validated timeline file content. */
export type Timeline = z.infer<typeof TimelineSchema>;

/** Validate unknown input as a timeline. Never throws. */
export function parseTimeline(input: unknown): ParseResult<Timeline> {
  const result = TimelineSchema.safeParse(input);
  return result.success
    ? { ok: true, value: result.data }
    : { ok: false, error: formatIssues(result.error) };
}

/** Empty timeline at revision 0, as written by `frameshell init`. */
export function createTimeline(id: string): Timeline {
  return { $schema: TIMELINE_SCHEMA_URL, schemaVersion: SCHEMA_VERSION, id, revision: 0, tracks: [] };
}
