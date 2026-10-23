import { z } from "zod";
import { DIRECTOR_SCHEMA_URL, DirectorFileSchema } from "./director.js";
import { PEOPLE_SCHEMA_URL, PeopleFileSchema } from "./people.js";
import { PLUGIN_MANIFEST_SCHEMA_URL, PluginManifestSchema } from "./plugin.js";
import { PROJECT_SCHEMA_URL, ProjectConfigSchema } from "./project.js";
import { TIMELINE_SCHEMA_URL, TimelineSchema } from "./timeline.js";
import { TRANSCRIPT_SCHEMA_URL, TranscriptSchema } from "./transcript.js";

/**
 * JSON Schema (draft 2020-12) for every published file type, keyed by file
 * name under `packages/schema/json-schema/`. Describes files as written on
 * disk, so fields with Zod defaults stay optional.
 */
export function generateJsonSchemas(): Record<string, object> {
  const toJson = (schema: z.ZodType, id: string): object => ({
    ...z.toJSONSchema(schema, { target: "draft-2020-12", io: "input" }),
    $id: id,
  });
  return {
    "project.json": toJson(ProjectConfigSchema, PROJECT_SCHEMA_URL),
    "timeline.json": toJson(TimelineSchema, TIMELINE_SCHEMA_URL),
    "plugin.json": toJson(PluginManifestSchema, PLUGIN_MANIFEST_SCHEMA_URL),
    "transcript.json": toJson(TranscriptSchema, TRANSCRIPT_SCHEMA_URL),
    "director.json": toJson(DirectorFileSchema, DIRECTOR_SCHEMA_URL),
    "people.json": toJson(PeopleFileSchema, PEOPLE_SCHEMA_URL),
  };
}
