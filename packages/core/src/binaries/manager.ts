import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { chmod, mkdir, readFile, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import type { ReadableStream } from "node:stream/web";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { z } from "zod";
import { ErrorCode, RpcError } from "@frameshell/protocol";
import {
  type BinaryPackage,
  DEFAULT_PACKAGES,
  type PinnedArchive,
  type PinnedBuild,
  type PlatformKey,
  currentPlatform,
} from "./manifest.js";

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
  /** Managed build for this platform, whatever the source. */
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
  platform?: PlatformKey;
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
  /** One in-flight install per package; concurrent callers share it. */
  readonly #installing = new Map<string, Promise<void>>();

  constructor(options: BinaryManagerOptions) {
    this.dataDir = options.dataDir;
    this.#configDir = options.configDir;
    this.#packages = options.packages ?? DEFAULT_PACKAGES;
    this.platform = options.platform ?? currentPlatform();
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
    const pinned = pkg.builds[this.platform] ?? null;
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
  async ensure(tool: string, project?: ProjectBinaries): Promise<string> {
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
    let install = this.#installing.get(pkg.name);
    if (!install) {
      install = this.#install(pkg, location.pinned, tool).finally(() => this.#installing.delete(pkg.name));
      this.#installing.set(pkg.name, install);
    }
    await install;
    return location.path;
  }

  #packageOf(tool: string): BinaryPackage {
    const pkg = this.#packages.find((candidate) => candidate.tools.includes(tool));
    if (!pkg) throw new Error(`Unknown binary: ${tool}`);
    return pkg;
  }

  #installDir(pkg: BinaryPackage, build: PinnedBuild): string {
    return join(this.dataDir, "binaries", pkg.name, build.version, this.platform);
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
  async #install(pkg: BinaryPackage, build: PinnedBuild, requestedBy: string): Promise<void> {
    const finalDir = this.#installDir(pkg, build);
    const staging = join(this.dataDir, "binaries", ".staging", `${pkg.name}-${randomUUID()}`);
    const out = join(staging, "out");
    try {
      await mkdir(out, { recursive: true });
      const sources: { url: string; sha256: string }[] = [];
      for (const [index, archive] of build.archives.entries()) {
        const file = join(staging, `archive-${index}`);
        const url = await download(archive, file, requestedBy);
        sources.push({ url, sha256: archive.sha256 });
        const extracted = join(staging, `extract-${index}`);
        await mkdir(extracted);
        await extract(file, extracted, Object.values(archive.files), requestedBy, url);
        for (const [tool, member] of Object.entries(archive.files)) {
          const target = join(out, executable(tool, this.platform));
          await rename(join(extracted, ...member.split("/")), target);
          if (!this.platform.startsWith("win32")) await chmod(target, 0o755);
        }
      }
      const missing = [];
      for (const tool of pkg.tools) if (!(await isFile(join(out, executable(tool, this.platform))))) missing.push(tool);
      if (missing.length > 0) {
        throw installFailed(requestedBy, sources[0]?.url ?? "", `pinned archives provide no ${missing.join(", ")}`);
      }
      await writeFile(
        join(out, "install.json"),
        `${JSON.stringify({ package: pkg.name, version: build.version, platform: this.platform, origin: build.origin, license: build.license, sources, installedAt: new Date().toISOString() }, null, 2)}\n`,
      );
      await mkdir(dirname(finalDir), { recursive: true });
      try {
        await rename(out, finalDir);
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
async function download(archive: PinnedArchive, dest: string, binary: string): Promise<string> {
  let mismatch: RpcError | undefined;
  const failures: string[] = [];
  for (const url of archive.urls) {
    try {
      const response = await fetch(url);
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
      const hash = createHash("sha256");
      await pipeline(
        Readable.fromWeb(response.body as ReadableStream<Uint8Array>),
        async function* (source: AsyncIterable<Buffer>) {
          for await (const chunk of source) {
            hash.update(chunk);
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

/** System tar: bsdtar on macOS and Windows reads zip and tar; GNU tar on Linux reads tar.xz via `xz`. */
async function extract(archive: string, dest: string, members: string[], binary: string, url: string): Promise<void> {
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
