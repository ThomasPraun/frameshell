import type { BinaryReport, DoctorResult } from "@frameshell/protocol";
import type { BinaryManager, ProjectBinaries } from "./manager.js";
import { type Exec, execProcess, probeFfmpeg, probeVersion } from "./probe.js";

/** Options for {@link runDoctor}. */
export interface DoctorOptions {
  /** Overrides of the project the caller is in. */
  project?: ProjectBinaries | undefined;
  /** Download missing managed binaries first; install errors reject. */
  install?: boolean;
  exec?: Exec;
}

/**
 * Diagnose every managed tool: source, path, version, pin, and ffmpeg codecs.
 * Report-only by default: never downloads unless `install` is set. On-demand
 * packages (whisper.cpp) are reported, never flagged missing and never
 * installed here: their feature installs them on first use.
 */
export async function runDoctor(binaries: BinaryManager, options: DoctorOptions = {}): Promise<DoctorResult> {
  const { project, install = false, exec = execProcess } = options;
  const tools = binaries.tools();
  if (install) {
    for (const tool of tools) {
      if (binaries.packageOf(tool).onDemand) continue;
      const location = await binaries.locate(tool, project);
      // Missing overrides are reported below; only managed tools are installable.
      if (location.source === "managed") await binaries.ensure(tool, project);
    }
  }

  const problems: string[] = [];
  const reports: BinaryReport[] = [];
  const reportedPackages = new Set<string>();
  for (const tool of tools) {
    const location = await binaries.locate(tool, project);
    const pkg = binaries.packageOf(tool);
    const version = location.installed && location.path ? await probeVersion(location.path, exec, pkg.versionProbe) : null;
    const { pinned } = location;
    reports.push({
      name: tool,
      package: location.package,
      source: location.source,
      path: location.path,
      installed: location.installed,
      version,
      pinned: pinned && { version: pinned.version, origin: pinned.origin, license: pinned.license, accelerator: pinned.accelerator ?? null },
    });

    if (location.installed) {
      if (version === null) {
        const args = (pkg.versionProbe?.args ?? ["-version"]).join(" ");
        problems.push(`${location.path} does not run or prints no version (\`${tool} ${args}\`).`);
      }
    } else if (location.source !== "managed") {
      problems.push(
        `${tool} not found at ${location.path} (set by \`binaries\` in the ${location.source} config). ` +
          'Fix the path or set it to "managed".',
      );
    } else if (!pkg.onDemand && !reportedPackages.has(location.package)) {
      // One line per package: its tools install together.
      reportedPackages.add(location.package);
      if (!pinned) {
        problems.push(
          `No managed ${location.package} build for ${binaries.platform}. Install it yourself and set ` +
            `\`"binaries": { "${tool}": "/path/to/${tool}" }\` in frameshell.json or the global config.`,
        );
      } else {
        const megabytes = Math.round(pinned.archives.reduce((sum, a) => sum + a.size, 0) / 1e6);
        problems.push(
          `${location.package} ${pinned.version} is not installed. It downloads on first use, or now with ` +
            `\`frameshell doctor --install\` (${megabytes} MB from ${pinned.origin}).`,
        );
      }
    }
  }

  const ffmpeg = reports.find((report) => report.name === "ffmpeg");
  let codecs: DoctorResult["codecs"] = [];
  if (ffmpeg?.installed && ffmpeg.path && ffmpeg.version !== null) {
    const probe = await probeFfmpeg(ffmpeg.path, exec);
    codecs = probe.codecs;
    problems.push(...probe.problems);
  }
  return { platform: binaries.platform, dataDir: binaries.dataDir, binaries: reports, codecs, problems };
}
