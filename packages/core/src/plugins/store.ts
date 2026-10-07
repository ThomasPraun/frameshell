import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { copyFile, mkdir, readFile, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { PluginPins } from "@frameshell/protocol";
import { readJsonIfExists, writeJsonAtomic } from "../fs-util.js";
import { type PluginSpec, formatTarballPin, parseTarballPin } from "./spec.js";

/** Records which pins the directory holds, so a load knows when to reinstall. */
const MARKER = ".frameshell-pins.json";

/** Project folder that receives tarballs installed from outside the project. */
const VENDOR = "vendor";

/** Install failure: npm failed (`output` = tail of its stderr), or a pinned tarball is missing or changed. */
export class NpmError extends Error {
  override readonly name = "NpmError";
  constructor(
    message: string,
    readonly output: string,
  ) {
    super(message);
  }
}

/**
 * Installed plugin packages of one project: `<project>/.frameshell/plugins`,
 * an npm prefix whose `package.json` dependencies mirror the pins in
 * `frameshell.json`. Regenerable at any time from those pins (SPEC §2).
 * Tarball pins (`file:<path>#sha256=…`) are project-relative (outside
 * tarballs are copied to `vendor/` first); every install
 * checks the file still has the pinned digest first.
 *
 * Runs npm, so it executes package install scripts: callers gate every
 * method that installs behind project trust.
 */
export class PluginStore {
  /** Project root: `dir` is always `<root>/.frameshell/plugins`. */
  readonly #root: string;

  constructor(readonly dir: string) {
    this.#root = resolve(dir, "..", "..");
  }

  /** Directory of an installed package. */
  packageDir(name: string): string {
    return join(this.dir, "node_modules", ...name.split("/"));
  }

  /** True when the last successful install matches `pins` exactly. */
  async isSynced(pins: PluginPins): Promise<boolean> {
    const marker = await readJsonIfExists(join(this.dir, MARKER)).catch(() => undefined);
    return samePins(marker, pins);
  }

  /** Install exactly `pins`, pruning everything else. Empty pins remove the directory. */
  async sync(pins: PluginPins): Promise<void> {
    if (Object.keys(pins).length === 0) {
      await rm(this.dir, { recursive: true, force: true });
      return;
    }
    await this.#writeManifest(pins);
    await npm(["install"], this.dir);
    await this.markSynced(pins);
  }

  /**
   * Install `spec` next to `pins` and work out its package name and pin:
   * the resolved commit for git sources, the exact version for npm ones, the
   * project-relative path and sha256 for tarballs (whose `path` must be
   * absolute by now). A tarball outside the project is first copied to
   * `<root>/vendor/<file>`, so the pin works in every clone that carries it.
   * Does not mark the result synced; callers do after validating the package.
   */
  async add(pins: PluginPins, spec: PluginSpec): Promise<{ name: string; pin: string }> {
    const written = await this.#writeManifest(pins);
    if (spec.kind === "tarball") {
      if (!isAbsolute(spec.path)) throw new Error(`tarball path must be absolute: ${spec.path}`);
      const digest = await sha256(spec.path);
      const { file, copied } = await this.#vendor(spec.path, digest);
      try {
        const dependency = this.#dependency(file);
        await npm(["install", "--save", "--save-exact", dependency], this.dir);
        const saved = await this.#dependencies();
        const changed = Object.keys(saved).filter((name) => saved[name] !== written[name]);
        const name = changed.length === 1 ? changed[0]! : Object.keys(saved).find((key) => saved[key] === dependency);
        if (!name) throw new NpmError(`Could not tell which package ${spec.spec} installed`, JSON.stringify(saved));
        return { name, pin: formatTarballPin(posix(relative(this.#root, file)), digest) };
      } catch (error) {
        if (copied) await rm(file, { force: true });
        throw error;
      }
    }
    await npm(["install", "--save", "--save-exact", spec.spec], this.dir);
    const saved = await this.#dependencies();
    const name = installedName(written, saved, spec);
    if (spec.kind === "npm") {
      const pkg = (await readJsonIfExists(join(this.packageDir(name), "package.json"))) as { version?: string } | undefined;
      if (!pkg?.version) throw new NpmError(`npm installed ${name} without a version`, "");
      return { name, pin: pkg.version };
    }
    const lock = (await readJsonIfExists(join(this.dir, "package-lock.json"))) as
      | { packages?: Record<string, { resolved?: string }> }
      | undefined;
    const resolved = lock?.packages?.[`node_modules/${name}`]?.resolved ?? "";
    const sha = /#([0-9a-f]{40})$/.exec(resolved)?.[1];
    if (!sha) throw new NpmError(`Could not find the commit npm resolved for ${spec.spec}`, resolved);
    return { name, pin: `${spec.base}#${sha}` };
  }

  /** Record that the directory now holds exactly `pins`. */
  async markSynced(pins: PluginPins): Promise<void> {
    await writeJsonAtomic(join(this.dir, MARKER), pins);
  }

  /** Write the npm manifest for `pins` and return its dependencies. Throws for a missing or changed tarball. */
  async #writeManifest(pins: PluginPins): Promise<Record<string, string>> {
    const dependencies: Record<string, string> = {};
    for (const [name, pin] of Object.entries(pins)) {
      const tarball = parseTarballPin(pin);
      if (!tarball) {
        dependencies[name] = pin;
        continue;
      }
      const file = resolve(this.#root, tarball.path);
      const actual = await sha256(file).catch(() => null);
      if (actual === null) throw new NpmError(`${name}: pinned tarball ${file} is missing`, "");
      if (actual !== tarball.sha256) {
        throw new NpmError(
          `${name}: pinned tarball ${file} changed since it was pinned (sha256 ${actual}, pin ${tarball.sha256}). ` +
            "Not installing code nobody trusted: reinstall it with `frameshell plugin install <tarball>` if you trust the new file.",
          "",
        );
      }
      dependencies[name] = this.#dependency(file);
    }
    await writeJsonAtomic(join(this.dir, "package.json"), {
      name: "frameshell-project-plugins",
      private: true,
      description: "Generated from frameshell.json plugin pins. Regenerable; do not edit.",
      dependencies,
    });
    return dependencies;
  }

  /** npm spec of a tarball, relative to this prefix like npm saves it. */
  #dependency(file: string): string {
    return `file:${posix(relative(this.dir, file))}`;
  }

  /**
   * Tarball inside the project: itself. Outside: copied to `vendor/<file>`;
   * an existing copy is reused only with the same digest, never overwritten.
   */
  async #vendor(file: string, digest: string): Promise<{ file: string; copied: boolean }> {
    const inside = relative(this.#root, file);
    if (!(inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside))) return { file, copied: false };
    const target = join(this.#root, VENDOR, basename(file));
    const existing = await sha256(target).catch(() => null);
    if (existing === digest) return { file: target, copied: false };
    if (existing !== null) {
      throw new NpmError(
        `${VENDOR}/${basename(file)} already exists with other content. Rename the tarball or remove the old copy first.`,
        "",
      );
    }
    await mkdir(dirname(target), { recursive: true });
    await copyFile(file, target);
    return { file: target, copied: true };
  }

  async #dependencies(): Promise<Record<string, string>> {
    const pkg = JSON.parse(await readFile(join(this.dir, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    return pkg.dependencies ?? {};
  }
}

/** The dependency npm added or changed; falls back to the spec itself when nothing changed (reinstall). */
function installedName(pins: PluginPins, saved: Record<string, string>, spec: Exclude<PluginSpec, { kind: "tarball" }>): string {
  const changed = Object.keys(saved).filter((name) => saved[name] !== pins[name]);
  if (changed.length === 1) return changed[0]!;
  if (changed.length === 0) {
    if (spec.kind === "npm") {
      if (spec.name in saved) return spec.name;
    } else {
      const match = Object.keys(saved).find((name) => saved[name] === spec.spec || saved[name]?.startsWith(`${spec.base}#`));
      if (match) return match;
    }
  }
  throw new NpmError(`Could not tell which package ${spec.spec} installed`, JSON.stringify(saved));
}

function posix(path: string): string {
  return path.split(sep).join("/");
}

async function sha256(file: string): Promise<string> {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}

function samePins(a: unknown, b: PluginPins): boolean {
  if (typeof a !== "object" || a === null) return false;
  const left = a as Record<string, unknown>;
  const keys = Object.keys(b);
  return Object.keys(left).length === keys.length && keys.every((key) => left[key] === b[key]);
}

/**
 * Run npm with the running Node. Prefers the npm bundled next to that Node,
 * so no shell (Windows `.cmd` shims need one) and no PATH lookup is involved.
 */
function npm(args: string[], cwd: string): Promise<void> {
  const flags = ["--no-audit", "--no-fund", "--loglevel=error", "--update-notifier=false"];
  const cli = bundledNpmCli();
  const child = cli
    ? spawn(process.execPath, [cli, ...args, ...flags], { cwd, windowsHide: true })
    : spawn("npm", [...args, ...flags], { cwd, windowsHide: true, shell: process.platform === "win32" });
  let stderr = "";
  child.stdout.resume();
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => (stderr = (stderr + chunk).slice(-4000)));
  return new Promise((resolve, reject) => {
    child.once("error", (error) => reject(new NpmError(`Could not run npm: ${error.message}`, stderr)));
    child.once("close", (code) => {
      if (code === 0) return resolve();
      const tail = stderr.trim().split("\n").slice(-12).join("\n");
      reject(new NpmError(`npm ${args[0]} failed (exit ${code})${tail ? `:\n${tail}` : ""}`, tail));
    });
  });
}

let npmCli: string | null | undefined;
function bundledNpmCli(): string | null {
  if (npmCli !== undefined) return npmCli;
  const bin = dirname(realpathSync(process.execPath));
  const candidates = [
    join(bin, "node_modules", "npm", "bin", "npm-cli.js"), // Windows layout
    join(bin, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"), // Unix layout
  ];
  npmCli = candidates.find((path) => existsSync(path)) ?? null;
  return npmCli;
}
