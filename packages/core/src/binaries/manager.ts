import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { chmod, mkdir, readFile, readdir, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import type { ReadableStream } from "node:stream/web";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { z } from "zod";
import { ErrorCode, RpcError } from "@frameshell/protocol";
import { type CommandRunner, runCommand } from "./command-runner.js";
import { extractZip, isZip } from "./unzip.js";
import {
  type BinaryPackage,
  DEFAULT_MODELS,
  type MachineProbe,
  DEFAULT_PACKAGES,
  type ManagedModel,
  type PinnedArchive,
  type PinnedBuild,
  type PlatformKey,
  buildCandidates,
  currentPlatform,
} from "./manifest.js";
import { renameRetrying } from "../fs-util.js";

/** Global config file name inside the config dir. */
export const GLOBAL_CONFIG_FILE = "config.json";

/** Override value meaning "use the pinned download". Anything else is a path. */
const MANAGED = "managed";

const GlobalConfigSchema = z.strictObject({
  $schema: z.string().optional(),
  /** Tool name to `"managed"` or an executable path (relative = against the config dir). */
  binaries: z.record(z.string(), z.string()).optional(),
});

/** `binaries` of the project whose overrides apply. */
export interface ProjectBinaries {
  /** Project root; relative override paths resolve against it. */
  dir: string;
  binaries?: Readonly<Record<string, string>> | undefined;
}

/** Where a tool will be taken from, without installing anything. */
export interface BinaryLocation {
  name: string;
  package: string;
  source: "managed" | "project" | "global";
  /** Null only when managed and nothing is pinned for this platform. */
  path: string | null;
  installed: boolean;
  /**
   * Managed build chosen for this machine, whatever the source: the first
   * candidate whose probes pass and whose install has not failed here.
   */
  pinned: PinnedBuild | null;
}

/** Options for {@link BinaryManager}. */
export interface BinaryManagerOptions {
  /** Managed installs go to `<dataDir>/binaries/<package>/<version>/<platform>/`. */
  dataDir: string;
  /** Holds the global `config.json`. */
  configDir: string;
  /** Defaults to {@link DEFAULT_PACKAGES}. Tests pin fixtures served locally. */
  packages?: readonly BinaryPackage[];
  /** Defaults to {@link DEFAULT_MODELS}. Installed under `<dataDir>/models/<id>/<version>/`. */
  models?: readonly ManagedModel[];
  platform?: PlatformKey;
  /**
   * Runs the machine probes of optional (GPU) builds and the start check of
   * their installed executables. Defaults to spawning them from PATH.
   */
  commandRunner?: CommandRunner;
}

/** One progress report of a long install (download, extraction). */
export interface InstallProgress {
  message: string;
  /** 0..1 of the current step when known. */
  fraction?: number;
}

/** Options for {@link BinaryManager.ensure} and {@link BinaryManager.ensureModel}. */
export interface EnsureOptions {
  /** Called while installing. Callers joining an install already running get its reports too. */
  onProgress?: ((progress: InstallProgress) => void) | undefined;
}

/** Where a managed model lives, without downloading it. */
export interface ModelLocation {
  id: string;
  path: string;
  installed: boolean;
  pinned: ManagedModel;
}

/** In-flight install shared by concurrent callers. */
interface Install {
  done: Promise<void>;
  listeners: Set<(progress: InstallProgress) => void>;
}

/**
 * Native executables the daemon runs (SPEC §9): pinned per-platform downloads
 * verified by SHA-256 and installed atomically, or system binaries named by a
 * `binaries` override (project wins over global config, then managed).
 *
 * Overriding one tool of a package also takes its siblings from the same
 * directory (`ffmpeg` → `ffprobe`) unless they are overridden themselves.
 */
export class BinaryManager {
  /** App data dir holding managed installs. */
  readonly dataDir: string;
  /** Key of the builds this manager installs. */
  readonly platform: PlatformKey;
  readonly #configDir: string;
  readonly #packages: readonly BinaryPackage[];
  readonly #models: readonly ManagedModel[];
  readonly #commandRunner: CommandRunner;
  /** One in-flight install per package or model (keyed `pkg:` / `model:`); concurrent callers share it. */
  readonly #installing = new Map<string, Install>();
  /** Machine probe results, keyed by command line. Hardware does not change under a running daemon. */
  readonly #probes = new Map<string, Promise<boolean>>();

  constructor(options: BinaryManagerOptions) {
    this.dataDir = options.dataDir;
    this.#configDir = options.configDir;
    this.#packages = options.packages ?? DEFAULT_PACKAGES;
    this.#models = options.models ?? DEFAULT_MODELS;
    this.platform = options.platform ?? currentPlatform();
    this.#commandRunner = options.commandRunner ?? runCommand;
  }

  /** Package that ships `tool`. Throws for unknown tools. */
  packageOf(tool: string): BinaryPackage {
    return this.#packageOf(tool);
  }

  /** Every tool name, in package order. */
  tools(): string[] {
    return this.#packages.flatMap((pkg) => pkg.tools);
  }

  /**
   * Resolve where `tool` comes from. Never downloads. Throws
   * `InvalidGlobalConfig` when the global config is malformed.
   */
  async locate(tool: string, project?: ProjectBinaries): Promise<BinaryLocation> {
    const pkg = this.#packageOf(tool);
    const pinned = await this.#selectBuild(pkg);
    const levels: { source: "project" | "global"; dir: string; binaries: Readonly<Record<string, string>> | undefined }[] = [
      ...(project ? [{ source: "project" as const, dir: project.dir, binaries: project.binaries }] : []),
      { source: "global", dir: this.#configDir, binaries: (await this.#readGlobalConfig()).binaries },
    ];
    for (const level of levels) {
      const path = overridePath(pkg, tool, level.dir, level.binaries);
      if (path === undefined) continue;
      if (path === MANAGED) break;
      return { name: tool, package: pkg.name, source: level.source, path, installed: await isFile(path), pinned };
    }
    const path = pinned ? join(this.#installDir(pkg, pinned), executable(tool, this.platform)) : null;
    return { name: tool, package: pkg.name, source: "managed", path, installed: path !== null && (await isFile(path)), pinned };
  }

  /**
   * Absolute path of a runnable `tool`, downloading its managed package first
   * when missing. Throws `BinaryNotFound` (override points at nothing),
   * `BinaryUnavailable` (no pin for this platform), `BinaryInstallFailed` or
   * `BinaryChecksumMismatch`; a failed install leaves nothing behind.
   */
  async ensure(tool: string, project?: ProjectBinaries, options: EnsureOptions = {}): Promise<string> {
    const location = await this.locate(tool, project);
    if (location.installed && location.path) return location.path;
    if (location.source !== "managed") {
      throw new RpcError(
        ErrorCode.BinaryNotFound,
        `${tool} not found at ${location.path} (set by \`binaries.${tool}\` in the ${location.source} config). ` +
          `Fix the path or set it to "managed".`,
        { binary: tool, path: location.path, source: location.source },
      );
    }
    const pkg = this.#packageOf(tool);
    if (!location.pinned || !location.path) {
      throw new RpcError(
        ErrorCode.BinaryUnavailable,
        `No managed ${pkg.name} build for ${this.platform}. Install ${tool} yourself and set ` +
          `\`"binaries": { "${tool}": "/path/to/${tool}" }\` in frameshell.json or ${join(this.#configDir, GLOBAL_CONFIG_FILE)}.`,
        { binary: tool, platform: this.platform },
      );
    }
    let { pinned, path } = location;
    for (;;) {
      const build = pinned;
      try {
        await this.#shared(`pkg:${pkg.name}:${this.#installDir(pkg, build)}`, options, (report) => this.#install(pkg, build, tool, report));
        return path;
      } catch (error) {
        // Only an optional (GPU) build that does not start falls back; downloads and checksums never do.
        if (!(error instanceof CandidateFailed) || !build.requires) throw error;
        const marker = this.#failedMarker(pkg, build);
        await mkdir(dirname(marker), { recursive: true });
        await writeFile(marker, `${JSON.stringify({ failedAt: new Date().toISOString(), error: error.message }, null, 2)}\n`);
        options.onProgress?.({
          message: `${pkg.name} ${build.accelerator} build does not start here, using the next build (details in ${marker}; delete it to retry)`,
        });
        const next = await this.locate(tool, project);
        if (!next.pinned || !next.path) throw error;
        ({ pinned, path } = next);
      }
    }
  }

  /** Where model `id` lives and whether it is there. Never downloads. Throws for unknown ids. */
  async locateModel(id: string): Promise<ModelLocation> {
    const pinned = this.#modelOf(id);
    const path = join(this.dataDir, "models", pinned.id, pinned.version, pinned.file);
    return { id, path, installed: await isFile(path), pinned };
  }

  /**
   * Absolute path of model `id`, downloading and checksum-verifying it first
   * when missing. Throws `BinaryInstallFailed` or `BinaryChecksumMismatch`
   * (data `binary` = the model id); a failed download leaves nothing behind.
   */
  async ensureModel(id: string, options: EnsureOptions = {}): Promise<string> {
    const location = await this.locateModel(id);
    if (location.installed) return location.path;
    await this.#shared(`model:${id}`, options, (report) => this.#installModel(location.pinned, location.path, report));
    return location.path;
  }

  /** Join the running install for `key` or start one; progress fans out to every waiting caller. */
  async #shared(key: string, options: EnsureOptions, work: (report: (progress: InstallProgress) => void) => Promise<void>) {
    let install = this.#installing.get(key);
    if (!install) {
      const listeners = new Set<(progress: InstallProgress) => void>();
      const report = (progress: InstallProgress) => {
        for (const listener of listeners) listener(progress);
      };
      const done = work(report).finally(() => this.#installing.delete(key));
      install = { done, listeners };
      this.#installing.set(key, install);
    }
    const listener = options.onProgress;
    if (listener) install.listeners.add(listener);
    try {
      await install.done;
    } finally {
      if (listener) install.listeners.delete(listener);
    }
  }

  #packageOf(tool: string): BinaryPackage {
    const pkg = this.#packages.find((candidate) => candidate.tools.includes(tool));
    if (!pkg) throw new Error(`Unknown binary: ${tool}`);
    return pkg;
  }

  #modelOf(id: string): ManagedModel {
    const model = this.#models.find((candidate) => candidate.id === id);
    if (!model) throw new Error(`Unknown model "${id}". Managed models: ${this.#models.map((m) => m.id).join(", ")}`);
    return model;
  }

  /** Optional candidates install beside the default one (`<platform>-<accelerator>`), so switching never mixes files. */
  #installDir(pkg: BinaryPackage, build: PinnedBuild): string {
    const dir = build.requires ? `${this.platform}-${build.accelerator ?? "gpu"}` : this.platform;
    return join(this.dataDir, "binaries", pkg.name, build.version, dir);
  }

  /** Written when an optional build failed here; the candidate is skipped until it is deleted. */
  #failedMarker(pkg: BinaryPackage, build: PinnedBuild): string {
    return `${this.#installDir(pkg, build)}.failed.json`;
  }

  /**
   * First candidate for this platform that is not an optional build whose
   * probes fail or whose install already failed here; null when none is pinned.
   */
  async #selectBuild(pkg: BinaryPackage): Promise<PinnedBuild | null> {
    const candidates = buildCandidates(pkg, this.platform);
    for (const build of candidates) {
      if (!build.requires) return build;
      if (await isFile(this.#failedMarker(pkg, build))) continue;
      const results = await Promise.all(build.requires.map((probe) => this.#probe(probe)));
      if (results.every(Boolean)) return build;
    }
    return candidates.at(-1) ?? null;
  }

  /** Runs from the temp dir: the data dir may not exist before the first install. */
  #probe(probe: MachineProbe): Promise<boolean> {
    const key = [probe.command, ...probe.args].join(" ");
    let result = this.#probes.get(key);
    if (!result) {
      result = this.#commandRunner(probe.command, probe.args, { cwd: tmpdir() }).then(
        () => true,
        () => false,
      );
      this.#probes.set(key, result);
    }
    return result;
  }

  async #readGlobalConfig(): Promise<z.output<typeof GlobalConfigSchema>> {
    const path = join(this.#configDir, GLOBAL_CONFIG_FILE);
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    }
    const invalid = (details: string) =>
      new RpcError(ErrorCode.InvalidGlobalConfig, `Invalid ${path}:\n${details}`, { path, details });
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (error) {
      throw invalid((error as Error).message);
    }
    const parsed = GlobalConfigSchema.safeParse(raw);
    if (!parsed.success) {
      throw invalid(parsed.error.issues.map((i) => `${i.path.map(String).join(".")}: ${i.message}`).join("\n"));
    }
    return parsed.data;
  }

  /**
   * Download every archive to a private staging dir, verify, extract only the
   * pinned members, then publish with one directory rename: readers see all
   * tools or none.
   */
  async #install(
    pkg: BinaryPackage,
    build: PinnedBuild,
    requestedBy: string,
    report: (progress: InstallProgress) => void,
  ): Promise<void> {
    const finalDir = this.#installDir(pkg, build);
    const staging = join(this.dataDir, "binaries", ".staging", `${pkg.name}-${randomUUID()}`);
    const out = join(staging, "out");
    try {
      await mkdir(out, { recursive: true });
      const sources: { url: string; sha256: string }[] = [];
      for (const [index, archive] of build.archives.entries()) {
        const file = join(staging, `archive-${index}`);
        const label = `Downloading ${pkg.name} ${build.version} (${megabytes(archive.size)} MB)`;
        const url = await download(archive, file, requestedBy, progressReporter(label, archive.size, report));
        sources.push({ url, sha256: archive.sha256 });
        const extracted = join(staging, `extract-${index}`);
        await mkdir(extracted);
        const support = archive.support ?? {};
        const members = archive.tree ? [archive.tree] : [...Object.values(archive.files), ...Object.values(support)];
        await extract(file, extracted, members, requestedBy, url);
        if (archive.tree) {
          const tree = join(extracted, ...archive.tree.split("/"));
          for (const name of await readdir(tree)) await renameRetrying(join(tree, name), join(out, name));
        }
        for (const [tool, member] of Object.entries(archive.files)) {
          const target = join(out, executable(tool, this.platform));
          const source = archive.tree ? join(out, ...member.slice(archive.tree.length + 1).split("/")) : join(extracted, ...member.split("/"));
          if (source !== target) await renameRetrying(source, target);
          if (!this.platform.startsWith("win32")) await chmod(target, 0o755);
        }
        for (const [name, member] of Object.entries(support)) {
          await renameRetrying(join(extracted, ...member.split("/")), join(out, name)).catch((error: NodeJS.ErrnoException) => {
            throw installFailed(requestedBy, url, `pinned archive has no ${member}: ${error.message}`);
          });
        }
      }
      const missing = [];
      for (const tool of pkg.tools) if (!(await isFile(join(out, executable(tool, this.platform))))) missing.push(tool);
      if (missing.length > 0) {
        throw installFailed(requestedBy, sources[0]?.url ?? "", `pinned archives provide no ${missing.join(", ")}`);
      }
      if (build.requires) await this.#startCheck(pkg, out, requestedBy, sources[0]?.url ?? "");
      await writeFile(
        join(out, "install.json"),
        `${JSON.stringify({ package: pkg.name, version: build.version, platform: this.platform, accelerator: build.accelerator ?? null, origin: build.origin, license: build.license, sources, installedAt: new Date().toISOString() }, null, 2)}\n`,
      );
      await mkdir(dirname(finalDir), { recursive: true });
      try {
        await renameRetrying(out, finalDir);
      } catch (error) {
        // Another daemon finished first; its install is identical.
        if (!(await isFile(join(finalDir, "install.json")))) throw error;
      }
    } finally {
      await rm(staging, { recursive: true, force: true });
      // Fails while another install stages: fine, the last one out removes it.
      await rmdir(dirname(staging)).catch(() => {});
    }
  }

  /**
   * An optional (GPU) build can pass its probes and still not start here (a
   * runtime library or the C library is too old): run each tool's version
   * probe before publishing it, so the next candidate installs instead.
   */
  async #startCheck(pkg: BinaryPackage, dir: string, requestedBy: string, url: string): Promise<void> {
    const args = pkg.versionProbe?.args ?? ["-version"];
    for (const tool of pkg.tools) {
      try {
        await this.#commandRunner(join(dir, executable(tool, this.platform)), args, { cwd: dir });
      } catch (error) {
        throw new CandidateFailed(ErrorCode.BinaryInstallFailed, `Could not install ${requestedBy} from ${url}: ${tool} does not start: ${(error as Error).message}`, {
          binary: requestedBy,
          url,
          details: (error as Error).message,
        });
      }
    }
  }

  /** Download to a staging file, verify, then rename into place: readers see the whole file or none. */
  async #installModel(model: ManagedModel, finalPath: string, report: (progress: InstallProgress) => void): Promise<void> {
    const staging = join(this.dataDir, "models", ".staging", `${model.id}-${randomUUID()}`);
    try {
      await mkdir(staging, { recursive: true });
      const file = join(staging, model.file);
      const label = `Downloading model ${model.id} (${megabytes(model.size)} MB, one time)`;
      await download({ urls: model.urls, sha256: model.sha256, size: model.size, files: {} }, file, model.id, progressReporter(label, model.size, report));
      await mkdir(dirname(finalPath), { recursive: true });
      await renameRetrying(file, finalPath);
    } finally {
      await rm(staging, { recursive: true, force: true });
      await rmdir(dirname(staging)).catch(() => {});
    }
  }
}

