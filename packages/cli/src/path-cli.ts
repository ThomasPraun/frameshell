import { accessSync, closeSync, constants, openSync, readFileSync, readSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { cliShimName, parseCliShim } from "@frameshell/protocol";

/** Package name of the desktop app; the CLI it bundles sits in its `node_modules`. */
const APP_PACKAGE = "@frameshell/desktop";
/** Largest file read as a possible shim; a shim is one line. */
const MAX_SHIM_BYTES = 64 * 1024;
/** Where the desktop app installs the command, as its File menu names it. */
const INSTALL_HINT = "in the Frameshell app, File → Install 'frameshell' Command in PATH";

/** One `frameshell` CLI: where it lives and which release it is. */
export interface CliInstall {
  /** JS entry it runs (`…/@frameshell/cli/dist/bin/frameshell.js`). */
  entry: string;
  /**
   * Release version: the app's when the CLI ships inside the desktop app
   * (the CLI package itself is never versioned), else the CLI package's;
   * null when unreadable.
   */
  version: string | null;
  /** True when the CLI ships inside the desktop app. */
  app: boolean;
}

/** Which `frameshell` a shell here runs, compared with the CLI running now. */
export interface PathCliReport {
  /** First `frameshell` on PATH; null when there is none. */
  path: string | null;
  /** `path` with links resolved; equals `path` when it is no link. */
  target: string | null;
  /** The CLI `path` runs: an app shim's, or a CLI package's entry linked directly (npm, a source checkout). Null when unknown. */
  cli: CliInstall | null;
  /** The CLI running this command. */
  self: CliInstall;
  /** True when `path` runs this very CLI. */
  same: boolean;
  /** Advice for the human. Never a doctor problem: the exit code ignores it. */
  notes: string[];
}

/**
 * Describe the CLI package at `packageDir`. A CLI bundled in the desktop app
 * lives at `<app>/node_modules/@frameshell/cli` (inside `app.asar` when
 * packaged, which Electron's Node reads); its version is the app's
 * `package.json` version, which the release stamps.
 */
export function describeCliPackage(packageDir: string): CliInstall {
  const entry = join(packageDir, "dist", "bin", "frameshell.js");
  const own = readPackage(packageDir);
  const scope = dirname(packageDir);
  if (basename(scope) === "@frameshell" && basename(dirname(scope)) === "node_modules") {
    const app = readPackage(dirname(dirname(scope)));
    if (app?.name === APP_PACKAGE) return { entry, version: app.version ?? null, app: true };
  }
  return { entry, version: own?.name === "@frameshell/cli" ? (own.version ?? null) : null, app: false };
}

/**
 * Find the `frameshell` a shell with `env` runs and say whether it is
 * `self`. On Windows the candidates follow `PATHEXT` (the app's shim is
 * `frameshell.cmd`); elsewhere the first executable file named `frameshell`.
 */
export function inspectPathCli(self: CliInstall, env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): PathCliReport {
  const path = findCommand(env, platform);
  const report: PathCliReport = { path, target: null, cli: null, self, same: false, notes: [] };
  if (!path) {
    report.notes.push(`No \`frameshell\` on PATH. To run it from any terminal: ${INSTALL_HINT}.`);
    return report;
  }
  const target = realOrSelf(path);
  report.target = target;
  const shim = readShim(target);
  if (shim) {
    report.cli = describeCliPackage(dirname(dirname(dirname(shim.cliEntry))));
    if (!exists(shim.runtime) || !exists(shim.cliEntry)) {
      report.notes.push(`${path} runs a Frameshell app that is gone (${exists(shim.runtime) ? shim.cliEntry : shim.runtime} is missing). Reinstall it: ${INSTALL_HINT}.`);
      return report;
    }
  } else if (target.endsWith(join("dist", "bin", "frameshell.js")) && readPackage(dirname(dirname(dirname(target))))?.name === "@frameshell/cli") {
    // npm's global link, or a source checkout's: the CLI entry itself.
    report.cli = describeCliPackage(dirname(dirname(dirname(target))));
  }
  report.same = report.cli !== null && realOrSelf(report.cli.entry) === realOrSelf(self.entry);
  if (report.same) return report;
  if (!report.cli) {
    report.notes.push(`${path} was not installed by Frameshell and may not be this CLI (${label(self)}).`);
    return report;
  }
  const versions =
    report.cli.version && self.version && report.cli.version !== self.version ? ` Versions differ: ${report.cli.version} on PATH, ${self.version} here.` : "";
  report.notes.push(`\`frameshell\` on PATH runs ${label(report.cli)}, not this CLI (${label(self)}).${versions}`);
  return report;
}

/** `Frameshell app 0.3.0`, or `CLI 0.3.0 at <entry>` for one outside the app. */
export function label(cli: CliInstall): string {
  return cli.app ? `Frameshell app ${cli.version ?? "(unknown version)"}` : `CLI ${cli.version ?? "(unknown version)"} at ${cli.entry}`;
}

function findCommand(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string | null {
  const windows = platform === "win32";
  const pathValue = (windows ? (env["Path"] ?? env["PATH"]) : env["PATH"]) ?? "";
  const names = windows
    ? (env["PATHEXT"] ?? ".COM;.EXE;.BAT;.CMD")
        .split(";")
        .filter(Boolean)
        .map((ext) => `frameshell${ext.toLowerCase()}`)
    : [cliShimName(platform)];
  for (const dir of pathValue.split(windows ? ";" : ":").filter(Boolean)) {
    for (const name of names) {
      const candidate = join(dir, name);
      try {
        if (!statSync(candidate).isFile()) continue;
        if (!windows) accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {
        // Next candidate.
      }
    }
  }
  return null;
}

function readShim(file: string) {
  try {
    if (statSync(file).size > MAX_SHIM_BYTES) return null;
    return parseCliShim(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function readPackage(dir: string): { name?: string; version?: string } | null {
  try {
    return JSON.parse(readText(join(dir, "package.json"))) as { name?: string; version?: string };
  } catch {
    return null;
  }
}

/** A file's text; inside an `.asar` archive too, which only Electron's own `fs` opens. Throws when missing. */
function readText(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    const found = inAsar(path);
    if (found?.kind !== "file") throw error;
    if (found.unpacked) return readFileSync(found.unpacked, "utf8");
    const buffer = Buffer.alloc(found.size);
    const fd = openSync(found.archive, "r");
    try {
      readSync(fd, buffer, 0, found.size, found.offset);
    } finally {
      closeSync(fd);
    }
    return buffer.toString("utf8");
  }
}

type AsarNode = { files?: Record<string, AsarNode>; size?: number; offset?: string; unpacked?: boolean };
type AsarHit = { kind: "dir" } | { kind: "file"; archive: string; size: number; offset: number; unpacked: string | null };

/**
 * Find `path` in the `.asar` archive it points into, reading the archive's
 * header with plain `fs`: a CLI run by Node (npm, a source checkout) looks
 * into the desktop app's bundle this way. The header is a JSON tree after 16
 * bytes (`u32 4`, `u32 header size`, `u32 payload size`, `u32 JSON length`);
 * file offsets count from `8 + header size`. Null when not found.
 */
function inAsar(path: string): AsarHit | null {
  const match = /^(.*?\.asar)[\\/](.*)$/.exec(path);
  if (!match) return null;
  const archive = match[1]!;
  let node: AsarNode | undefined;
  let base: number;
  try {
    const fd = openSync(archive, "r");
    try {
      const prefix = Buffer.alloc(16);
      readSync(fd, prefix, 0, 16, 0);
      const length = prefix.readUInt32LE(12);
      const json = Buffer.alloc(length);
      readSync(fd, json, 0, length, 16);
      node = JSON.parse(json.toString("utf8")) as AsarNode;
      base = 8 + prefix.readUInt32LE(4);
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
  const parts = match[2]!.split(/[\\/]/).filter(Boolean);
  for (const part of parts) node = node?.files?.[part];
  if (!node) return null;
  if (node.files) return { kind: "dir" };
  if (node.unpacked) return { kind: "file", archive, size: node.size ?? 0, offset: 0, unpacked: join(`${archive}.unpacked`, ...parts) };
  return { kind: "file", archive, size: node.size ?? 0, offset: base + Number(node.offset ?? 0), unpacked: null };
}

function realOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function exists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return inAsar(path) !== null;
  }
}
