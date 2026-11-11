/**
 * `@frameshell/hyperframes`: the official clip adapter for HyperFrames HTML
 * compositions (SPEC §8.2, ADR 0002). Uses only the public plugin API: the
 * host supplies managed ffmpeg, ffprobe and headless Chrome through the
 * render context, and caches what `render` returns.
 */
import type { PluginApi } from "@frameshell/plugin-api";
import { createHyperframesAdapter } from "./adapter.js";
import { checkCompositions } from "./check.js";
import { newComposition } from "./scaffold.js";

export {
  CLIP_TYPE,
  type HyperframesAdapterOptions,
  type Producer,
  createHyperframesAdapter,
  propsSchema,
} from "./adapter.js";
export { type CheckFinding, type CheckReport, type CheckedComposition, checkCompositions } from "./check.js";
export { newComposition } from "./scaffold.js";

/** Plugin entry point: registers the `hyperframes` clip type, `frameshell hyperframes new` and `frameshell hyperframes check`. */
export function activate(api: PluginApi): void {
  api.registerClipType(createHyperframesAdapter({ projectDir: api.project.dir }));
  api.registerCommand("hyperframes new", newComposition);
  api.registerCommand("hyperframes check", checkCompositions);
}
