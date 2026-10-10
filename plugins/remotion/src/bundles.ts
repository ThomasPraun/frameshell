import { createHash, randomBytes } from "node:crypto";
import { type FSWatcher, watch } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import type { RemotionLoader, RemotionModules, WebpackConfig } from "./remotion.js";

/** Project-relative directory of the bundles; under `.frameshell/`, so the project watcher never reacts to a bundle. */
export const BUNDLE_DIR = ".frameshell/remotion";

/** Bundles kept per entry: the current one plus older ones a running render may still serve. */
const KEEP = 3;

/** Quiet time after the last change outside the project before asking the host to refresh. */
const OUTSIDE_DEBOUNCE_MS = 200;

/** A bundle on disk and what it was built from. */
export interface Bundle {
  /** Absolute directory, served by Remotion (`serveUrl`). */
  dir: string;
  /** Project-relative, `/`-separated path of its `index.html`. The directory name is the content hash. */
  marker: string;
  /** The Remotion packages of the entry's project. */
  remotion: RemotionModules;
}

/** Size and mtime of one file the bundle was built from; null when it was missing. */
type Stamp = { size: number; mtimeMs: number } | null;

interface EntryState {
  bundle: Bundle;
  /** Every file webpack read, with its stamp at bundle time. */
  deps: Map<string, Stamp>;
  /** Watchers on directories outside the project that hold dependencies. */
  watchers: FSWatcher[];
}

/** Options for {@link BundleCache}. */
export interface BundleCacheOptions {
  projectDir: string;
  loadRemotion: RemotionLoader;
  /** Finds the Remotion project of an absolute entry file; null when there is none. */
  findRoot(entry: string): Promise<string | null>;
  /** Called when a dependency outside the project changed; see `PluginApi.refreshRenders`. */
  onOutsideChange?: () => void;
}

/**
 * Remotion bundles of a project, one current bundle per entry file
 * (ADR 0009). A bundle lives in `.frameshell/remotion/<entry>/<content hash>/`,
 * so its path names its content: the adapter reports that path as the clip's
 * cache input, and any change to code the bundle includes, inside the project
 * or not, gives a new path and so a new render. An entry is re-bundled only
 * when a file webpack read changed size or mtime. Directories outside the
 * project that hold such files are watched, so edits there reach the host
 * through `onOutsideChange`.
 */
export class BundleCache {
  readonly #options: BundleCacheOptions;
  readonly #entries = new Map<string, EntryState>();
  readonly #running = new Map<string, Promise<Bundle>>();
  #timer: NodeJS.Timeout | undefined;

  constructor(options: BundleCacheOptions) {
    this.#options = options;
  }

  /**
   * The current bundle of `entry` (absolute), bundling first when there is
   * none or a dependency changed. Concurrent calls for one entry share one
   * check and bundle.
   */
  get(entry: string, onProgress?: (fraction: number) => void): Promise<Bundle> {
    const running = this.#running.get(entry);
    if (running) return running;
    const work = this.#get(entry, onProgress).finally(() => this.#running.delete(entry));
    this.#running.set(entry, work);
    return work;
  }

  /** Stop every watcher. Bundles on disk stay. */
  close(): void {
    clearTimeout(this.#timer);
    for (const state of this.#entries.values()) for (const watcher of state.watchers) watcher.close();
    this.#entries.clear();
  }

  async #get(entry: string, onProgress?: (fraction: number) => void): Promise<Bundle> {
    const known = this.#entries.get(entry);
    if (known && !(await changed(known.deps)) && (await exists(join(known.bundle.dir, "index.html")))) return known.bundle;
    const root = await this.#options.findRoot(entry);
    if (root === null) {
      throw new Error(
        `${entry} is not inside a Remotion project: no package.json at or above it lists remotion. ` +
          "Create one with `frameshell remotion new <name>`, or point source at the entry of an existing Remotion project.",
      );
    }
    const remotion = await this.#options.loadRemotion(root);
    const built = await this.#bundle(entry, remotion, onProgress);
    if (known) for (const watcher of known.watchers) watcher.close();
    this.#entries.set(entry, { ...built, watchers: this.#watch(built.deps) });
    return built.bundle;
  }

  async #bundle(entry: string, remotion: RemotionModules, onProgress?: (fraction: number) => void) {
    const { projectDir } = this.#options;
    const entryDir = join(projectDir, ...BUNDLE_DIR.split("/"), hash(relative(projectDir, entry).split(sep).join("/")).slice(0, 16));
    const temp = join(entryDir, `.tmp-${randomBytes(4).toString("hex")}`);
    await mkdir(entryDir, { recursive: true });
    let found: Dependencies = { files: [], missing: [] };
    try {
      const { config } = remotion;
      const record = (webpack: WebpackConfig): WebpackConfig => ({
        ...webpack,
        plugins: [...(webpack.plugins ?? []), dependencyRecorder((recorded) => (found = recorded))],
      });
      await remotion.bundler.bundle({
        entryPoint: entry,
        rootDir: remotion.root,
        outDir: temp,
        enableCaching: true,
        onProgress: (percent) => onProgress?.(Math.min(1, Math.max(0, percent / 100))),
        // The project's own override first (Tailwind, aliases), as Remotion's CLI applies it; the recorder sees its result.
        webpackOverride: async (webpack: WebpackConfig) => record(config.webpackOverride ? await config.webpackOverride(webpack) : webpack),
        ...(config.bundlerOverride ? { bundlerOverride: config.bundlerOverride } : {}),
      });
      // The config file counts too: its render settings (OpenGL renderer) change pixels without changing the bundle.
      const content = hash(`${await dirHash(temp)}\0${config.file ? hash(await readFile(config.file).catch(() => "")) : ""}`).slice(0, 32);
      const dir = join(entryDir, content);
      if (await exists(join(dir, "index.html"))) {
        await rm(temp, { recursive: true, force: true });
      } else {
        await rm(dir, { recursive: true, force: true });
        await rename(temp, dir);
      }
      await prune(entryDir, content);
      // Read files with their stamps, plus paths webpack probed and missed: one appearing can change resolution.
      // Directories in webpack's file list are dropped; their files are listed themselves.
      const deps = new Map<string, Stamp>();
      await Promise.all([
        ...found.files.map(async (file) => {
          const stamp = await stampOf(file);
          if (stamp !== null) deps.set(file, stamp);
        }),
        ...found.missing.map(async (path) => {
          if (!(await exists(path))) deps.set(path, null);
        }),
      ]);
      // Webpack never reads remotion.config.*, and a project without one may gain one: both re-bundle.
      for (const name of ["remotion.config.ts", "remotion.config.js"]) {
        const path = join(remotion.root, name);
        deps.set(path, await stampOf(path));
      }
      const marker = relative(projectDir, join(dir, "index.html")).split(sep).join("/");
      return { bundle: { dir, marker, remotion }, deps };
    } catch (error) {
      await rm(temp, { recursive: true, force: true });
      throw error;
    }
  }

