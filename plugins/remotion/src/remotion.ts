import { readFile, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, join } from "node:path";
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

/** A webpack override, as `Config.overrideWebpackConfig` takes it. */
export type WebpackOverride = (config: WebpackConfig) => WebpackConfig | Promise<WebpackConfig>;

/** A bundler override, as `Config.overrideBundlerConfig` takes it. */
export type BundlerOverride = (config: WebpackConfig, context: { bundler: "webpack" | "rspack" }) => WebpackConfig | Promise<WebpackConfig>;

/** The part of `@remotion/bundler` the adapter calls. */
export interface RemotionBundler {
  bundle(options: {
    entryPoint: string;
    rootDir: string;
    outDir: string;
    enableCaching: boolean;
    onProgress?: (percent: number) => void;
    webpackOverride?: WebpackOverride;
    bundlerOverride?: BundlerOverride;
  }): Promise<string>;
}

/**
 * What the Remotion project's `remotion.config.ts` (or `.js`) sets that
 * changes a Frameshell render. Output settings (codec, image format, CRF)
 * are ignored: Frameshell always renders PNG frames to VP9 with alpha.
 */
export interface RemotionProjectConfig {
  /** Absolute config file; null when the project has none. */
  file: string | null;
  /** `Config.overrideWebpackConfig`, e.g. Tailwind via `@remotion/tailwind-v4`; null when unset. */
  webpackOverride: WebpackOverride | null;
  /** `Config.overrideBundlerConfig`; null when unset. */
  bundlerOverride: BundlerOverride | null;
  /** `Config.setChromiumOpenGlRenderer`, e.g. `angle`; null when unset. */
  gl: string | null;
}

/** A project without `remotion.config.*`. */
export const NO_CONFIG: RemotionProjectConfig = { file: null, webpackOverride: null, bundlerOverride: null, gl: null };

/** The part of `@remotion/renderer` the adapter calls. */
export interface RemotionRenderer {
  selectComposition(options: {
    serveUrl: string;
    id: string;
    inputProps: Record<string, unknown>;
    browserExecutable: string;
    chromeMode: "headless-shell";
    chromiumOptions: { gl?: string };
    logLevel: "error";
  }): Promise<RemotionComposition>;
  getCompositions(
    serveUrl: string,
    options: { inputProps: Record<string, unknown>; browserExecutable: string; chromeMode: "headless-shell"; chromiumOptions: { gl?: string }; logLevel: "error" },
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
    chromiumOptions: { gl?: string };
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
  /** What the project's `remotion.config.*` sets, read when the modules were loaded. */
  config: RemotionProjectConfig;
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
  return { root, version, bundler, renderer, config: await loadProjectConfig(root, version) };
};

/** Config file names Remotion's CLI looks for in the project root, in its order. */
const CONFIG_FILES = ["remotion.config.ts", "remotion.config.js"];

/** Loads are serialized per `@remotion/cli` copy: its config is module state, reset before each load. */
const configLocks = new Map<string, Promise<unknown>>();

/**
 * Read the project's `remotion.config.*` the way Remotion's CLI does: the
 * project's own `@remotion/cli` compiles and runs it, then its config state
 * is read back. Remotion has no public API for this, so it uses the CLI's
 * internals (`dist/load-config.js`, `ConfigInternals`), present in every
 * Remotion 4 release the adapter was checked against (4.0.500, 4.0.527).
 * Never `CliInternals.loadConfig`: it exits the process on a config error.
 * Throws with the fix when the file cannot be loaded.
 */
export async function loadProjectConfig(root: string, version: string | null): Promise<RemotionProjectConfig> {
  let file: string | null = null;
  for (const name of CONFIG_FILES) {
    if (await stat(join(root, name)).then((info) => info.isFile(), () => false)) {
      file = join(root, name);
      break;
    }
  }
  if (file === null) return NO_CONFIG;
  const name = basename(file);
  const require = createRequire(join(root, "package.json"));
  let cliDir: string;
  try {
    cliDir = dirname(require.resolve("@remotion/cli/package.json"));
  } catch {
    throw new Error(
      `The Remotion project ${root} has ${name}, which only @remotion/cli can read. Install it there next to remotion, same version: ` +
        `\`npm install @remotion/cli${version ? `@${version}` : ""}\`.`,
    );
  }
  const previous = configLocks.get(cliDir) ?? Promise.resolve();
  const run = previous.then(
    () => readConfig(root, file, cliDir),
    () => readConfig(root, file, cliDir),
  );
  configLocks.set(cliDir, run.catch(() => {}));
  return run;
}

/** The CLI internals {@link loadProjectConfig} calls. */
interface CliConfigInternals {
  loadConfigFile(root: string, file: string, isJavascript: boolean): Promise<unknown>;
  ConfigInternals: {
    resetConfigOptions(): void;
    getWebpackOverrideFn(): WebpackOverride;
    defaultOverrideFunction: WebpackOverride;
    getBundlerOverrideFn?(): BundlerOverride;
    defaultBundlerOverrideFunction?: BundlerOverride;
  };
  glOption: { getValue(options: { commandLine: Record<string, unknown> }): { value: string | null; source: string } };
}

async function readConfig(root: string, file: string, cliDir: string): Promise<RemotionProjectConfig> {
  const name = basename(file);
  let internals: CliConfigInternals;
  try {
    const fromCli = createRequire(join(cliDir, "package.json"));
    const [loader, config, client] = await Promise.all([
      import(pathToFileURL(join(cliDir, "dist", "load-config.js")).href) as Promise<{ loadConfigFile: CliConfigInternals["loadConfigFile"] }>,
      import(pathToFileURL(join(cliDir, "dist", "config", "index.js")).href) as Promise<{ ConfigInternals: CliConfigInternals["ConfigInternals"] }>,
      import(pathToFileURL(fromCli.resolve("@remotion/renderer/client")).href) as Promise<{
        BrowserSafeApis: { options: { glOption: CliConfigInternals["glOption"] } };
      }>,
    ]);
    if (typeof loader.loadConfigFile !== "function" || typeof config.ConfigInternals?.getWebpackOverrideFn !== "function") throw new Error("missing exports");
    internals = { loadConfigFile: loader.loadConfigFile, ConfigInternals: config.ConfigInternals, glOption: client.BrowserSafeApis.options.glOption };
  } catch (error) {
    throw new Error(
      `@frameshell/remotion cannot read ${name} with this @remotion/cli (${cliDir}): its internals changed (${(error as Error).message}). ` +
        "Report it at https://github.com/ThomasPraun/frameshell/issues, with your Remotion version.",
      { cause: error },
    );
  }
  const { ConfigInternals } = internals;
  ConfigInternals.resetConfigOptions();
  try {
    await internals.loadConfigFile(root, name, name.endsWith(".js"));
  } catch (error) {
    throw new Error(`${file} failed to load: ${(error as Error).message}`, { cause: error });
  }
  const webpackOverride = ConfigInternals.getWebpackOverrideFn();
  const bundlerOverride = ConfigInternals.getBundlerOverrideFn?.() ?? null;
  const gl = internals.glOption.getValue({ commandLine: {} });
  return {
    file,
    webpackOverride: webpackOverride === ConfigInternals.defaultOverrideFunction ? null : webpackOverride,
    bundlerOverride: bundlerOverride === null || bundlerOverride === ConfigInternals.defaultBundlerOverrideFunction ? null : bundlerOverride,
    gl: gl.source === "config" ? gl.value : null,
  };
}
