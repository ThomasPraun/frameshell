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
  type Accelerator,
  type BinaryPackage,
  DEFAULT_MODELS,
  DEFAULT_PACKAGES,
  FFMPEG_PACKAGE,
  type MachineProbe,
  type ManagedModel,
  type PinnedArchive,
  type PinnedBuild,
  type PlatformKey,
  type FrameshellWhisperBuild,
  WHISPER_FRAMESHELL_BUILDS,
  WHISPER_FRAMESHELL_TAG,
  WHISPER_SOURCE,
  frameshellWhisperUrl,
  WHISPER_MODELS,
  WHISPER_PACKAGE,
  buildCandidates,
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
export { type CommandRunner, runCommand } from "./binaries/command-runner.js";
export { type TarEntry, packTar } from "./binaries/reproducible-tar.js";
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
  resolveTranscript,
  transcriptPathsFor,
} from "./transcripts/transcriber.js";
export { type AudioExtractor, extractAudioWithFfmpeg } from "./transcripts/audio.js";
