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
  type BinaryMirror,
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
  type SourceArchive,
  currentPlatform,
  mirrorUrl,
} from "./binaries/manifest.js";
export {
  MIRROR_GENERATED_FILES,
  type MirrorAsset,
  type MirrorPlan,
  checkMirrorSums,
  parseSha256Sums,
  planMirror,
} from "./binaries/mirror.js";
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
  type TranscriberMedia,
  type TranscriberTools,
  transcribeAsset,
  resolveTranscript,
  transcriptPathsFor,
} from "./transcripts/transcriber.js";
export { type AudioExtractor, type AudioInput, TRANSCRIPTION_SAMPLE_RATE, extractAudioWithFfmpeg } from "./transcripts/audio.js";
export {
  type AppliedOperation,
  type ClipTypeInfo,
  type EditContext,
  type EditPoint,
  type EditPointResolver,
  type OperationArgs,
  type OperationRequest,
  type SourceInfo,
  applyOperation,
} from "./timeline/engine.js";
export { applyPatch, diffTimelines } from "./timeline/patch.js";
export { FrameGrid } from "./timeline/grid.js";
export { NestedTimelineError } from "./timeline/timing.js";
export {
  type AudioItem,
  DEFAULT_SEGMENT_SECONDS,
  EDGE_FADE_SECONDS,
  type ExportSource,
  type FfmpegStep,
  type FrameInput,
  type FramePlan,
  type LoudnessMeasurement,
  type RenderInput,
  type RenderPlan,
  type RenderSegment,
  compileFrame,
  compileRender,
  MIX_FILE,
  loudnessAnalysis,
  mixStep,
  muxStep,
  parseLoudnessStats,
} from "./export/compiler.js";
export { BUILTIN_PRESETS, DEFAULT_LOUDNESS_LUFS, DEFAULT_PRESET_ID, loudnessTarget } from "./export/presets.js";
export { type ExecuteRenderOptions, ExportService, type ExportServiceOptions, executeRender } from "./export/service.js";
