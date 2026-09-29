import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { PluginPins } from "@frameshell/protocol";
import { readJsonIfExists, writeJsonAtomic } from "../fs-util.js";
import type { PluginSpec } from "./spec.js";

/** Records which pins the directory holds, so a load knows when to reinstall. */
const MARKER = ".frameshell-pins.json";

/** npm failure; `output` is the tail of its stderr. */
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
 *
 * Runs npm, so it executes package install scripts: callers gate every
 * method that installs behind project trust.
 */
export class PluginStore {
  constructor(readonly dir: string) {}

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
   * the resolved commit for git sources, the exact version for npm ones.
   * Does not mark the result synced; callers do after validating the package.
   */
  async add(pins: PluginPins, spec: PluginSpec): Promise<{ name: string; pin: string }> {
    await this.#writeManifest(pins);
    await npm(["install", "--save", "--save-exact", spec.spec], this.dir);
    const saved = await this.#dependencies();
    const name = installedName(pins, saved, spec);
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

  async #writeManifest(pins: PluginPins): Promise<void> {
    await writeJsonAtomic(join(this.dir, "package.json"), {
      name: "frameshell-project-plugins",
      private: true,
      description: "Generated from frameshell.json plugin pins. Regenerable; do not edit.",
      dependencies: pins,
    });
  }

  async #dependencies(): Promise<Record<string, string>> {
    const pkg = JSON.parse(await readFile(join(this.dir, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    return pkg.dependencies ?? {};
  }
}

/** The dependency npm added or changed; falls back to the spec itself when nothing changed (reinstall). */
function installedName(pins: PluginPins, saved: Record<string, string>, spec: PluginSpec): string {
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