  /** Watch directories outside the project that hold dependencies, skipping installed packages. */
  #watch(deps: Map<string, Stamp>): FSWatcher[] {
    const { projectDir, onOutsideChange } = this.#options;
    if (!onOutsideChange) return [];
    const dirs = new Set<string>();
    for (const file of deps.keys()) {
      const rel = relative(projectDir, file);
      const outside = rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
      if (outside && !file.split(sep).includes("node_modules")) dirs.add(dirname(file));
    }
    const watchers: FSWatcher[] = [];
    for (const dir of dirs) {
      try {
        const watcher = watch(dir, { persistent: false }, () => this.#outsideChanged());
        // A vanished directory must not crash the daemon; the next refresh re-bundles and re-watches.
        watcher.on("error", () => watcher.close());
        watchers.push(watcher);
      } catch {
        // Unwatchable (gone, no permission): changes there are still seen on the next refresh.
      }
    }
    return watchers;
  }

  #outsideChanged(): void {
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => this.#options.onOutsideChange?.(), OUTSIDE_DEBOUNCE_MS);
    this.#timer.unref?.();
  }
}

/** What a compilation read (`files`) and looked for without finding (`missing`). */
interface Dependencies {
  files: string[];
  missing: string[];
}

/** Webpack compilation fields the recorder reads. */
interface CompilationDeps {
  fileDependencies: Iterable<string>;
  missingDependencies?: Iterable<string>;
}

/** Webpack plugin that reports the compilation's file and missing dependencies, as webpack's own watch mode uses them. */
function dependencyRecorder(report: (deps: Dependencies) => void) {
  return {
    apply(compiler: { hooks: { done: { tap(name: string, fn: (stats: { compilation: CompilationDeps }) => void): void } } }) {
      compiler.hooks.done.tap("frameshell-remotion-deps", ({ compilation }) =>
        report({ files: [...compilation.fileDependencies], missing: [...(compilation.missingDependencies ?? [])] }),
      );
    },
  };
}

/** True when any file changed size or mtime, appeared or vanished since its stamp. */
async function changed(deps: Map<string, Stamp>): Promise<boolean> {
  const checks = await Promise.all(
    [...deps].map(async ([file, before]) => {
      const now = await stampOf(file);
      return now === null || before === null ? now !== before : now.size !== before.size || now.mtimeMs !== before.mtimeMs;
    }),
  );
  return checks.some(Boolean);
}

async function stampOf(file: string): Promise<Stamp> {
  const info = await stat(file).catch(() => null);
  return info?.isFile() ? { size: info.size, mtimeMs: info.mtimeMs } : null;
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

/** 32 hex digits of a SHA-256 over every file of `dir` (relative path and content), path-sorted. */
async function dirHash(dir: string): Promise<string> {
  const files = (await readdir(dir, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)).split(sep).join("/"))
    .sort();
  const digest = createHash("sha256");
  for (const file of files) digest.update(`${file}\0`).update(hash(await readFile(join(dir, ...file.split("/"))))).update("\0");
  return digest.digest("hex").slice(0, 32);
}

function hash(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Remove bundles of one entry beyond the {@link KEEP} newest, never `current`, plus leftover temps. */
async function prune(entryDir: string, current: string): Promise<void> {
  const entries = await readdir(entryDir, { withFileTypes: true }).catch(() => []);
  const bundles: { name: string; mtimeMs: number }[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === current) continue;
    const info = await stat(join(entryDir, entry.name)).catch(() => null);
    if (!info) continue;
    // A temp older than a minute belongs to a bundle that died with its daemon.
    if (entry.name.startsWith(".tmp-")) {
      if (Date.now() - info.mtimeMs > 60_000) await rm(join(entryDir, entry.name), { recursive: true, force: true });
      continue;
    }
    bundles.push({ name: entry.name, mtimeMs: info.mtimeMs });
  }
  bundles.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const old of bundles.slice(KEEP - 1)) await rm(join(entryDir, old.name), { recursive: true, force: true });
}
