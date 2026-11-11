/**
 * `@frameshell/blender`: the official clip adapter for Blender scenes (ADR 0035). Uses only the public plugin
 * API: Blender is the person's own install (`binaries.blender`), the host supplies the managed ffmpeg and
 * caches what `render` returns.
 */
import type { PluginApi } from "@frameshell/plugin-api";
import { createBlenderAdapter } from "./adapter.js";

export { type BlenderAdapterOptions, type BlenderProps, CLIP_TYPE, createBlenderAdapter, describeRefusal, frameCount, propsSchema, sourceOf } from "./adapter.js";
export { type BlenderEvent, SUPPORTED_BLENDER, VersionProbe, parseBlenderVersion, runBlender, scriptPath, supportedBlender } from "./blender.js";
export { BlendDeps, STATE_DIR, insideProject } from "./deps.js";

/** Plugin entry point: registers the `blender` clip type. */
export function activate(api: PluginApi): void {
  api.registerClipType(createBlenderAdapter({ projectDir: api.project.dir }));
}