function megabytes(bytes: number): number {
  return Math.max(1, Math.round(bytes / 1e6));
}

/** Byte counter → progress reports, at most one per percent. */
function progressReporter(message: string, total: number, report: (progress: InstallProgress) => void): (received: number) => void {
  let lastPercent = -1;
  return (received) => {
    const percent = total > 0 ? Math.min(100, Math.floor((received / total) * 100)) : 0;
    if (percent === lastPercent) return;
    lastPercent = percent;
    report({ message, fraction: percent / 100 });
  };
}

/** Path set for `tool` at one config level; `undefined` = level says nothing about this package. */
function overridePath(
  pkg: BinaryPackage,
  tool: string,
  baseDir: string,
  binaries: Readonly<Record<string, string>> | undefined,
): string | undefined {
  if (!binaries) return undefined;
  const own = binaries[tool];
  if (own !== undefined) return own === MANAGED ? MANAGED : resolve(baseDir, own);
  for (const sibling of pkg.tools) {
    const value = binaries[sibling];
    if (value === undefined) continue;
    if (value === MANAGED) return MANAGED;
    const siblingPath = resolve(baseDir, value);
    return join(dirname(siblingPath), `${tool}${extname(siblingPath)}`);
  }
  return undefined;
}

function executable(tool: string, platform: PlatformKey): string {
  return platform.startsWith("win32") ? `${tool}.exe` : tool;
}

