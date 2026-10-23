export {
  DAEMON_VERSION,
  DEFAULT_IDLE_TIMEOUT_MS,
  type Daemon,
  type DaemonOptions,
  startDaemon,
} from "./daemon.js";
export { PROJECT_FILE } from "./projects.js";
export { type NameWrites, type PeopleChange, type PeopleServiceOptions, type PeopleTarget, PeopleService, type VoicePrinter } from "./people/service.js";
export {
  FACE_EMBEDDING_DIMS,
  type FaceEmbedder,
  type FaceTrack,
  FaceTracker,
  type Landmarks,
  MIN_EMBED_PX,
  type PeopleScanFiles,
  type PeopleScanOptions,
  type PeopleScanRequest,
  type PeopleScanResult,
  type PeopleScanner,
  type Similarity,
  type TrackBox,
  alignFace,
  loadSface,
  peopleScanWorker,
  scanFrameSize,
  scanPeopleFaces,
  shrinkFrame,
  similarityTransform,
} from "./people/scan.js";
export { PEOPLE_DIR, type StoredFaceScan, classifyFaceScan, faceScanKey, readFaceScan, writeFaceScan } from "./people/scan-cache.js";
export { type PersonRanges, type RangeKind, type RangesSource, type Span, RANGE_BRIDGE_S, mergeSpans, personRanges } from "./people/ranges.js";
export { FBANK_BINS, FBANK_SAMPLE_RATE, type Fbank, fbank, subtractMean } from "./people/fbank.js";
export {
  type CampplusFiles,
  type Stretch,
  type VoiceEmbedRequest,
  type VoiceEmbedder,
  campplusWorkerEmbedder,
  embedStretches,
} from "./people/voice-embed.js";
export {
  VOICES_DIR,
  type VoiceOutcome,
  type VoicePrint,
  type VoicePrintOptions,
  type VoiceWanted,
  classifyVoiceCache,
  computeVoicePrints,
  meanPrint,
  voiceKey,
  voiceStretches,
} from "./people/voices.js";
export { type PersonVoice, SPEAKER_MARGIN, SPEAKER_MATCH, type SpeakerVoice, speakerSuggestions, suggestionId } from "./people/suggest.js";
export { cosine } from "./people/vector.js";
export { DEFAULT_TX_IDLE_GAP_MS } from "./history/transactions.js";
export { type AppDirs, resolveAppDirs } from "@frameshell/protocol";
export {
  type Accelerator,
  type BinaryMirror,
  type BinaryPackage,
  DEFAULT_MODELS,
  DEFAULT_PACKAGES,
  CHROME_HEADLESS_SHELL_PACKAGE,
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
  DIARIZATION_MODELS,
  DIARIZATION_TOOL,
  SEGMENTATION_MODEL,
  SHERPA_ONNX_PACKAGE,
  SPEAKER_EMBEDDING_MODEL,
  FACE_DETECTION_MODEL,
  FACE_DETECTION_MODELS,
  FACE_RECOGNITION_MODEL,
  FACE_RECOGNITION_MODELS,
  ONNX_RUNTIME_WEB,
  ONNX_RUNTIME_WEB_PACKAGE,
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
export { type TimedWord, type WordHearing, alignWords } from "./transcripts/align.js";
export { type VerifyExportOptions, verifyExport } from "./transcripts/verify.js";
export { type DiarizeAssetOptions, type DiarizeRequest, type Diarizer, diarizeAsset, parseDiarization, sherpaDiarizer } from "./transcripts/speakers.js";
export { type LabelledSpeakers, type SpeakerSegment, carrySpeakers, defaultSpeakerName, labelSpeakers, nextSpeakerIdOf, wordLabels } from "./transcripts/speaker-labels.js";
export { type AudioExtractor, type AudioInput, TRANSCRIPTION_SAMPLE_RATE, extractAudioWithFfmpeg } from "./transcripts/audio.js";
export {
  type AppliedOperation,
  type ClipTypeInfo,
  type EditContext,
  type EditPoint,
  type EditPointResolution,
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
  type GeneratedSource,
  type LoudnessMeasurement,
  type RenderInput,
  type RenderPlan,
  type RenderSegment,
  compileFrame,
  compileRender,
  MIX_FILE,
  SUBTITLES_FILE,
  FONTS_DIR,
  loudnessAnalysis,
  mixStep,
  muxStep,
  parseLoudnessStats,
} from "./export/compiler.js";
export { assSubtitles, assCentiseconds } from "./export/ass.js";
export { fontSource, writeFonts } from "./export/fonts.js";
export { BUILTIN_PRESETS, DEFAULT_LOUDNESS_LUFS, DEFAULT_PRESET_ID, loudnessTarget } from "./export/presets.js";
export { type ExecuteRenderOptions, ExportService, type ExportServiceOptions, executeRender } from "./export/service.js";
export {
  DEFAULT_SNAP_WINDOW_S,
  ENERGY_HOP_S,
  type EnergyProfile,
  EnvelopeBuilder,
  PAUSE_MIN_S,
  type SnapRequest,
  type SnapResult,
  energyEnvelope,
  energyProfile,
  profileLevel,
  snapToPause,
} from "./media/energy.js";
export { ENERGY_DIR, EnergyStore, type EnergyStoreOptions } from "./media/energy-store.js";
export { PROXY_GOP, RECIPE_VERSION, SIDECAR_SAMPLE_RATE, alphaProxyArgs, proxyArgs, sidecarArgs } from "./media/recipe.js";
export { type Manifest, MediaStore } from "./media/store.js";
export { type EnergySnapperOptions, energySnapper } from "./timeline/snap.js";
export { type ClipKeyInput, clipCacheKey } from "./clips/cache-key.js";
export {
  CLIP_CACHE_DIR,
  ClipRenderer,
  type ClipFormat,
  type ClipRendererOptions,
  type RegisteredClipType,
  type RenderProbe,
  type RenderedClip,
} from "./clips/renderer.js";
export { type MeasureRequest, type MeasureSource, type MeasuredAngles, measureAngles, resolveSoundOf, syncReport } from "./multicam/measure.js";
export { type GroupTurns, type SpeakerSource, type TurnsSource, type TurnsTranscript, groupTurns } from "./multicam/group-turns.js";
export {
  type GroupMotion,
  MOTION_HZ,
  MOTION_SIZE,
  MotionStore,
  type MotionSource,
  frameDifference,
  groupMotion,
  motionStretches,
  pictureDifferences,
} from "./multicam/motion.js";
export {
  type GalleryAnalysis,
  type GalleryLayout,
  type GallerySample,
  type GalleryStretch,
  type GalleryTile,
  type GrayFrame,
  MIN_LAYOUT_SAMPLES,
  type TileRect,
  analyseGallery,
  detectTiles,
  galleryFrameSize,
  galleryInterval,
  galleryLayouts,
  gutterLevels,
  sampleGallery,
  tileCrop,
} from "./multicam/gallery.js";
export {
  GALLERY_LOW_CONFIDENCE,
  type GalleryPlan,
  type GalleryReport,
  type GalleryRequest,
  type GallerySource,
  galleryReport,
  planGallery,
} from "./multicam/gallery-plan.js";
export {
  type AngleFaceOptions,
  type AngleFaces,
  type BgrFrame,
  FACE_SAMPLE_HZ,
  type Face,
  type FaceDetector,
  type FacePoint,
  type FaceSample,
  type FaceScanRequest,
  type FaceScanner,
  type YunetFiles,
  yunetWorkerScanner,
  type ReframeKeyOptions,
  angleFaceKeys,
  decodeYunet,
  faceFrameSize,
  loadYunet,
  mainFaceTrack,
  proposeReframeKeys,
  sampleFaceFrames,
} from "./multicam/faces.js";
export { type DirectedShot, type DirectorAngle, type DirectorInput, type DirectorTurn, directShots } from "./multicam/director.js";
export { type LoadedRules, humanShots, loadDirectorRules, lowShots, unknownWeights } from "./multicam/direct.js";
export { BLEED_DB, MERGE_GAP_S, MIN_TURN_S, type SpokenWord, TURN_FRAME_S, type Turn, type TurnInput, speakingTurns, wordTurns } from "./multicam/turns.js";
export {
  type PlannedOffset,
  SYNC_WINDOW_S,
  type SyncEstimate,
  correlateProfiles,
  planSync,
} from "./multicam/sync.js";
