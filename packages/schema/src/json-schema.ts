import { z } from "zod";
import { BATCH_SCHEMA_URL, BatchFileSchema } from "./batch.js";
import { BEATS_SCHEMA_URL, BeatsFileSchema } from "./beats.js";
import { BRAND_SCHEMA_URL, BrandManifestSchema } from "./brand.js";
import { CREDITS_SCHEMA_URL, CreditsFileSchema } from "./credits.js";
import { DIRECTOR_SCHEMA_URL, DirectorFileSchema } from "./director.js";
import { PEOPLE_SCHEMA_URL, PeopleFileSchema } from "./people.js";
import { PLUGIN_MANIFEST_SCHEMA_URL, PluginManifestSchema } from "./plugin.js";
import { PROJECT_SCHEMA_URL, ProjectConfigSchema } from "./project.js";
import { REQUIREMENTS_SCHEMA_URL, RequirementsFileSchema } from "./requirements.js";
import { SHOOT_SCHEMA_URL, ShootFileSchema } from "./shoot.js";
import { STYLE_SCHEMA_URL, StyleFileSchema } from "./style.js";
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
    "shoot.json": toJson(ShootFileSchema, SHOOT_SCHEMA_URL),
    "style.json": toJson(StyleFileSchema, STYLE_SCHEMA_URL),
    "requirements.json": toJson(RequirementsFileSchema, REQUIREMENTS_SCHEMA_URL),
    "credits.json": toJson(CreditsFileSchema, CREDITS_SCHEMA_URL),
    "beats.json": toJson(BeatsFileSchema, BEATS_SCHEMA_URL),
    "batch.json": toJson(BatchFileSchema, BATCH_SCHEMA_URL),
    "brand.json": toJson(BrandManifestSchema, BRAND_SCHEMA_URL),
  };
}