/** Try each mirror; returns the URL that delivered the pinned bytes. */
async function download(
  archive: PinnedArchive,
  dest: string,
  binary: string,
  onBytes: (received: number) => void = () => {},
): Promise<string> {
  let mismatch: RpcError | undefined;
  const failures: string[] = [];
  for (const url of archive.urls) {
    try {
      const response = await fetch(url);
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
      const hash = createHash("sha256");
      let received = 0;
      await pipeline(
        Readable.fromWeb(response.body as ReadableStream<Uint8Array>),
        async function* (source: AsyncIterable<Buffer>) {
          for await (const chunk of source) {
            hash.update(chunk);
            received += chunk.length;
            onBytes(received);
            yield chunk;
          }
        },
        createWriteStream(dest),
      );
      const actual = hash.digest("hex");
      if (actual === archive.sha256.toLowerCase()) return url;
      mismatch ??= new RpcError(
        ErrorCode.BinaryChecksumMismatch,
        `Checksum mismatch for ${url}: expected SHA-256 ${archive.sha256}, got ${actual}. ` +
          "Nothing was installed. The download may be corrupt or tampered with; retry, or report it if it persists.",
        { binary, url, expected: archive.sha256, actual },
      );
    } catch (error) {
      failures.push(`${url}: ${(error as Error).message}`);
    }
  }
  throw mismatch ?? installFailed(binary, archive.urls[0] ?? "", `download failed:\n  ${failures.join("\n  ")}`);
}

