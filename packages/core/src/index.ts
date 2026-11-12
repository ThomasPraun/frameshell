export {
  DAEMON_VERSION,
  DEFAULT_IDLE_TIMEOUT_MS,
  type Daemon,
  type DaemonOptions,
  startDaemon,
} from "./daemon.js";
export { PROJECT_FILE } from "./projects.js";
export { FormatService, type FormatServiceOptions, builtinFormatInfos, formatInfos, formatNotFound, projectConfigDocument } from "./formats.js";
export {
  CONFIG_JOURNAL,
  type ConfigDocument,
  ConfigJournal,
  type ConfigJournalOptions,
  type ConfigRecord,
  type ConfigRevertPlan,
  configOperation,
  readConfigJournal,
} from "./config/journal.js";
export { type ConfigRules, type ConfigState, PLAIN_RULES, applyConfigPatch, configHash, diffConfig } from "./config/patch.js";
export { FORMAT_RULES, type FormatKeyValue, formatState, formatsFromState } from "./config/project-doc.js";
export { CONFIG_DOC_NAMES, planConfigRevert } from "./config/revert.js";
export { STYLE_KEY, checkedStyleState, styleConfigDocument, stylePathOf, styleState, styleWritten } from "./style/doc.js";
export { StyleService, type StyleServiceOptions } from "./style/service.js";
export {
  type FaceScans,
  type NameWrites,
  type PeopleChange,
  type PeopleServiceOptions,
  type PeopleTarget,
  PeopleService,
  type SuggestSources,
  type VoicePrinter,
} from "./people/service.js";
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
export { type PersonRanges, type RangeKind, type RangesSource, type Span, RANGE_BRIDGE_S, faceSpans, mergeSpans, personRanges } from "./people/ranges.js";
export {
  type ClusterTrack,
  FACE_ANCHOR_WINDOW_S,
  FACE_CLUSTER_MATCH,
  FACE_SAMPLE_SPAN_S,
  type FaceCluster,
  type FaceModel,
  type FaceOwners,
  type FaceAnchorPoint,
  type ScannedAsset,
  clusterFaces,
  clusterFacesOffThread,
  facesOfPeople,
  overlapSeconds,
  personFacePrint,
  presence,
  resolveAnchor,
  spanSeconds,
} from "./people/face-clusters.js";
export {
  FACE_MIN_SCREEN_S,
  FACE_PERSON_MARGIN,
  FACE_PERSON_MATCH,
  FACE_SPEAKER_MIN_S,
  FACE_SPEAKER_SHARE,
  type FaceSuggestInput,
  faceSuggestions,
} from "./people/face-suggest.js";
export { ANGLE_SPEAKER_SHARE, type AngleSuggestInput, angleSuggestions } from "./people/angle-suggest.js";
export { type ScanProjectDeps, readProjectFaceScans, scanProjectFaces } from "./people/scan-run.js";
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
export { averageLinkage, cosine } from "./people/vector.js";
export { DEFAULT_TX_IDLE_GAP_MS } from "./history/transactions.js";
export { type AppDirs, resolveAppDirs } from "@frameshell/protocol";
export {
  type Accelerator,
  type BinaryMirror,
  type BinaryPackage,
  BLENDER_PACKAGE,
  BLENDER_TOOL,
  type UserInstall,
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
  WHISPER_SERVER_FRAMESHELL_TAG,
  WHISPER_SOURCE,
  type WhisperTool,
  frameshellWhisperTag,
  frameshellWhisperUrl,
  WHISPER_MODELS,
  LIVE_WHISPER_MODELS,
  WHISPER_PACKAGE,
  WHISPER_SERVER_PACKAGE,
  DIARIZATION_MODELS,
  DIARIZATION_TOOL,
  SEGMENTATION_MODEL,
  SHERPA_ONNX_PACKAGE,
  SPEAKER_EMBEDDING_MODEL,
  FACE_DETECTION_MODEL,
  FACE_DETECTION_MODELS,
  FACE_RECOGNITION_MODEL,
  FACE_RECOGNITION_MODELS,
  PHOTO_SEGMENTATION_DECODER_MODEL,
  PHOTO_SEGMENTATION_ENCODER_MODEL,
  PHOTO_SEGMENTATION_MODELS,
  VIDEO_MATTE_MODEL,
  VIDEO_MATTE_MODELS,
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
  type InstallProgress,
  type ModelLocation,
  type ProjectBinaries,
} from "./binaries/manager.js";
export { GLOBAL_CONFIG_FILE, type GlobalConfig, type SpeechCommandConfig, readGlobalConfig } from "./global-config.js";
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
export { ENCODER_CACHE_FILE, EncoderCache, type EncoderProbe, probeEncoders } from "./encoders/probe.js";
export { type MachineFacts, machineProfile, readMachineFacts } from "./encoders/profile.js";
export { ENCODER_PREFERENCE, type EncodeTarget, tierFps, tierVideoArgs, videoToolboxKbps } from "./encoders/tiers.js";
export { type PluginSpec, parsePluginSpec } from "./plugins/spec.js";
export {
  type TranscribeAssetOptions,
  type TranscriberMedia,
  type TranscriberTools,
  transcribeAsset,
  resolveTranscript,
  transcriptPathsFor,
  providerContext,
} from "./transcripts/transcriber.js";
export { MODEL_REGISTRY_FILE, ModelRegistry, detectModelFormat } from "./transcripts/model-registry.js";
export { type TimedWord, type WordHearing, alignWords } from "./transcripts/align.js";
export { type VerifyExportOptions, verifyExport } from "./transcripts/verify.js";
export { type DiarizeAssetOptions, type DiarizeRequest, type Diarizer, diarizeAsset, parseDiarization, sherpaDiarizer } from "./transcripts/speakers.js";
export {
  type LabelledSpeakers,
  type SpeakerSegment,
  VOICE_CLUSTER_MATCH,
  carrySpeakers,
  clusterVoices,
  defaultSpeakerName,
  labelSpeakers,
  nextSpeakerIdOf,
  wordLabels,
} from "./transcripts/speaker-labels.js";
export { type AudioExtractor, type AudioInput, TRANSCRIPTION_SAMPLE_RATE, extractAudioWithFfmpeg } from "./transcripts/audio.js";
export {
  type AppliedOperation,
  type ClipTypeInfo,
  type EditContext,
  type EditPoint,
  type EditPointResolution,
  type EditPointResolver,
  type IdPrefix,
  type OperationArgs,
  type OperationRequest,
  type SourceInfo,
  applyOperation,
} from "./timeline/engine.js";
export { applyPatch, diffTimelines } from "./timeline/patch.js";
export { FrameGrid } from "./timeline/grid.js";
export { type CleanupPlanOptions, type SpeechAudio, type SpeechWord, planCleanup } from "./cleanup/plan.js";
export { type CleanupDeps, type CleanupPlan, type CleanupRequest, cleanupLabel, planTimelineCleanup } from "./cleanup/run.js";
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
  type MatteSource,
  type RenderInput,
  type RenderPlan,
  type RenderSegment,
  compileFrame,
  compileRender,
  MIX_FILE,
  SUBTITLES_FILE,
  COVER_FILE,
  FONTS_DIR,
  loudnessAnalysis,
  mixStep,
  muxStep,
  parseLoudnessStats,
} from "./export/compiler.js";
export { assSubtitles, assCentiseconds } from "./export/ass.js";
export { fontSource, writeFonts } from "./export/fonts.js";
export { type FontMetrics, bundledFontMetrics, parseFontMetrics } from "./export/font-metrics.js";
export {
  COVER_MAX_CHARS,
  type CoverLayout,
  type CoverReadability,
  DEFAULT_COVER_COLOR,
  MIN_THUMBNAIL_CAP_HEIGHT,
  THUMBNAIL_WIDTH,
  assCover,
  coverReadability,
  coverText,
  firstPictureTime,
  hookWordTime,
  layoutCover,
} from "./export/cover.js";
export { BUILTIN_PRESETS, DEFAULT_LOUDNESS_LUFS, DEFAULT_PRESET_ID, loudnessTarget } from "./export/presets.js";
export { type CoverChoice, type ExecuteRenderOptions, ExportService, type ExportServiceOptions, executeRender } from "./export/service.js";
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
export {
  ANALYSIS_RATE as BEAT_ANALYSIS_RATE,
  BEAT_DETECTOR,
  type BeatAnalysis,
  type BeatOptions,
  MAX_BEAT_AUDIO_S,
  NoBeatsError,
  type Signal as BeatSignal,
  analysePcm,
  detectBeats,
  onsetEnvelope,
  prepareSignal,
} from "./media/beats.js";
export {
  BEATS_CACHE_DIR,
  BEATS_DIR,
  BeatsStore,
  type BeatsStoreOptions,
  type MeasuredBeats,
  beatsCacheKey,
  beatsPathsFor,
  classifyBeatsCache,
  formatBeatsFile,
  ownBeatsFile,
  readBeatsFile,
  resolveBeatsFile,
} from "./media/beats-store.js";
export {
  AUDIO_FX_DIR,
  AUDIO_FX_VERSION,
  type AudioBakeNeed,
  AudioFxService,
  type AudioFxServiceOptions,
  DENOISE_LATENCY_SAMPLES,
  audioFxArgs,
  audioFxCacheKey,
  audioFxFilter,
  classifyAudioFx,
} from "./media/audio-fx.js";
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
  type SourceRange,
  angleFaceKeys,
  decodeYunet,
  faceFrameSize,
  loadYunet,
  mainFaceTrack,
  proposeReframeKeys,
  sampleFaceFrames,
} from "./multicam/faces.js";
export {
  type FrameFormat,
  REFRAME_FACE_AT,
  type ReframeGeometry,
  type ReframeKey,
  type ReframePlacement,
  type ReframePlan,
  parseFrameFormat,
  planReframe,
  reframeBounds,
  reframePlacement,
} from "./reframe.js";
export {
  type DecoderOutput,
  type PhotoInput,
  type PhotoMask,
  type PhotoPoint,
  type PixelSize,
  SEGMENT_CACHE_SIZE,
  SEGMENT_LONG_SIDE,
  type SegmentEngine,
  type SegmentResult,
  Segmenter,
  clickInPreparedSpace,
  encoderInput,
  loadMobileSam,
  masksOfAnswer,
  preparedSize,
  upscaleMask,
} from "./segment/segmenter.js";
export { standInSegmentEngine } from "./segment/stand-in.js";
export { type SegmentFiles,type WorkerSegmentEngine, workerSegmentEngine } from "./segment/engine.js";
export {
  CONTRAST_GAIN,
  GUIDED_EPS,
  GUIDED_RADIUS,
  GUIDED_SUBSAMPLE,
  type PlaneSize,
  TEMPORAL_TAU_S,
  boxMean,
  contrast,
  emaStep,
  emaWeight,
  guidedFilter,
  refineFrame,
  resizeBilinear,
  smoothForwardBackward,
} from "./matte/refine.js";
export { MATTE_MODEL_PIN, type MatteModelSpec, SELFIE, coarseAlpha, modelInput } from "./matte/models.js";
export { MATTES_DIR, MATTE_VERSION, type MatteInfo, classifyMatte, matteKey, mattePaths, readMatteInfo, writeMatteInfo } from "./matte/cache.js";
export {
  type MatteFiles,
  type MatteInfer,
  type MatteVideoRequest,
  type MatteVideoResult,
  etaSeconds,
  loadSelfieMatte,
  matteEncodeArgs,
  matteInWorker,
  matteVideo,
} from "./matte/video.js";
export { type MatteJobDeps, type MatteTarget, computeMatte, formatEta } from "./matte/job.js";
export { standInMatte } from "./matte/stand-in.js";
export { readRawFrames } from "./media/raw-frames.js";
export { type PreparedPhoto, SEGMENT_MODEL_PIN, SegmentService, type SegmentServiceOptions, readPhotoRgb } from "./segment/service.js";
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
export { COMMAND_SPEECH_PROVIDER, commandSpeechProvider, readCommandSpeechProvider } from "./voiceover/command.js";
export { STAND_IN_SPEECH_PROVIDER, standInSpeechProvider } from "./voiceover/stand-in.js";
export { TAKE_KEY_VERSION, type TakeInput, type TakeMark, VOICEOVER_DIR, takeKey, takeMarkOf, takeWavBytes } from "./voiceover/takes.js";
export { TRIM_LEAD_S, TRIM_RANGE_DB, TRIM_TAIL_S, type TrimmedTake, trimSilence } from "./voiceover/trim.js";
export {
  type AnalyzeHooks,
  type AnalyzeRequest,
  AnalyzeService,
  type AnalyzeServiceOptions,
  MAX_ANALYZE_CONTACT_TILES,
  analysisName,
} from "./analyze/service.js";
export { DEFAULT_CUT_THRESHOLD, type Cut, type Shot, type ShotStats, detectCuts, frameStart, shotStats, shotsOf } from "./analyze/shots.js";
export { PALETTE_SIZE, type PaletteColor, PaletteBuilder } from "./analyze/palette.js";
export { type LoudnessReading, measureLoudness, parseLoudness } from "./analyze/loudness.js";
export { type SfxRender, type SfxSpec, synthesizeSfx } from "./sound/sfx.js";
export { SFX_KEY_VERSION, SOUND_DIR, type SoundMark, sfxFile, sfxKey, sfxWavBytes, soundMarkOf } from "./sound/takes.js";
export { REVIEW_DIR, type ReviewRequest, ReviewService, type ReviewServiceOptions } from "./review/service.js";
export { type SheetOptions, type SheetSize, type SheetTile, writeSheet } from "./review/sheet.js";
