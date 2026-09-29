export {
  DAEMON_VERSION,
  DEFAULT_IDLE_TIMEOUT_MS,
  type Daemon,
  type DaemonOptions,
  startDaemon,
} from "./daemon.js";
export { PROJECT_FILE } from "./projects.js";
export { type AppDirs, resolveAppDirs } from "@frameshell/protocol";
export {
  type BinaryPackage,
  DEFAULT_PACKAGES,
  FFMPEG_PACKAGE,
  type PinnedArchive,
  type PinnedBuild,
  type PlatformKey,
  currentPlatform,
} from "./binaries/manifest.js";
export {
  type BinaryLocation,
  BinaryManager,
  type BinaryManagerOptions,
  GLOBAL_CONFIG_FILE,
  type ProjectBinaries,
} from "./binaries/manager.js";
export {
  type Exec,
  type ExecResult,
  type FfmpegProbe,
  execProcess,
  probeFfmpeg,
  probeVersion,
} from "./binaries/probe.js";
export { type DoctorOptions, runDoctor } from "./binaries/doctor.js";
export { type PluginSpec, parsePluginSpec } from "./plugins/spec.js";
