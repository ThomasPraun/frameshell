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
  DEFAULT_MODELS,
  DEFAULT_PACKAGES,
  FFMPEG_PACKAGE,
  type ManagedModel,
  type PinnedArchive,
  type PinnedBuild,
  type PlatformKey,
  type SourceBuild,
  WHISPER_MODELS,
  WHISPER_PACKAGE,
  currentPlatform,
} from "./binaries/manifest.js";
export {
  type BinaryLocation,
  BinaryManager,
  type BinaryManagerOptions,
  type EnsureOptions,
  GLOBAL_CONFIG_FILE,
  type InstallProgress,
  type ModelLocation,
  type ProjectBinaries,
} from "./binaries/manager.js";
export { type BuildRunner, runBuildTool } from "./binaries/build-runner.js";
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
export {
  type TranscribeAssetOptions,
  type TranscriberTools,
  transcribeAsset,
  transcriptPathFor,
} from "./transcripts/transcriber.js";
export { type AudioExtractor, extractAudioWithFfmpeg } from "./transcripts/audio.js";
