export { SCHEMA_VERSION, type ParseResult } from "./common.js";
export {
  PROJECT_SCHEMA_URL,
  ProjectConfigSchema,
  type ProjectConfig,
  parseProjectConfig,
  createProjectConfig,
} from "./project.js";
export {
  TIMELINE_SCHEMA_URL,
  TimelineSchema,
  type Timeline,
  parseTimeline,
  createTimeline,
} from "./timeline.js";
export { generateJsonSchemas } from "./json-schema.js";
export {
  PLUGIN_MANIFEST_FILE,
  PLUGIN_MANIFEST_SCHEMA_URL,
  BUILTIN_COMMANDS,
  PluginNameSchema,
  PluginManifestSchema,
  type PluginManifest,
  parsePluginManifest,
  ExportPresetSchema,
  type ExportPreset,
  parseExportPreset,
} from "./plugin.js";
