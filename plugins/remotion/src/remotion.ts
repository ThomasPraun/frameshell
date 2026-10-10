import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

/** The part of a Remotion composition's metadata the adapter reads and overrides. */
export interface RemotionComposition {
  id: string;
  width: number;
  height: number;
  fps: number;
  durationInFrames: number;
  [key: string]: unknown;
}

/** Progress report of `renderMedia`. */
export interface RemotionRenderProgress {
  progress: number;
  renderedFrames?: number;
  encodedFrames?: number;
  stitchStage?: string;
}

/** The part of `@remotion/bundler` the adapter calls. */
export interface RemotionBundler {
  bundle(options: {
    entryPoint: string;
    rootDir: string;
    outDir: string;
    enableCaching: boolean;
    onProgress?: (percent: number) => void;
    webpackOverride?: (config: WebpackConfig) => WebpackConfig;
  }): Promise<string>;
}

/** The part of `@remotion/renderer` the adapter calls. */
export interface RemotionRenderer {
  selectComposition(options: {
    serveUrl: string;
    id: string;
    inputProps: Record<string, unknown>;
    browserExecutable: string;
    chromeMode: "headless-shell";
    logLevel: "error";
  }): Promise<RemotionComposition>;
  getCompositions(
    serveUrl: string,
    options: { inputProps: Record<string, unknown>; browserExecutable: string; chromeMode: "headless-shell"; logLevel: "error" },
  ): Promise<RemotionComposition[]>;
  renderMedia(options: {
    composition: RemotionComposition;
    serveUrl: string;
    codec: "vp9";
    imageFormat: "png";
    pixelFormat: "yuva420p";
    outputLocation: string;
    inputProps: Record<string, unknown>;
    browserExecutable: string;
    chromeMode: "headless-shell";
    muted: true;
    overwrite: true;
    scale: number;
    logLevel: "error";
    cancelSignal: unknown;
    onProgress: (progress: RemotionRenderProgress) => void;
    ffmpegOverride: (info: { type: "pre-stitcher" | "stitcher"; args: string[] }) => string[];
  }): Promise<unknown>;
  makeCancelSignal(): { cancelSignal: unknown; cancel: () => void };
}

/** Webpack configuration as `webpackOverride` sees it; only `plugins` is touched. */
export interface WebpackConfig {
  plugins?: unknown[];
  [key: string]: unknown;
}

/** Remotion packages of one Remotion project, and where that project lives. */
export interface RemotionModules {
  /** Absolute directory of the `package.json` that depends on `remotion`. */
  root: string;
  /** `remotion` version the project resolves, for messages. */
  version: string | null;
  bundler: RemotionBundler;
  renderer: RemotionRenderer;
}

/** Loads the Remotion packages of the project rooted at `root`. Injected by tests. */
export type RemotionLoader = (root: string) => Promise<RemotionModules>;

/**
 * Directory of the nearest `package.json` at or above `dir` that lists
 * `remotion` in `dependencies` or `devDependencies`: the Remotion project
 * the entry belongs to. Null when none does.
 */
export async function findRemotionRoot(dir: string): Promise<string | null> {
  for (let current = dir; ; current = dirname(current)) {
    const pkg = await readFile(join(current, "package.json"), "utf8").then(
      (text) => JSON.parse(text) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> },
      () => null,
    );
    if (pkg && (pkg.dependencies?.["remotion"] || pkg.devDependencies?.["remotion"])) return current;
    if (dirname(current) === current) return null;
  }
}

/**
 * Default {@link RemotionLoader}: resolves `@remotion/bundler` and
 * `@remotion/renderer` from the Remotion project itself, never from this
 * plugin (ADR 0009). The user's Remotion version and licence apply. Throws
 * with the install command when a package is missing.
 */
export const loadProjectRemotion: RemotionLoader = async (root) => {
  const require = createRequire(join(root, "package.json"));
  const version = (() => {
    try {
      return (require("remotion/package.json") as { version?: string }).version ?? null;
    } catch {
      return null;
    }
  })();
  const load = async <T>(name: string): Promise<T> => {
    let path: string;
    try {
      path = require.resolve(name);
    } catch {
      const at = version ? `@${version}` : "";
      throw new Error(
        `The Remotion project ${root} cannot resolve ${name}. Install it there next to remotion, same version: ` +
          `\`npm install @remotion/bundler${at} @remotion/renderer${at}\` (and \`npm install\` if node_modules is missing).`,
      );
    }
    return (await import(pathToFileURL(path).href)) as T;
  };
  const [bundler, renderer] = await Promise.all([load<RemotionBundler>("@remotion/bundler"), load<RemotionRenderer>("@remotion/renderer")]);
  return { root, version, bundler, renderer };
};
