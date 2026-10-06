import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tempDir } from "./helpers.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/hello-plugin/", import.meta.url));

/** Local git repo holding a copy of the hello-plugin fixture. */
export interface GitPlugin {
  /** Install spec: `git+file://…`. No network involved. */
  spec: string;
  /** Commit the repo's HEAD points at. */
  sha: string;
  dir: string;
}

/**
 * Commit the hello-plugin fixture to a fresh local git repo.
 * `manifest` is shallow-merged into `frameshell-plugin.json` to build broken variants.
 */
export function gitPluginFixture(manifest: Record<string, unknown> = {}): GitPlugin {
  const dir = join(tempDir(), "hello-plugin");
  cpSync(FIXTURE, dir, { recursive: true });
  const manifestPath = join(dir, "frameshell-plugin.json");
  const merged = { ...JSON.parse(readFileSync(manifestPath, "utf8")), ...manifest };
  writeFileSync(manifestPath, `${JSON.stringify(merged, null, 2)}\n`);
  return commitFixture(dir);
}

/** Commit everything in `dir` to a fresh local git repo; installable as `git+file://…`. */
export function commitFixture(dir: string): GitPlugin {
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args], {
      cwd: dir,
      encoding: "utf8",
    }).trim();
  git("init", "-q");
  git("add", "-A");
  git("commit", "-q", "-m", "fixture");
  return { spec: `git+${pathToFileURL(dir).href}`, sha: git("rev-parse", "HEAD"), dir };
}

/**
 * `npm pack` a copy of the hello-plugin fixture into `dest`; returns the tarball path.
 * `pkg` is shallow-merged into its `package.json`, so variants pack different bytes.
 */
export function tarballPluginFixture(dest: string, pkg: Record<string, unknown> = {}): string {
  const dir = join(tempDir(), "hello-plugin");
  cpSync(FIXTURE, dir, { recursive: true });
  const pkgPath = join(dir, "package.json");
  writeFileSync(pkgPath, `${JSON.stringify({ ...JSON.parse(readFileSync(pkgPath, "utf8")), ...pkg }, null, 2)}\n`);
  mkdirSync(dest, { recursive: true });
  const out = execFileSync("npm", ["pack", "--pack-destination", dest, "--loglevel=error"], {
    cwd: dir,
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  return join(dest, out.trim().split(/\r?\n/).pop()!);
}

/**
 * Place a plugin directory into `project` as if `frameshell plugin install`
 * had installed it, without npm: pin it in `frameshell.json` and mark the
 * install directory synced. The project still needs `project.trust`.
 */
export function installLocalPlugin(project: string, pluginDir: string, name: string): void {
  const pins = { [name]: `file:${name}` };
  const configPath = join(project, "frameshell.json");
  const config = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
  writeFileSync(configPath, `${JSON.stringify({ ...config, plugins: pins }, null, 2)}\n`);
  const store = join(project, ".frameshell", "plugins");
  cpSync(pluginDir, join(store, "node_modules", ...name.split("/")), { recursive: true });
  writeFileSync(join(store, "package.json"), JSON.stringify({ name: "frameshell-project-plugins", private: true, dependencies: pins }));
  writeFileSync(join(store, ".frameshell-pins.json"), JSON.stringify(pins));
}

/** Directory of the `card` clip adapter fixture: flat colour cards rendered by ffmpeg. */
export const CARD_PLUGIN = fileURLToPath(new URL("./fixtures/card-plugin/", import.meta.url));
