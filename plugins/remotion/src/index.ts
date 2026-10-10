/**
 * `@frameshell/remotion`: the official clip adapter for Remotion
 * compositions (ADR 0009). Uses only the public plugin API: Remotion itself
 * comes from the user's Remotion project, the host supplies the managed
 * headless Chrome, and caches what `render` returns.
 */
import type { PluginApi } from "@frameshell/plugin-api";
import { createRemotionAdapter } from "./adapter.js";
import { newComposition } from "./scaffold.js";

export { CLIP_TYPE, type RemotionAdapterOptions, type RemotionProps, createRemotionAdapter, fastVp9, fitToProject, propsSchema } from "./adapter.js";
export { BUNDLE_DIR, BundleCache, type Bundle, type BundleCacheOptions } from "./bundles.js";
export {
  type BundlerOverride,
  NO_CONFIG,
  type RemotionProjectConfig,
  type WebpackOverride,
  loadProjectConfig,
  type RemotionBundler,
  type RemotionComposition,
  type RemotionLoader,
  type RemotionModules,
  type RemotionRenderProgress,
  type RemotionRenderer,
  type WebpackConfig,
  findRemotionRoot,
  loadProjectRemotion,
} from "./remotion.js";
export { PROJECT_DIR, REACT_VERSION, REMOTION_VERSION, newComposition } from "./scaffold.js";

/** Plugin entry point: registers the `remotion` clip type and `frameshell remotion new`. */
export function activate(api: PluginApi): void {
  api.registerClipType(createRemotionAdapter({ projectDir: api.project.dir, refreshRenders: () => api.refreshRenders() }));
  api.registerCommand("remotion new", newComposition);
}