const execFileAsync = promisify(execFile);

/**
 * System tar: bsdtar on macOS and Windows reads zip and tar; GNU tar on Linux
 * reads tar.xz via `xz` but no zip, so Linux zips go through {@link extractZip}.
 */
async function extract(archive: string, dest: string, members: string[], binary: string, url: string): Promise<void> {
  if (process.platform === "linux" && (await isZip(archive))) {
    try {
      await extractZip(archive, dest, members);
    } catch (error) {
      throw installFailed(binary, url, `could not extract ${members.join(", ")}: ${(error as Error).message}`);
    }
    return;
  }
  // Absolute path: a GNU tar earlier on PATH (Git for Windows) cannot read zip and misparses `C:`.
  const tar = process.platform === "win32" ? join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "tar.exe") : "tar";
  try {
    await execFileAsync(tar, ["-xf", archive, "-C", dest, ...members], { windowsHide: true, maxBuffer: 1 << 20 });
  } catch (error) {
    const stderr = String((error as { stderr?: unknown }).stderr ?? "").trim();
    const hint = process.platform === "linux" ? " (tar.xz needs `xz`: install xz-utils)" : "";
    throw installFailed(binary, url, `could not extract ${members.join(", ")}${hint}: ${stderr || (error as Error).message}`);
  }
}

/** An optional build's start check failed: the next candidate installs instead. */
class CandidateFailed extends RpcError {}

function installFailed(binary: string, url: string, details: string): RpcError {
  return new RpcError(ErrorCode.BinaryInstallFailed, `Could not install ${binary} from ${url}: ${details}`, {
    binary,
    url,
    details,
  });
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}
