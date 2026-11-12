import { createRequire } from "node:module";
import { type Server, type Socket, createServer } from "node:net";
import { readFile } from "node:fs/promises";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  ErrorCode,
  type EventName,
  type EventParams,
  type HandshakeResult,
  type JobInfo,
  type JsonRpcRequest,
  type MatteStateInfo,
  type MethodName,
  type MethodResult,
  type OpenTransaction,
  PROTOCOL_VERSION,
  type Progress,
  agentAuthor,
  RpcError,
  type ValidatedParams,
  type AppDirs,
  PROPOSAL_WAIT_DEFAULT_S,
  INBOX_WAIT_DEFAULT_S,
  type TimelineViewName,
  assertSocketPathFits,
  isMethodName,
  parseRequest,
  readMessages,
  resolveAppDirs,
  writeMessage,
} from "@frameshell/protocol";
import {
  type CaptionPhrase,
  type MulticamGroup,
  type ProgramTrack,
  type ProjectConfig,
  type ShotClip,
  type Timeline,
  type Transcript,
  createTimeline,
  cueTokens,
  findPerson,
  parseTimeline,
  projectFormats,
  subtitleTracks,
  subtitleWords,
} from "@frameshell/schema";
import { parseCaptionText, readCaptionFile, resolveCaptions } from "./timeline/captions.js";
import { runDoctor } from "./binaries/doctor.js";
import { CreditsService } from "./credits/service.js";
import { EncoderCache } from "./encoders/probe.js";
import type { MatteSource } from "./export/compiler.js";
import { ExportService, subjectAssets } from "./export/service.js";
import { EventHub, type EventSink } from "./events.js";
import { canonicalPath, canonicalPathSync, exists, writeTextAtomic } from "./fs-util.js";
import { BinaryManager, type ProjectBinaries } from "./binaries/manager.js";
import { type JobContext, JobQueue, type JobRequest } from "./jobs/queue.js";
import { listenCleaningStaleSocket } from "./listen.js";
import { cleanupLabel, planTimelineCleanup } from "./cleanup/run.js";
import { type Span, dipCurve, speechStretches, voiceRuns } from "./media/duck.js";
import { BeatsStore, beatsFileOf, formatBeatsFile, ownBeatsFile, resolveBeatsFile, summarizeBeats } from "./media/beats-store.js";
import { EnergyStore } from "./media/energy-store.js";
import { MediaService } from "./media/service.js";
import { AudioFxService } from "./media/audio-fx.js";
import { probeMedia } from "./media/ffmpeg.js";
import { type TurnsSource, groupTurns } from "./multicam/group-turns.js";
import { MotionStore, groupMotion } from "./multicam/motion.js";
import { humanShots, loadDirectorRules, lowShots, unknownWeights } from "./multicam/direct.js";
import { readJournal, timelinesHolding } from "./history/journal.js";
import { historyElsewhere } from "./history/revert.js";
import { measureAngles, syncReport } from "./multicam/measure.js";
import { analyseGallery } from "./multicam/gallery.js";
import { FACE_SAMPLE_HZ, type FacePoint, type FaceScanner, proposeReframeKeys, yunetWorkerScanner } from "./multicam/faces.js";
import { parseFrameFormat, planReframe } from "./reframe.js";
import {
  FACE_DETECTION_MODEL,
  FACE_RECOGNITION_MODEL,
  ONNX_RUNTIME_WEB,
  PHOTO_SEGMENTATION_DECODER_MODEL,
  PHOTO_SEGMENTATION_ENCODER_MODEL,
  SPEAKER_EMBEDDING_MODEL,
  VIDEO_MATTE_MODEL,
} from "./binaries/manifest.js";
import { matteKey, mattePaths, readMatteInfo, type MatteInfo } from "./matte/cache.js";
import { computeMatte } from "./matte/job.js";
import { MATTE_MODEL_PIN } from "./matte/models.js";
import { workerSegmentEngine } from "./segment/engine.js";
import type { SegmentEngine } from "./segment/segmenter.js";
import { checkMask, cutoutTransform, freeCutoutName, isMediaClip, renderCutout, resolveMask } from "./segment/cutout.js";
import { SEGMENT_MODEL_PIN, SegmentService } from "./segment/service.js";
import { type GallerySource, galleryReport, planGallery } from "./multicam/gallery-plan.js";
import { projectFormat, type ProjectFormat } from "./media/format.js";
import { ClipRenderer, listTimelineIds } from "./clips/renderer.js";
import { PluginHost } from "./plugins/host.js";
import { type FaceScans, PeopleService, type VoicePrinter } from "./people/service.js";
import { readProjectFaceScans, scanProjectFaces } from "./people/scan-run.js";
import { type PeopleScanner, peopleScanWorker } from "./people/scan.js";
import { type VoiceEmbedder, campplusWorkerEmbedder } from "./people/voice-embed.js";
import { computeVoicePrints, voiceKey } from "./people/voices.js";
import { fileUses } from "./file-uses.js";
import { FormatService, builtinFormatInfos, formatInfos, projectConfigDocument } from "./formats.js";
import { ConfigJournal, configOperation, readConfigJournal } from "./config/journal.js";
import { configReverted } from "./config/revert.js";
import { ProjectRegistry, readEnclosingProject } from "./projects.js";
import { syncedFolder } from "./synced-folder.js";
import { FileTransactionStore, TransactionTracker, isTouchedTimeline } from "./history/transactions.js";
import { ReviewSwitch } from "./proposals/review-switch.js";
import { IdempotencyCache } from "./idempotency.js";
import { checkScript } from "./scripts/check.js";
import { AGENT_SKILLS_DIR } from "./plugins/skills.js";
import { CORE_SKILL_NAME, installCoreSkill } from "./skills/install.js";
import { coreSkillState, refreshCoreSkill } from "./skills/refresh.js";
import { assembleShoot, planScenes } from "./shoot/assemble.js";
import { ShootService } from "./shoot/service.js";
import {
  type SessionTake,
  ffmpegRangeExtractor,
  readTakeWords,
  standInProvider,
  standInWords,
  takeWordsPath,
  transcribeTake,
  writeSessionTranscripts,
} from "./shoot/session.js";
import { outlineScript } from "./scripts/outline.js";
import { showStyle } from "./style/read.js";
import type { OperationRequest } from "./timeline/engine.js";
import { TimelineService, type TxRef, projectPath, timelinePath } from "./timeline/service.js";
import { FrameGrid } from "./timeline/grid.js";
import { TimelineWatcher } from "./timeline/watcher.js";
import { energySnapper } from "./timeline/snap.js";
import { type AudioExtractor, extractAudioWithFfmpeg } from "./transcripts/audio.js";
import { type Diarizer, diarizeAsset } from "./transcripts/speakers.js";
import { ModelRegistry, notRegistered } from "./transcripts/model-registry.js";
import { type TranscriberTools, providerContext, resolveAsset, resolveTranscript, transcribeAsset } from "./transcripts/transcriber.js";
import { verifyExport } from "./transcripts/verify.js";
import { UiBroker } from "./ui/broker.js";
import { AgentTargets } from "./targets/inbox.js";
import { writeContext } from "./context.js";
import { InspectService } from "./inspect/service.js";
import { resolveNested } from "./timeline/nested.js";
import type { SpeechProvider } from "@frameshell/plugin-api";
import { COMMAND_SPEECH_PROVIDER, commandNotConfigured, readCommandSpeechProvider } from "./voiceover/command.js";
import { generateVoiceover } from "./voiceover/generate.js";
import { ReviewService } from "./review/service.js";

/** Package version reported in the handshake. */
export const DAEMON_VERSION: string = (createRequire(import.meta.url)("../package.json") as { version: string })
  .version;

/** Five minutes: long enough to span an agent's think time between CLI calls. */
export const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60_000;

/** Options for {@link startDaemon}. */
export interface DaemonOptions {
  /** Unix socket path or Windows pipe name; see `resolveSocketPath`. */
  socketPath: string;
  /**
   * Exit after this long with no connected clients and no queued or running
   * jobs. Counted from start, from each last disconnect and from the end of
   * the last job. `Infinity` disables.
   */
  idleTimeoutMs?: number;
  /** Per-user directories: binaries, global config, trust. Defaults to `resolveAppDirs()`. */
  dirs?: AppDirs;
  /** Native binaries. Defaults to a manager over {@link DaemonOptions.dirs} and the pinned manifest. */
  binaries?: BinaryManager;
  /** Background jobs (ingest) run at once. Default 2: each ffmpeg already uses every core. */
  jobConcurrency?: number;
  /** Audio extraction for `transcribe` and for energy snapping of assets without sidecar. Defaults to ffmpeg from {@link DaemonOptions.binaries}. */
  extractAudio?: AudioExtractor;
  /** Speaker diarization for `transcribe.speakers`. Defaults to sherpa-onnx segments and CAM++ on ONNX Runtime Web from {@link DaemonOptions.binaries}. */
  diarize?: Diarizer;
  /** Face scan of one angle for `multicam.faces`. Defaults to YuNet on ONNX Runtime Web from {@link DaemonOptions.binaries}, in a worker thread. */
  faceScanner?: FaceScanner;
  /** Face scan of one video for `people.scan`. Defaults to YuNet and SFace on ONNX Runtime Web from {@link DaemonOptions.binaries}, in a worker thread. */
  peopleScanner?: PeopleScanner;
  /** Speaker embeddings for `people.suggest` voice prints. Defaults to CAM++ on ONNX Runtime Web from {@link DaemonOptions.binaries}, in a worker thread. */
  voiceEmbedder?: VoiceEmbedder;
  /** Photo segmentation model for `segment.prepare`. Defaults to MobileSAM on ONNX Runtime Web from {@link DaemonOptions.binaries}, in a worker thread. */
  segmentEngine?: SegmentEngine;
  /**
   * End-to-end tests only: takes recorded in the app are "heard" as their scene's words without its last line
   * ({@link standInWords}) instead of being transcribed. Default false.
   */
  shootStandIn?: boolean;
  /**
   * Speech providers built into this daemon (ADR 0034), usable in every project, trusted or not; looked up before
   * plugin providers. `frameshelld` adds the stand-in under `FRAMESHELL_SPEECH_STAND_IN=1`. Default none.
   */
  speechProviders?: readonly SpeechProvider[];
  /**
   * Tests only: `matte.prepare` takes whatever is brighter than mid-gray as the subject (`standInMatte`) and
   * names the model `stand-in`, so nothing is downloaded. Default false.
   */
  matteStandIn?: boolean;
  /** Video segments a render encodes at once. Default: half the cores, 1 to 4. */
  renderParallelism?: number;
  /** Render video segment length in seconds. Default 10. */
  renderSegmentSeconds?: number;
  /**
   * Operations from one terminal session join one transaction until this long
   * passes without one (SPEC §6.2). Default {@link DEFAULT_TX_IDLE_GAP_MS}.
   */
  txIdleGapMs?: number;
  /** Transaction clock in epoch ms (idle gaps, auto-commit deadlines). Default `Date.now`. Tests skew it to pass deadlines without waiting. */
  txNow?: () => number;
}

/** Running daemon handle. */
export interface Daemon {
  readonly socketPath: string;
  /** Resolves once the daemon has stopped, by idle timeout or {@link Daemon.close}. */
  readonly closed: Promise<void>;
  /** Stop listening, drop clients, release the socket. Idempotent. */
  close(): Promise<void>;
}

/** Per-connection identity from the handshake. */
interface Caller {
  client: string;
  session: string | null;
  /** Agent the client named in its handshake; null = none; undefined = the app's tag of its session decides. */
  agent?: string | null | undefined;
}

/** Per-request services. `progress` sends `progress` notifications for this request; no-op for notifications. */
interface RequestContext {
  progress(update: Progress): void;
  /** This connection, as the target of its event subscriptions. */
  sink: EventSink;
}

/** One handler per registry method; params arrive already validated. */
type Handlers = {
  [M in MethodName]: (params: ValidatedParams<M>, caller: Caller, request: RequestContext) => Promise<MethodResult<M>>;
};

/**
 * Start frameshelld on `socketPath`.
 *
 * Rejects with code `EADDRINUSE` when a live daemon already owns the socket,
 * or `ENAMETOOLONG` when the unix socket path exceeds the OS limit.
 * A stale unix socket left by a crashed daemon is removed first.
 */
export async function startDaemon(options: DaemonOptions): Promise<Daemon> {
  const { socketPath } = options;
  assertSocketPathFits(socketPath);
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const startedAt = Date.now();
  const clients = new Set<Socket>();
  const dirs = options.dirs ?? resolveAppDirs();
  const binaries = options.binaries ?? new BinaryManager(dirs);
  const encoderCache = new EncoderCache(binaries.dataDir);
  const models = new ModelRegistry(dirs.configDir);
  /** Binaries, pinned models and this machine's registered models for a transcription provider. */
  const transcriberTools = (overrides: ProjectBinaries): TranscriberTools => ({
    ensureBinary: (name, onProgress) => binaries.ensure(name, overrides, { onProgress }),
    ensureModel: (id, onProgress) => binaries.ensureModel(id, { onProgress }),
    userModel: (id, formats) => models.resolve(id, formats),
  });
  /** Model of a transcription when the caller names none: the project's, else this machine's default. */
  const configuredModel = async (config: ProjectConfig, providerId: string) =>
    config.transcription?.model ?? (await models.defaultFor(providerId));
  /**
   * Throw `ModelNotRegistered` for a model id that is neither registered here nor shipped by provider `providerId`
   * of the project at `dir`. Ids are not checked when the provider cannot be loaded, or does not list its models.
   */
  const checkModelId = async (model: string, providerId: string, dir: string | null) => {
    if ((await models.has(model)) || dir === null) return;
    const provider = await plugins.transcriptionProvider(dir, providerId).catch(() => null);
    if (!provider?.models || provider.models.some((pinned) => pinned.id === model) || provider.defaultModel === model) return;
    throw notRegistered(model, "unknown");
  };
  const events = new EventHub();
  // Hub key of each root as jobs and media name it (the caller's spelling). `events.subscribe` keys by
  // `canonicalPath`: publishing under the raw root misses subscribers of another spelling (Windows 8.3
  // `RUNNER~1`, symlinks). Resolved synchronously, memoized per root: an event is written in the same tick as
  // its change, so no reply snapshotting a later state can overtake it (#79).
  const hubKeys = new Map<string, string>();
  const publishFor = <E extends EventName>(event: E, root: string, params: EventParams<E>): void => {
    let key = hubKeys.get(root);
    if (key === undefined) hubKeys.set(root, (key = canonicalPathSync(root)));
    events.publish(event, key, params);
  };
  const jobs = new JobQueue({ concurrency: options.jobConcurrency ?? 2, onBusyChange: () => armIdleTimer() });
  jobs.watch(({ job }) => publishFor("job.progress", job.project, { project: job.project, job }));
  // Own queue: an export job waits for clip renders, which must never wait for its slot. One at a time: headless Chrome is heavy.
  const clipJobs = new JobQueue({ concurrency: 1, idPrefix: "j_c", onBusyChange: () => armIdleTimer() });
  clipJobs.watch(({ job }) => publishFor("job.progress", job.project, { project: job.project, job }));
  /** Jobs of both queues, oldest first. */
  const listJobs = (filter: { project: string; active?: boolean }) =>
    [...jobs.list(filter), ...clipJobs.list(filter)].sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
  const projectBinaries = async (dir: string) => {
    const project = await readEnclosingProject(dir);
    return project ? { dir: project.dir, binaries: project.config.binaries } : undefined;
  };
  /** Root spelled as the project was opened, by canonical path: timeline events carry canonical roots. */
  const openedRoots = new Map<string, string>();
  const matteModel = options.matteStandIn === true ? "stand-in" : MATTE_MODEL_PIN;
  const media = new MediaService({
    binaries,
    jobs,
    matteModel,
    onAssetChanged: (root, path, asset) => publishFor("asset.changed", root, { project: root, path, asset }),
  });
  const audioFx = new AudioFxService({
    jobs,
    hash: (dir, asset) => media.hash(dir, asset),
    hasAudio: async (dir, asset) => (await media.probe(dir, asset)).audio !== null,
    ffmpeg: async (dir) => binaries.ensure("ffmpeg", await projectBinaries(dir)),
    timelines: (dir) => listTimelineIds(dir),
    flattened: async (dir, id) => {
      const parsed = parseTimeline(JSON.parse(await readFile(join(dir, "timelines", `${id}.json`), "utf8")));
      if (!parsed.ok) throw new Error(parsed.error);
      return resolveNested(dir, parsed.value);
    },
  });
  const segmentModel = options.segmentEngine?.model ?? SEGMENT_MODEL_PIN;
  const segmentation = new SegmentService({
    probe: (dir, asset) => media.probe(dir, asset),
    hash: (dir, asset) => media.hash(dir, asset),
    ffmpeg: async (dir, onProgress) => binaries.ensure("ffmpeg", await projectBinaries(dir), { onProgress }),
    engine: async (dir, onProgress) =>
      options.segmentEngine ??
      workerSegmentEngine({
        runtime: await binaries.ensure(ONNX_RUNTIME_WEB, await projectBinaries(dir), { onProgress }),
        encoder: await binaries.ensureModel(PHOTO_SEGMENTATION_ENCODER_MODEL, { onProgress }),
        decoder: await binaries.ensureModel(PHOTO_SEGMENTATION_DECODER_MODEL, { onProgress }),
      }),
  });
  const timelineWatcher = new TimelineWatcher({ onChange: (dir, id): Promise<void> => timelines.reconcile(dir, id) });
  /** Skill files updated on their own when a project opened, by canonical root, until `status` reports them. */
  const skillUpdates = new Map<string, string[]>();
  const projects = new ProjectRegistry({
    onOpen: (dir) => {
      // An unedited older copy of the agent skill becomes this version's; never blocks opening (#396).
      void refreshCoreSkill(dir).then(
        (result) => {
          if (result.written.length + result.removed.length > 0) skillUpdates.set(canonicalPathSync(dir), [...result.written, ...result.removed]);
        },
        () => undefined,
      );
      media.attach(dir);
      timelineWatcher.attach(dir);
      const key = canonicalPathSync(dir);
      if (!openedRoots.has(key)) openedRoots.set(key, dir);
      clips.attach(openedRoots.get(key)!);
    },
    writeTimeline: async (dir, id, content, author = "file") => {
      // The saver's transaction, like any operation of theirs (SPEC §6.2).
      const key = transactionKey(author);
      const tx = transactions.next(key);
      await transactions.touching(key, tx, { root: dir, timeline: id });
      if (await timelines.writeFile(dir, id, content, { author, tx })) await transactions.applied(key, tx);
      await settle(key, tx);
    },
  });
  const readProjectConfig = async (dir: string) => (await readEnclosingProject(dir))!.config;
  // ADR 0036: every project-config change goes through this journal, so history, revert and tx.abort cover it.
  const configJournal = new ConfigJournal({
    docs: { project: projectConfigDocument({ readConfig: readProjectConfig, writeFormats: (dir, list) => projects.writeFormats(dir, list) }) },
  });
  const formats = new FormatService({ readConfig: readProjectConfig, journal: configJournal });
  const plugins = new PluginHost({
    dirs,
    pins: projects,
    // Plugins see changes the project watcher cannot (code outside the project): `clips` exists by the time any plugin loads.
    refreshRenders: (root) => void clips.refresh(root).catch(() => {}),
  });
  /** Managed (or project-overridden) ffmpeg for the project around `dir`. */
  const projectFfmpeg = async (dir: string) => {
    const project = await readEnclosingProject(dir);
    return binaries.ensure("ffmpeg", project ? { dir: project.dir, binaries: project.config.binaries } : undefined);
  };
  const energy = new EnergyStore({
    derivedAudio: (dir, rel) => media.derivedAudio(dir, rel),
    ffmpeg: projectFfmpeg,
    extractAudio: options.extractAudio,
  });
  const beats = new BeatsStore({
    derivedAudio: (dir, rel) => media.derivedAudio(dir, rel),
    ffmpeg: projectFfmpeg,
    extractAudio: options.extractAudio,
  });
  const motion = new MotionStore({ ffmpeg: projectFfmpeg });
  const gallery: GallerySource = {
    probe: (dir, asset) => media.probe(dir, asset),
    analyse: async (dir, asset, picture) => analyseGallery(await projectFfmpeg(dir), join(dir, ...asset.split("/")), picture),
  };
  const transactions = new TransactionTracker({
    idleGapMs: options.txIdleGapMs,
    ...(options.txNow ? { now: options.txNow } : {}),
    store: new FileTransactionStore(dirs.dataDir, socketPath),
    // Review mode (ADR 0019 §3): a closed transaction's proposal waits for review.
    onClosed: (_author, tx) => void timelines.ready(tx.id).catch(() => {}),
  });
  await transactions.restore();
  const review = new ReviewSwitch(dirs);
  const people = new PeopleService({
    onChanged: (dir, change, person) => publishFor("people.changed", dir, { project: dir, change, ...(person !== undefined ? { person } : {}) }),
  });
  /** Running `voiceover.generate` calls, by canonical project root: one at a time per project. */
  const voiceoverRuns = new Map<string, Promise<void>>();
  /** Aborts provider calls when the daemon stops. */
  const voiceoverAbort = new AbortController();
  /** Transcriptions of takes recorded in the app, by `<root>\0<take>`: `shoot.session.end` waits for them. */
  const takeRuns = new Map<string, Promise<void>>();
  /** Why the last transcription of such a take failed, by the same key; gone once it runs again. */
  const takeFailures = new Map<string, { message: string; dir: string; script: string; take: SessionTake }>();
  const shoots = new ShootService({
    onChanged: (dir, script, change, take) => publishFor("shoot.changed", dir, { project: dir, script, change, ...(take !== undefined ? { take } : {}) }),
    analyzing: (dir, take) => takeRuns.has(`${dir}\0${take}`),
    failure: (dir, take) => takeFailures.get(`${dir}\0${take}`)?.message ?? null,
    transcription: async (dir) => {
      if (options.shootStandIn) return { provider: "stand-in", ready: true, problem: null };
      const provider = (await readEnclosingProject(dir))?.config.transcription?.provider ?? "whisper-cpp";
      return plugins.transcriptionProvider(dir, provider).then(
        () => ({ provider, ready: true, problem: null }),
        (error: unknown) => ({ provider, ready: false, problem: (error as Error).message }),
      );
    },
    assetHash: async (dir, rel) => (await media.list(dir)).find((asset) => asset.path === rel)?.hash ?? null,
    timeline: async (dir, id) => (await exists(timelinePath(dir, id))) ? (await timelines.viewTimeline(dir, id, "current")).timeline : null,
  });
  /** Cached face scans of every file in `assets/`; content hashes come from the media index. */
  const faceScans =
    (dir: string): FaceScans =>
    async () =>
      readProjectFaceScans(
        dir,
        (await media.list(dir)).map((asset) => asset.path),
        async (d, rel) => (await media.derivedAudio(d, rel)).hash,
      );
  /** Voice prints of one project for one request; the speaker model is installed only when a print is not cached. */
  const voicePrinter = (dir: string, progress: (update: Progress) => void): VoicePrinter => {
    const embed: VoiceEmbedder =
      options.voiceEmbedder ??
      (async (request) => {
        const project = await projectBinaries(dir);
        return campplusWorkerEmbedder({
          runtime: await binaries.ensure(ONNX_RUNTIME_WEB, project, { onProgress: progress }),
          model: await binaries.ensureModel(SPEAKER_EMBEDDING_MODEL, { onProgress: progress }),
        })(request);
      });
    return (wanted) =>
      computeVoicePrints({
        root: dir,
        wanted,
        embed,
        tools: { ensureBinary: async (name, onProgress) => binaries.ensure(name, await projectBinaries(dir), { onProgress }) },
        media: { derivedAudio: (rel, onProgress) => media.derivedAudio(dir, rel, onProgress) },
        extractAudio: options.extractAudio ?? extractAudioWithFfmpeg,
        progress,
      });
  };
  /** Bytes the voice model (ONNX Runtime Web and CAM++) still has to download; 0 when installed or a test embedder stands in. */
  const voiceDownloadBytes = async (dir: string): Promise<number> => {
    if (options.voiceEmbedder) return 0;
    const runtime = await binaries.locate(ONNX_RUNTIME_WEB, await projectBinaries(dir));
    const model = await binaries.locateModel(SPEAKER_EMBEDDING_MODEL);
    const runtimeBytes = runtime.installed ? 0 : (runtime.pinned?.archives.reduce((sum, archive) => sum + archive.size, 0) ?? 0);
    return runtimeBytes + (model.installed ? 0 : model.pinned.size);
  };
  /** After an operation of `key` in `tx`: a proposal whose transaction is already over (no grouping) is ready. */
  const settle = async (key: string, tx: TxRef) => {
    if (!transactions.isOpen(key, tx)) await timelines.ready(tx.id);
  };
  const replays = new IdempotencyCache();
  const timelines = new TimelineService({
    probe: (dir, asset) => media.probe(dir, asset),
    clipTypes: (dir) => plugins.clipTypes(dir),
    resolveEditPoint: (dir, fps) =>
      energySnapper({
        fps,
        hasAudio: async (asset) => (await media.probe(dir, asset)).audio !== null,
        profile: (asset) => energy.profile(dir, asset),
      }),
    // `root` is canonical, the hub's key; each connection gets `project` spelled as it subscribed.
    onChanged: ({ root, timeline, revision, author, changes, warnings }) => {
      events.publish("timeline.changed", root, { project: root, timeline, revision, author, changes, ...(warnings ? { warnings } : {}) });
      // A new or changed generated clip renders in the background (SPEC §6.5).
      const opened = openedRoots.get(root);
      if (opened) void clips.refresh(opened).catch(() => {});
    },
    onRejected: ({ root, ...rejection }) => events.publish("timeline.rejected", root, { project: root, ...rejection }),
    fileTx: () => transactions.next("file"),
    reviewEnabled: (dir) => review.enabled(dir),
    txOpen: (tx) => transactions.isOpenTx(tx),
    onProposal: ({ root, endsTx, ...change }) => {
      events.publish("proposal.changed", root, { project: root, ...change });
      // A building proposal closed unapplied ends its transaction (ADR 0019 §7).
      if (endsTx) void transactions.drop(transactionKey(change.author), change.tx).catch(() => {});
    },
  });
  const credits = new CreditsService({ hash: (dir, rel) => media.hash(dir, rel) });
  const exports = new ExportService({
    jobs,
    provenance: (dir, assets) => credits.warnings(dir, assets),
    ffmpeg: async (dir) => {
      const project = await readEnclosingProject(dir);
      return binaries.ensure("ffmpeg", project ? { dir: project.dir, binaries: project.config.binaries } : undefined);
    },
    probe: (dir, asset) => media.probe(dir, asset),
    loadTimeline: (dir, id) => timelines.load(dir, id),
    pluginPresets: async (dir) => (await plugins.presets(dir)).presets,
    encoder: (ffmpeg) => encoderCache.pick(ffmpeg),
    clips: {
      check: (dir, timeline) => clips.check(clipRoot(dir), timeline),
      ensure: (dir, timeline, onProgress, size) => clips.ensure(clipRoot(dir), timeline, onProgress, size),
    },
    audioFx,
    mattes: {
      prepare: async (dir, assets) => {
        const ready: { asset: string; hash: string; proxy: string }[] = [];
        for (const asset of assets) {
          const { hash, proxy } = await media.ingested(dir, asset);
          if (proxy) ready.push({ asset, hash, proxy });
        }
        return {
          assets: ready.map((one) => one.asset),
          make: async (onProgress, signal) => {
            const found = new Map<string, MatteSource>();
            for (const [index, one] of ready.entries()) {
              const share = (fraction: number) => onProgress?.((index + fraction) / ready.length);
              const made = await makeMatte(dir, one.asset, one, { signal, onProgress: share });
              found.set(one.asset, { path: join(dir, ...mattePaths(made.key).video.split("/")), width: made.info.width, height: made.info.height });
            }
            onProgress?.(1);
            return found;
          },
        };
      },
    },
    ...(options.renderParallelism !== undefined ? { parallelism: options.renderParallelism } : {}),
    ...(options.renderSegmentSeconds !== undefined ? { segmentSeconds: options.renderSegmentSeconds } : {}),
  });
  const reviews = new ReviewService({
    timelines,
    exports,
    ffmpeg: async (dir) => binaries.ensure("ffmpeg", await projectBinaries(dir)),
    ffprobe: async (dir) => binaries.ensure("ffprobe", await projectBinaries(dir)),
  });
  const clips = new ClipRenderer({
    jobs: clipJobs,
    adapters: (dir) => plugins.clipAdapters(dir),
    unavailable: (dir, type) => plugins.clipTypeUnavailable(dir, type),
    timelines: (dir) => listTimelineIds(dir),
    load: (dir, id) => timelines.load(dir, id),
    peek: async (dir, id) => {
      const parsed = parseTimeline(JSON.parse(await readFile(join(dir, "timelines", `${id}.json`), "utf8")));
      if (!parsed.ok) throw new Error(parsed.error);
      return parsed.value;
    },
    format: async (dir) => {
      const config = (await readEnclosingProject(dir))?.config;
      return { fps: config?.fps ?? 30, width: config?.resolution.width ?? 1920, height: config?.resolution.height ?? 1080 };
    },
    formatSizes: async (dir) => {
      const config = (await readEnclosingProject(dir))?.config;
      return config ? projectFormats(config).slice(1) : [];
    },
    probe: async (dir, file, signal) => {
      const probe = await probeMedia(await binaries.ensure("ffprobe", await projectBinaries(dir)), file, signal);
      return { width: probe.video?.width ?? 0, height: probe.video?.height ?? 0, duration: probe.duration };
    },
    ensureBinary: async (dir, name) => binaries.ensure(name, await projectBinaries(dir)),
  });
  /** One spelling per project for the clip renderer, whatever spelling the caller used: its jobs and cache state are keyed by it. */
  const clipRoot = (dir: string): string => {
    const key = canonicalPathSync(dir);
    if (!openedRoots.has(key)) openedRoots.set(key, dir);
    return openedRoots.get(key)!;
  };
  const inspector = new InspectService({
    timeline: async (dir, id) => {
      const { timeline, fps } = await timelines.load(dir, id);
      return { timeline: await resolveNested(dir, timeline, undefined, fps), fps };
    },
    resolution: async (dir) => (await readEnclosingProject(dir))?.config.resolution ?? { width: 1920, height: 1080 },
    pictureSize: async (dir, asset) => {
      const video = (await media.probe(dir, asset)).video;
      return video ? { width: video.width, height: video.height } : null;
    },
    live: (dir, timeline, clip) => clips.live(clipRoot(dir), timeline, clip),
    chrome: async (dir) => binaries.ensure("chrome-headless-shell", await projectBinaries(dir)),
    imageProject: async (dir) => (await readEnclosingProject(dir))?.config.kind === "image",
    segment: async (dir, asset, point, onProgress) => ({ ...(await segmentation.segment(dir, asset, point, onProgress)), model: segmentModel }),
  });
  /** Transcriptions and export verifies running, per canonical project root: `gc` leaves their WAVs alone meanwhile. */
  const transcriptions = new Map<string, number>();
  const transcribing = async <T>(dir: string, work: () => Promise<T>): Promise<T> => {
    const key = canonicalPathSync(dir);
    transcriptions.set(key, (transcriptions.get(key) ?? 0) + 1);
    try {
      return await work();
    } finally {
      const left = transcriptions.get(key)! - 1;
      if (left > 0) transcriptions.set(key, left);
      else transcriptions.delete(key);
    }
  };
  /**
   * Queue the `shoot` job of a take cut in the app: its range of each sound file to PCM, transcribed with the
   * project's provider and model (or the stand-in), then compared, which publishes `shoot.changed` `analyzed`.
   */
  const queueTake = (dir: string, script: string, take: SessionTake): JobInfo => {
    const key = `${dir}\0${take.id}`;
    let finish!: () => void;
    takeRuns.set(key, new Promise<void>((resolve) => (finish = resolve)));
    return jobs.enqueue({
      kind: "shoot",
      project: dir,
      asset: take.asset,
      output: takeWordsPath(dir, take.id),
      run: async (ctx) => {
        takeFailures.delete(key);
        try {
          const { config } = (await readEnclosingProject(dir))!;
          const overrides = { dir, binaries: config.binaries };
          const providerId = options.shootStandIn ? "stand-in" : (config.transcription?.provider ?? "whisper-cpp");
          const provider = options.shootStandIn
            ? standInProvider(standInWords(await shoots.script(dir, script), take.scene))
            : await plugins.transcriptionProvider(dir, providerId);
          ctx.update({ step: "transcribe", progress: 0.1 });
          await transcribeTake({
            root: dir,
            take,
            extract: ffmpegRangeExtractor(() => binaries.ensure("ffmpeg", overrides), ctx.signal),
            providerId,
            provider,
            model: await configuredModel(config, providerId),
            language: config.transcription?.language,
            context: providerContext(transcriberTools(overrides), () => {}).context,
          });
          takeRuns.delete(key);
          await shoots.status(dir, dir, script);
        } catch (error) {
          takeFailures.set(key, { message: (error as Error).message, dir, script, take });
          takeRuns.delete(key);
          publishFor("shoot.changed", dir, { project: dir, script, change: "failed", take: take.id });
          throw error;
        } finally {
          takeRuns.delete(key);
          finish();
        }
      },
    });
  };
  /** Run one timeline operation for `caller` in its transaction; params minus `cwd`/`timeline` are the op's args. */
  const operate = async (
    op: OperationRequest["op"],
    params: { cwd: string; timeline: string; [arg: string]: unknown },
    caller: Caller,
    onApplied?: (after: Timeline) => void,
    prepare?: (current: Timeline, request: OperationRequest) => Promise<OperationRequest>,
  ) => {
    const { cwd, timeline, ...args } = params;
    const request = { op, args } as OperationRequest;
    const dir = await root(cwd);
    const key = authorOf(caller);
    const tx = transactions.next(key);
    await transactions.touching(key, tx, { root: dir, timeline });
    const result = await timelines.apply({
      root: dir,
      cwd,
      timeline,
      request,
      author: journalAuthorOf(caller),
      tx,
      ...(onApplied ? { onApplied } : {}),
      ...(prepare ? { prepare: (current: Timeline) => prepare(current, request) } : {}),
    });
    await transactions.applied(key, tx);
    await settle(key, tx);
    return result;
  };
  /** `multicam.create`: measure (or take the known offsets of) the files, then add the group, its program track and first shot. */
  const createGroup = async (
    { cwd, timeline, assets, names, mics, micNames, soundOf, name, offsets, screens }: ValidatedParams<"multicam.create">,
    caller: Caller,
  ): Promise<MethodResult<"multicam.create">> => {
      const dir = await root(cwd);
      const outside = screens?.find((screen) => screen > assets.length);
      if (outside !== undefined) {
        throw new RpcError(ErrorCode.InvalidOperation, `multicam.create: screen ${outside} is not a camera number (1 to ${assets.length}).`, {
          op: "multicam.create",
          reason: "screens",
          field: "screens",
        });
      }
      const measured = await measureAngles({ probe: (d, a) => media.probe(d, a), profile: (d, a) => energy.profile(d, a) }, {
        root: dir,
        cwd,
        assets,
        names,
        mics,
        micNames,
        soundOf,
        offsets,
      });
      const angles = measured.assets.map((asset, i) => ({
        asset,
        ...(names ? { name: names[i]! } : {}),
        offset: measured.plan[i]!.offset,
        ...(measured.soundOf[i] !== undefined ? { mic: measured.soundOf[i]! } : {}),
        ...(screens?.includes(i + 1) ? { screen: true } : {}),
      }));
      const micFiles = measured.mics.map((asset, i) => ({
        asset,
        ...(micNames ? { name: micNames[i]! } : {}),
        offset: measured.plan[measured.assets.length + i]!.offset,
      }));
      // Read from the timeline this operation wrote: a later write by someone else cannot change the answer.
      let written: Timeline | undefined;
      const result = await operate("multicam.create", { cwd, timeline, angles, ...(micFiles.length > 0 ? { mics: micFiles } : {}), ...(name ? { name } : {}) }, caller, (after) => {
        written = after;
      });
      const group = written?.groups?.find((candidate) => result.changes.added.includes(candidate.id));
      const track = written?.tracks.find((candidate) => candidate.kind === "program" && candidate.group === group?.id);
      if (!group || !track || track.kind !== "program") throw new Error("multicam.create: the operation wrote no new group");
      const { sync, warnings } = syncReport(group, measured.plan);
      return { ...result, group: group.id, track: track.id, clip: track.clips[0]!.id, sync, warnings: [...result.warnings, ...warnings] };
    };
  /** `shoot.assemble`. */
  const assemble = async ({ cwd, script, scenes: wanted, snap }: ValidatedParams<"shoot.assemble">, caller: Caller): Promise<MethodResult<"shoot.assemble">> => {
      const dir = await root(cwd);
      const status = await shoots.status(dir, cwd, script);
      const timeline = status.timeline;
      const unknown = (wanted ?? []).filter((slug) => !status.scenes.some((scene) => scene.slug === slug));
      if (unknown.length > 0) {
        throw new RpcError(ErrorCode.InvalidOperation, `shoot.assemble: no scene ${unknown.join(", ")} in ${status.script}; scenes: ${status.scenes.map((scene) => scene.slug).join(", ")}.`, {
          op: "shoot.assemble",
          reason: "unknown scene",
          field: "scenes",
        });
      }
      let created = false;
      if (!(await exists(timelinePath(dir, timeline)))) {
        await timelines.writeFile(dir, timeline, `${JSON.stringify(createTimeline(timeline), null, 2)}\n`);
        created = true;
      }
      const key = authorOf(caller);
      const next = transactions.next(key, { standalone: true });
      const titles = wanted?.length === 1 ? status.scenes.find((scene) => scene.slug === wanted[0])!.title : status.script;
      const tx = transactions.isOpen(key, next) ? next : { id: next.id, label: `Assemble ${titles}` };
      const author = journalAuthorOf(caller);
      let changed = false;
      const warnings: string[] = [];
      await transactions.touching(key, tx, { root: dir, timeline });
      try {
        const outcomes = await assembleShoot(
          planScenes(status),
          wanted ? new Set(wanted) : null,
          new Set(status.takes.map((take) => take.id)),
          {
            load: async () => (await loadFor(dir, timeline, caller)).timeline,
            apply: async (request) => {
              const result = await timelines.apply({ root: dir, cwd, timeline, request, author, tx });
              await transactions.applied(key, tx);
              changed = true;
              warnings.push(...result.warnings);
              return { added: result.changes.added };
            },
            hasVideo: async (asset) => (await media.probe(dir, asset)).video !== null,
          },
          snap,
        );
        return { timeline, created, tx: changed ? tx.id : null, scenes: outcomes, warnings };
      } finally {
        await settle(key, tx);
      }
    };
  /** Results of jobs queued by {@link inJob}, by job id: a request that finds one running for its input waits it out. */
  const awaitedJobs = new Map<string, Promise<unknown>>();
  /**
   * Run `work` as a background job of `jobs` and resolve with what it returns:
   * the job (and its writes) goes on if the caller disconnects, `job.list` shows
   * it, and the daemon stays up while it runs. A job of the same kind on the
   * same input already running is waited for, then this one is queued.
   */
  const inJob = async <T>(job: Omit<JobRequest, "run">, work: (ctx: JobContext) => Promise<T>): Promise<T> => {
    for (;;) {
      let settle!: { resolve: (value: T) => void; reject: (error: unknown) => void };
      const done = new Promise<T>((resolve, reject) => (settle = { resolve, reject }));
      const info = jobs.enqueue({
        ...job,
        run: async (ctx) => {
          try {
            settle.resolve(await work(ctx));
          } catch (error) {
            settle.reject(error);
            throw error;
          }
        },
      });
      const running = awaitedJobs.get(info.id);
      if (running) {
        await running.catch(() => {});
        continue;
      }
      awaitedJobs.set(info.id, done);
      const canceled = () => settle.reject(new RpcError(ErrorCode.InternalError, `The daemon stopped before job ${info.id} (${job.kind}) finished.`));
      const stop = jobs.watch(({ job: change }) => {
        if (change.id === info.id && change.state === "canceled") canceled();
      });
      if (info.state === "canceled") canceled();
      try {
        return await done;
      } finally {
        stop();
        awaitedJobs.delete(info.id);
      }
    }
  };
  /** Mattes being made, by canonical root and cache key, with whether they were found made already. */
  const matting = new Map<string, Promise<{ info: MatteInfo; cached: boolean }>>();
  /**
   * The matte of asset `rel`, ingested as `ready` (ADR 0032), made now when it is missing. Takes no slot of the
   * job queue, so a render job can wait for it; a matte another caller is making is waited for, not made twice.
   */
  const makeMatte = async (
    dir: string,
    rel: string,
    ready: { hash: string; proxy: string },
    deps: { signal?: AbortSignal | undefined; onProgress?: ((fraction: number) => void) | undefined; report?: (update: Progress) => void },
  ): Promise<{ key: string; info: MatteInfo; cached: boolean }> => {
    const fps = (await readEnclosingProject(dir))?.config.fps ?? 30;
    const key = matteKey(ready.hash, matteModel, fps);
    const slot = `${canonicalPathSync(dir)}\0${key}`;
    // Settled, the maker may still have failed or been canceled: then the cache decides again.
    for (let running = matting.get(slot); running; running = matting.get(slot)) await running.catch(() => {});
    const tell = deps.report ?? (() => {});
    const run = (async () => {
      const known = await readMatteInfo(dir, key, ready.hash);
      if (known) return { info: known, cached: true };
      const overrides = await projectBinaries(dir);
      const info = await computeMatte(
        dir,
        { asset: rel, hash: ready.hash, proxy: ready.proxy, fps, model: matteModel },
        {
          ffmpeg: () => binaries.ensure("ffmpeg", overrides, { onProgress: tell }),
          ffprobe: () => binaries.ensure("ffprobe", overrides, { onProgress: tell }),
          files: async () =>
            options.matteStandIn === true
              ? { runtime: null, model: null }
              : {
                  runtime: await binaries.ensure(ONNX_RUNTIME_WEB, overrides, { onProgress: tell }),
                  model: await binaries.ensureModel(VIDEO_MATTE_MODEL, { onProgress: tell }),
                },
          onProgress: deps.onProgress ?? (() => {}),
          report: tell,
          signal: deps.signal ?? new AbortController().signal,
        },
      );
      return { info, cached: false };
    })();
    matting.set(slot, run);
    try {
      return { key, ...(await run) };
    } finally {
      matting.delete(slot);
    }
  };
  /**
   * Queue the `matte` job of asset `rel` (or join the one queued or running) and wait for it: `matte.prepare` and the
   * preview's `matte.status` share it, so a matte is never made twice.
   */
  const matteInJob = (dir: string, rel: string, ready: { hash: string; proxy: string }, report?: (update: Progress) => void) =>
    inJob({ kind: "matte", project: dir, asset: rel }, async (ctx) => {
      ctx.update({ step: "matte", progress: 0, cached: false });
      // Made already when a job or an export of the same content finished while this one waited.
      const made = await makeMatte(dir, rel, ready, { signal: ctx.signal, onProgress: (progress) => ctx.update({ progress }), ...(report ? { report } : {}) });
      if (made.cached) ctx.update({ cached: true, progress: 1 });
      return made;
    });
  /** Why the matte of a canonical root and cache key could not be made, for `matte.status`: a changed asset has another key. */
  const matteFailures = new Map<string, string>();
  /** Media facts `multicam.turns` and `multicam.direct` measure turns from. */
  const turnsSource: TurnsSource = {
    probe: (d, a) => media.probe(d, a),
    profile: (d, a) => energy.profile(d, a),
    async transcript(d, a) {
      let found: Awaited<ReturnType<typeof resolveTranscript>>;
      try {
        found = await resolveTranscript(d, a);
      } catch (error) {
        // Both names belong to other assets: this one has no transcript.
        if (error instanceof RpcError && error.code === ErrorCode.TranscriptNameTaken) return null;
        throw error;
      }
      if (!found.previous) return null;
      const { hash } = await media.derivedAudio(d, a);
      return { path: found.rel, transcript: found.previous, stale: hash !== found.previous.assetHash };
    },
  };
  /** Revert `target` on one timeline for `caller`; its own transaction unless an explicit one is open. */
  const revert = async (dir: string, cwd: string, timeline: string, target: string, caller: Caller) => {
    const key = authorOf(caller);
    const tx = transactions.next(key, { standalone: true });
    await transactions.touching(key, tx, { root: dir, timeline });
    const result = await timelines.revert({ root: dir, cwd, timeline, author: journalAuthorOf(caller), tx, target });
    await transactions.applied(key, tx);
    await settle(key, tx);
    return result;
  };
  /** Agent tags the app set per terminal session (`session.tag`), each with the connection that set it. */
  const sessionTags = new Map<string, { agent: string; owner: Caller }>();
  /** Agent `caller`'s operations run under now: the one it named itself, else the app's tag of its session. */
  const agentOf = (caller: Caller): string | null => {
    if (caller.agent !== undefined) return caller.agent;
    return caller.session ? (sessionTags.get(caller.session)?.agent ?? null) : null;
  };
  /** Journal author of `caller`'s operations: {@link authorOf}, or `agent:<label>:<session>` while an agent runs them. */
  const journalAuthorOf = (caller: Caller): string => {
    const key = authorOf(caller);
    const agent = key === "ui" ? null : agentOf(caller);
    return agent ? agentAuthor(agent, caller.session) : key;
  };
  const root = async (cwd: string) => (await projects.requireEnclosing(cwd)).dir;
  /** Which timeline a read by `caller` shows (ADR 0019 §5): as asked, else the proposal's for its author's terminal, else the file. */
  const viewOf = async (dir: string, caller: Caller, view: TimelineViewName | undefined): Promise<TimelineViewName> => {
    if (view) return view;
    const open = await timelines.proposal(dir);
    return open && transactionKey(open.author) === authorOf(caller) ? "proposal" : "current";
  };
  /** Timeline `id` as `caller` sees it by default: its own proposal's version while it builds one. */
  const loadFor = async (dir: string, id: string, caller: Caller) => timelines.viewTimeline(dir, id, await viewOf(dir, caller, undefined));
  /** ProposalState `forbidden` unless `caller` is the app (ADR 0019 §2, §8). */
  const onlyUi = (caller: Caller, what: string, tx: string | null = null) => {
    if (authorOf(caller) === "ui") return;
    throw new RpcError(ErrorCode.ProposalState, `Only the person, in the Frameshell app, can ${what}.`, {
      tx,
      reason: "forbidden",
      conflicts: [],
      hint: "Only the person decides, in the Frameshell app.",
    });
  };
  /**
   * Config changes are not proposals yet (ADR 0027 decision 11, ADR 0036 slice 2): while review mode is on, only
   * the person, in the app, makes them or reverts them, so nothing reaches `frameshell.json` unseen.
   */
  const formatsOutsideReview = async (dir: string, caller: Caller) => {
    if (authorOf(caller) === "ui" || !(await review.enabled(await canonicalPath(dir)))) return;
    throw new RpcError(ErrorCode.ProposalState, "Review mode is on: format changes cannot wait as proposals yet, so only the person, in the Frameshell app, can make or revert them.", {
      tx: null,
      reason: "forbidden",
      conflicts: [],
      hint: "Ask the person to change the formats, or to turn review mode off (History view).",
    });
  };
  /** Run a project-config change of `caller` in its transaction (ADR 0036). */
  const changeConfig = async <T>(dir: string, caller: Caller, work: (author: string, tx: TxRef) => Promise<T>): Promise<T> => {
    await formatsOutsideReview(dir, caller);
    const key = authorOf(caller);
    const tx = transactions.next(key);
    await transactions.touching(key, tx, { root: dir, doc: "project" });
    const result = await work(journalAuthorOf(caller), tx);
    await transactions.applied(key, tx);
    await settle(key, tx);
    return result;
  };
  /** Run `work` holding the config journal of every root in `roots`, in a fixed order so two callers never deadlock. */
  const holdingConfig = <T>(roots: string[], work: () => Promise<T>): Promise<T> => {
    const [first, ...rest] = [...new Set(roots)].sort();
    return first === undefined ? work() : configJournal.serial(first, () => holdingConfig(rest, work));
  };
  /**
   * `revert` of a target the config journal holds (ADR 0036): its config operations, and its operations on
   * `timeline` when that journal holds some too, in one standalone transaction. Config is planned first and
   * written last, so a timeline conflict leaves both untouched; a config write that still throws (invalid file)
   * leaves the timeline reverted. A target that changed other timelines is reverted one timeline at a time: its
   * config goes with the first, later ones skip it, and naming a timeline it never changed is HistoryNotFound.
   */
  const revertConfig = async (dir: string, cwd: string, timeline: string, target: string, caller: Caller): Promise<MethodResult<"revert">> => {
    const inTimeline = (await readJournal(dir, timeline)).some((entry) => entry.id === target || entry.tx === target);
    if (!inTimeline) {
      const holding = await timelinesHolding(dir, target);
      if (holding.length > 0) throw historyElsewhere(target, timeline, holding);
    } else if (configReverted(await readConfigJournal(dir), target)) {
      return { ...(await revert(dir, cwd, timeline, target, caller)), config: [] };
    }
    await formatsOutsideReview(dir, caller);
    const key = authorOf(caller);
    const author = journalAuthorOf(caller);
    const tx = transactions.next(key, { standalone: true });
    await transactions.touching(key, tx, { root: dir, doc: "project" });
    if (inTimeline) await transactions.touching(key, tx, { root: dir, timeline });
    const result = await configJournal.serial(dir, async (): Promise<MethodResult<"revert">> => {
      const plans = await configJournal.planRevert(dir, target);
      const reverted = inTimeline ? await timelines.revert({ root: dir, cwd, timeline, author, tx, target }) : null;
      const revision = reverted ? null : (await timelines.load(dir, timeline)).timeline.revision;
      const config = (await configJournal.commitRevert(dir, plans, { author, tx, target })).map(configOperation);
      if (reverted) return { ...reverted, config };
      // Only config changed: the timeline stays at its revision, and `operation` is the config revert with no timeline inverse.
      const { id, op, args } = config[0]!;
      return {
        timeline,
        revision: revision!,
        operation: { id, op, args, inverse: { op: "timeline.patch", args: {} }, author, tx: tx.id, revisionBefore: revision! },
        changes: { added: [], updated: [], removed: [], range: null },
        snaps: [],
        warnings: [],
        config,
      };
    });
    await transactions.applied(key, tx);
    await settle(key, tx);
    return result;
  };
  /** Open explicit transactions that changed project `dir` (however its root was spelled) or nothing yet. */
  const openTransactions = async (dir: string): Promise<OpenTransaction[]> => {
    const real = await canonicalPath(dir);
    const listed: OpenTransaction[] = [];
    for (const { author, tx, operations, touched, openedAt } of transactions.list()) {
      const here = [];
      for (const where of touched) if ((await canonicalPath(where.root)) === real) here.push(where);
      if (touched.length > 0 && here.length === 0) continue;
      listed.push({
        tx: tx.id,
        label: tx.label,
        author,
        session: author.startsWith("cli:") ? author.slice("cli:".length) : null,
        operations,
        timelines: here.filter(isTouchedTimeline).map((where) => where.timeline),
        openedAt,
        ageMs: openedAt === null ? null : Math.max(0, Date.now() - Date.parse(openedAt)),
      });
    }
    return listed;
  };
  const ui = new UiBroker();
  // ADR 0025: agents outside the app's terminals, and the references the app sends them. Owners are connections' callers.
  const targets = new AgentTargets({
    onChanged: (key, list, read) => events.publish("target.changed", key, { project: key, targets: list, read }),
  });
  /**
   * Target `caller` reads on project `key`: the one it names, else the one it registered as, else the one named
   * after its agent label (a CLI run by an agent whose MCP server registered). Null when none applies.
   */
  const inboxOf = (caller: Caller, key: string, named: string | undefined): string | null => {
    if (named !== undefined) return named;
    const own = targets.targetOf(caller, key);
    if (own !== null) return own;
    const agent = agentOf(caller);
    return agent !== null && targets.has(key, agent) ? agent : null;
  };
  /** Hub key of the project enclosing `cwd`, as `ui.publish` registers windows under. */
  const projectKey = async (cwd: string) => canonicalPath(await root(cwd));
  const identity: HandshakeResult = { protocolVersion: PROTOCOL_VERSION, daemonVersion: DAEMON_VERSION, pid: process.pid };

  let idleTimer: NodeJS.Timeout | undefined;
  let closing: Promise<void> | undefined;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => (resolveClosed = resolve));

  const handlers: Handlers = {
    handshake: async ({ client, session, agent }, caller) => {
      caller.client = client;
      caller.session = session ?? null;
      caller.agent = agent;
      return identity;
    },
    "session.tag": async ({ session, agent }, caller) => {
      if (agent === null) sessionTags.delete(session);
      else sessionTags.set(session, { agent, owner: caller });
      return {};
    },
    status: async ({ cwd }, caller) => {
      const project = await projects.openEnclosing(cwd);
      let trust = null;
      let skill = null;
      if (project) {
        const pins = await projects.readPins(project.dir);
        trust = { state: await plugins.trustState(project.dir, pins), plugins: pins };
        const key = canonicalPathSync(project.dir);
        skill = { ...(await coreSkillState(project.dir)), updated: skillUpdates.get(key) ?? [] };
        skillUpdates.delete(key);
      }
      return {
        daemon: { ...identity, uptimeMs: Date.now() - startedAt, clients: clients.size, socketPath },
        project,
        trust,
        skill,
        synced: project ? syncedFolder(project.dir) : null,
        openProjects: projects.list(),
        rejections: project ? await timelines.rejections(project.dir) : [],
        jobs: project ? listJobs({ project: project.dir }) : [],
        transactions: project ? await openTransactions(project.dir) : [],
        review: project ? await timelines.review(project.dir) : null,
        caller: { client: caller.client, session: caller.session, agent: agentOf(caller) },
      };
    },
    "project.init": async (params) => {
      let format: ProjectFormat = {};
      if (params.like) {
        const probe = await probeMedia(await binaries.ensure("ffprobe"), params.like).catch((error: unknown) => {
          throw new RpcError(ErrorCode.AssetNotFound, `${params.like} is not a media file ffprobe can read: ${(error as Error).message}`, {
            path: params.like,
          });
        });
        format = projectFormat(probe);
        // A picture keeps its exact size: no codec of an image export needs it even (ADR 0017).
        if (params.kind === "image" && probe.video?.still) format = { ...format, resolution: { width: probe.video.width, height: probe.video.height } };
      }
      if (params.resolution) format = { ...format, resolution: params.resolution };
      return projects.init(params.dir, params.name, params.agentSkill, format, params.kind);
    },
    doctor: async ({ cwd, install, reprobe }) => {
      const found = await readEnclosingProject(cwd);
      const project = found ? { dir: found.dir, binaries: found.config.binaries } : undefined;
      const format = found ? { resolution: found.config.resolution, fps: found.config.fps } : undefined;
      return { ...(await runDoctor(binaries, { project, install, reprobe, encoders: encoderCache, ...(format ? { format } : {}) })), skill: found ? await coreSkillState(found.dir) : null };
    },
    "skill.update": async ({ cwd, force }) => {
      const dir = await root(cwd);
      if ((await coreSkillState(dir)).state === "absent") {
        const written = (await installCoreSkill(dir)).map((path) => path.slice(`${AGENT_SKILLS_DIR}/${CORE_SKILL_NAME}/`.length));
        return { ...(await coreSkillState(dir)), written, removed: [] };
      }
      return refreshCoreSkill(dir, { force });
    },
    "project.trust": async ({ cwd, decision }) => plugins.setTrust(await root(cwd), decision),
    "plugin.list": async ({ cwd }) => plugins.list(await root(cwd)),
    "plugin.install": async ({ cwd, spec }) => {
      const dir = await root(cwd);
      const installed = await plugins.install(dir, spec, cwd);
      // Takes cut while the project had no provider (#411) get their words now.
      for (const failed of [...takeFailures.values()]) if (failed.dir === dir) queueTake(dir, failed.script, failed.take);
      return installed;
    },
    "plugin.remove": async ({ cwd, name }) => plugins.remove(await root(cwd), name),
    "plugin.run": async ({ cwd, plugin, command, args }) => plugins.run(await root(cwd), cwd, plugin, command, args),
    "export.presets": async ({ cwd }) => ({ presets: await exports.presets(await root(cwd)) }),
    "format.list": async ({ cwd }) => {
      const dir = await root(cwd);
      const { config } = (await readEnclosingProject(dir))!;
      return { dir, formats: formatInfos(config), builtins: builtinFormatInfos() };
    },
    "format.add": async ({ cwd, id, width, height, index }, caller) => {
      const dir = await root(cwd);
      return changeConfig(dir, caller, (author, tx) => formats.add(dir, { id, width, height, index }, author, tx));
    },
    "format.remove": async ({ cwd, id }, caller) => {
      const dir = await root(cwd);
      return changeConfig(dir, caller, (author, tx) => formats.remove(dir, id, author, tx));
    },
    render: async ({ cwd, timeline, preset, quality, out, cover, formats: ids }) =>
      exports.render(await root(cwd), { timeline, preset, quality, out, cover, formats: ids }),
    frame: async ({ cwd, timeline, at, out, preset, projectFormat, format, quality, view }, caller) => {
      const dir = await root(cwd);
      const { view: shown, proposal, ...loaded } = await timelines.viewTimeline(dir, timeline, await viewOf(dir, caller, view));
      return { view: shown, proposal, ...(await exports.frame(dir, { timeline, at, out, preset, projectFormat, format, quality }, loaded)) };
    },
    review: async ({ cwd, timeline, file, from, to, sheets, every, projectFormat, view }, caller) => {
      const dir = await root(cwd);
      return reviews.run(dir, {
        timeline,
        ...(file ? { file: resolve(cwd, file) } : {}),
        from,
        to,
        sheets,
        every,
        projectFormat,
        view: await viewOf(dir, caller, view),
      });
    },
    cover: async ({ cwd, timeline, view, ...choice }, caller) => {
      const dir = await root(cwd);
      const { view: shown, proposal, ...loaded } = await timelines.viewTimeline(dir, timeline, await viewOf(dir, caller, view));
      return { view: shown, proposal, ...(await exports.cover(dir, { timeline, ...choice }, loaded)) };
    },
    transcribe: async ({ cwd, asset, provider, model, language }, _caller, request) => {
      await projects.requireEnclosing(cwd); // Throws ProjectNotFound.
      const { dir, config } = (await readEnclosingProject(cwd))!;
      const providerId = provider ?? config.transcription?.provider ?? "whisper-cpp";
      const overrides = { dir, binaries: config.binaries };
      const chosenModel = model ?? (await configuredModel(config, providerId));
      return transcribing(dir, () => transcribeAsset({
        projectDir: dir,
        asset: resolve(cwd, asset),
        providerId,
        provider: () => plugins.transcriptionProvider(dir, providerId),
        model: chosenModel,
        language: language ?? config.transcription?.language,
        tools: transcriberTools(overrides),
        media: { derivedAudio: (rel, onProgress) => media.derivedAudio(dir, rel, onProgress) },
        extractAudio: options.extractAudio,
        progress: request.progress,
      }));
    },
    "transcribe.speakers": async ({ cwd, asset, speakers }, _caller, request) => {
      await projects.requireEnclosing(cwd); // Throws ProjectNotFound.
      const { dir, config } = (await readEnclosingProject(cwd))!;
      const overrides = { dir, binaries: config.binaries };
      return transcribing(dir, () => diarizeAsset({
        projectDir: dir,
        asset: resolve(cwd, asset),
        speakers,
        tools: transcriberTools(overrides),
        media: { derivedAudio: (rel, onProgress) => media.derivedAudio(dir, rel, onProgress) },
        extractAudio: options.extractAudio,
        diarize: options.diarize,
        progress: request.progress,
      }));
    },
    "transcribe.verify": async ({ cwd, export: file, timeline, provider, model, language }, _caller, request) => {
      await projects.requireEnclosing(cwd); // Throws ProjectNotFound.
      const { dir, config } = (await readEnclosingProject(cwd))!;
      const providerId = provider ?? config.transcription?.provider ?? "whisper-cpp";
      const overrides = { dir, binaries: config.binaries };
      return transcribing(dir, async () => verifyExport({
        projectDir: dir,
        exportFile: resolve(cwd, file),
        timelineId: timeline,
        timeline: (await timelines.load(dir, timeline)).timeline,
        providerId,
        provider: () => plugins.transcriptionProvider(dir, providerId),
        model: model ?? config.transcription?.model,
        defaultModel: await models.defaultFor(providerId),
        language: language ?? config.transcription?.language,
        tools: transcriberTools(overrides),
        assetHash: async (rel) => (await media.derivedAudio(dir, rel)).hash,
        extractAudio: options.extractAudio,
        progress: request.progress,
      }));
    },
    "model.list": async ({ cwd }) => {
      const listed = await models.list();
      if (!cwd) return { ...listed, providers: [], providersError: null, project: null };
      const found = await readEnclosingProject(cwd);
      if (!found) return { ...listed, providers: [], providersError: `No Frameshell project in ${cwd} or its parents.`, project: null };
      const { dir, config } = found;
      let providers: MethodResult<"model.list">["providers"] = [];
      let providersError: string | null = null;
      try {
        providers = await Promise.all(
          (await plugins.transcriptionProviders(dir)).map(async (provider) => ({
            id: provider.id,
            defaultModel: provider.defaultModel ?? null,
            userModels: provider.userModels
              ? { formats: [...provider.userModels.formats], options: (provider.userModels.options ?? []).map(({ key, values }) => ({ key, values: [...values] })) }
              : null,
            models: await Promise.all(
              (provider.models ?? []).map(async ({ id, managedModel }) => {
                const location = managedModel ? await binaries.locateModel(managedModel).catch(() => null) : null;
                return { id, size: location?.pinned.size ?? null, downloaded: location?.installed ?? false };
              }),
            ),
          })),
        );
      } catch (error) {
        providersError = (error as Error).message;
      }
      const providerId = config.transcription?.provider ?? "whisper-cpp";
      const own = providers.find((provider) => provider.id === providerId)?.defaultModel ?? null;
      const effective = config.transcription?.model ?? listed.defaults[providerId] ?? own;
      return { ...listed, providers, providersError, project: { dir, provider: providerId, model: config.transcription?.model ?? null, effective } };
    },
    "model.add": async ({ id, file, options: settings }, _caller, request) => models.add(id, file, settings, request.progress),
    "model.remove": async ({ id }) => models.remove(id),
    "model.default": async ({ provider, model, cwd }) => {
      const dir = cwd ? ((await readEnclosingProject(cwd))?.dir ?? null) : null;
      if (model !== null) await checkModelId(model, provider, dir);
      return { provider, model, previous: await models.setDefault(provider, model) };
    },
    "transcription.set": async ({ cwd, provider, model }) => {
      await projects.requireEnclosing(cwd); // Throws ProjectNotFound.
      const { dir, config } = (await readEnclosingProject(cwd))!;
      const providerId = provider ?? config.transcription?.provider ?? "whisper-cpp";
      if (model !== null) await checkModelId(model, providerId, dir);
      const { model: _previous, ...kept } = config.transcription ?? {};
      const previous = await projects.writeTranscription(dir, { ...kept, provider: providerId, ...(model !== null ? { model } : {}) });
      return { provider: providerId, model, previous: previous?.model ?? null };
    },
    "file.write": ({ path, content }, caller) => projects.writeFile(path, content, journalAuthorOf(caller)),
    "file.uses": ({ path }) => fileUses(path),
    "asset.import": async ({ cwd, files, mode, ...provenance }) => {
      const dir = await root(cwd);
      const result = await media.import(dir, files, mode);
      const recorded = Object.values(provenance).some((value) => value !== undefined);
      if (recorded) await credits.record(dir, [...new Set(result.imported.map((entry) => entry.asset))], provenance);
      return { ...result, imported: result.imported.map((entry) => ({ ...entry, provenance: recorded })) };
    },
    "credits.set": async ({ cwd, asset, ...provenance }) => {
      const dir = await root(cwd);
      const [entry] = await credits.record(dir, [projectPath(dir, cwd, asset, "asset", "credits.set")], provenance);
      return { dir, entry: entry! };
    },
    "credits.check": async ({ cwd }) => credits.check(await root(cwd)),
    "asset.list": async ({ cwd }) => {
      const dir = await root(cwd);
      return { dir, assets: await media.list(dir) };
    },
    gc: async ({ cwd, dryRun }) => {
      const dir = await root(cwd);
      const clipDir = clipRoot(dir);
      const active = [...jobs.list({ project: dir, active: true }), ...clipJobs.list({ project: clipDir, active: true })];
      const temps = active.length === 0;
      const busy = active.some((job) => job.kind === "clip" || job.kind === "render");
      const derived = await media.gc(dir, { dryRun, temps, hashUnknown: true, transcribing: transcriptions.has(canonicalPathSync(dir)) });
      const cache = await clips.gc(clipDir, { dryRun, temps, busy });
      const proposals = await timelines.gcProposals(dir, dryRun);
      const shootCache = await shoots.gc(dir, { dryRun, temps });
      const baked = await audioFx.gc(dir, { dryRun, temps, busy: active.some((job) => job.kind === "render") });
      const removed = [...derived.removed, ...cache.removed, ...proposals, ...shootCache, ...baked.removed].sort((a, b) =>
        a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
      );
      const skipped = [...derived.skipped, ...cache.skipped, ...baked.skipped];
      if (!temps) skipped.push({ area: "temp", reason: "jobs of this project are running; temp files may be theirs." });
      const bytes = removed.reduce((sum, entry) => sum + entry.bytes, 0);
      return { dir, dryRun, removed, bytes, forgotten: derived.forgotten, skipped };
    },
    "clip.renders": async ({ cwd, timeline }) => clips.status(clipRoot(await root(cwd)), timeline),
    "clip.live": async ({ cwd, timeline, clip }) => clips.live(clipRoot(await root(cwd)), timeline, clip),
    "audio.bakes": async ({ cwd, timeline, view }, caller) => {
      const dir = await root(cwd);
      const shown = await timelines.viewTimeline(dir, timeline, await viewOf(dir, caller, view));
      const flat = await resolveNested(dir, shown.timeline, undefined, shown.fps);
      return { timeline, revision: shown.timeline.revision, bakes: await audioFx.status(dir, flat, true) };
    },
    "context.write": async ({ cwd, name, content }) => writeContext(await root(cwd), name, content),
    "inspect.point": async ({ cwd, timeline, at, x, y, unit, segment, view }, caller, request) => {
      const dir = await root(cwd);
      const shown = await timelines.viewTimeline(dir, timeline, await viewOf(dir, caller, view));
      const loaded = { timeline: await resolveNested(dir, shown.timeline, undefined, shown.fps), fps: shown.fps };
      const onProgress = (update: Progress) => {
        try {
          request.progress(update);
        } catch {
          // Connection closed.
        }
      };
      return { view: shown.view, proposal: shown.proposal, ...(await inspector.point(dir, { timeline, at, x, y, unit, segment }, loaded, onProgress)) };
    },
    "job.list": async ({ cwd, active }) => {
      const dir = await root(cwd);
      return { dir, jobs: listJobs({ project: dir, active }) };
    },
    "events.subscribe": async ({ cwd, events: names }, _caller, request) => {
      const dir = await root(cwd);
      return { dir, events: events.subscribe(request.sink, await canonicalPath(dir), dir, names) };
    },
    "events.unsubscribe": async ({ cwd, events: names }, _caller, request) => {
      const dir = await root(cwd);
      return { dir, events: events.unsubscribe(request.sink, await canonicalPath(dir), names) };
    },
    "script.outline": async ({ cwd, file }) => outlineScript(await root(cwd), cwd, file),
    "shoot.status": async ({ cwd, script }) => shoots.status(await root(cwd), cwd, script),
    "shoot.add": async ({ cwd, script, asset, scene, recordedAt }, caller) => shoots.add(await root(cwd), cwd, { script, asset, scene, recordedAt, by: journalAuthorOf(caller) }),
    "shoot.assemble": (params, caller) => assemble(params, caller),
    "shoot.session.cut": async ({ cwd, script, scene, session, start, end, sounds, recordedAt }, caller) => {
      const dir = await root(cwd);
      const cut = await shoots.cut(dir, cwd, { script, scene, session: { id: session, start, end, sounds }, recordedAt, by: journalAuthorOf(caller) });
      const job = queueTake(dir, cut.script, cut.take);
      const status = await shoots.status(dir, cwd, cut.script);
      return { file: cut.file, take: status.takes.find((take) => take.id === cut.take.id)!, job };
    },
    "shoot.session.end": async ({ cwd, script, session, assets, names, mics, micNames, soundOf, offsets, screens, name }, caller) => {
      const dir = await root(cwd);
      const { script: scriptPath, takes } = await shoots.sessionTakes(dir, cwd, script, session);
      const runs = () => Promise.all(takes.map((take) => takeRuns.get(`${dir}\0${take.id}`)));
      await runs();
      // A take whose run failed or was lost (cut as the session ended, a daemon restart) is transcribed again now
      // that its files are finished, so its words reach the transcripts.
      for (const take of takes) if (!takeRuns.has(`${dir}\0${take.id}`) && !(await readTakeWords(dir, take.id))) queueTake(dir, scriptPath, take);
      await runs();
      const transcripts = await writeSessionTranscripts(dir, takes, { hash: (rel) => media.hash(dir, rel) });
      const { timeline } = await shoots.status(dir, cwd, script);
      if (!(await exists(timelinePath(dir, timeline)))) await timelines.writeFile(dir, timeline, `${JSON.stringify(createTimeline(timeline), null, 2)}\n`);
      const warnings: string[] = [];
      let group: string | null = null;
      if (assets.length > 0) {
        const created = await createGroup({ cwd, timeline, assets, names, mics, micNames, soundOf, name, offsets, screens }, caller);
        group = created.group;
        warnings.push(...created.warnings);
        // The session's chosen takes become its shots: the shot over the whole recording would only be cut away.
        await operate("clip.remove", { cwd, timeline, clip: created.clip }, caller);
      }
      await shoots.endSession(dir, cwd, { script, session, group });
      const assembled = await assemble({ cwd, script, snap: true }, caller);
      return { timeline, group, transcripts, tx: assembled.tx, warnings: [...warnings, ...assembled.warnings] };
    },
    "shoot.discard": async ({ cwd, script, take, restore }) => shoots.discard(await root(cwd), cwd, { script, take, restore }),
    "shoot.accept": async ({ cwd, script, take, deviations, undo }, caller) =>
      shoots.accept(await root(cwd), cwd, { script, take, deviations, undo, by: journalAuthorOf(caller) }),
    "shoot.choose": async ({ cwd, script, scene, take }) => shoots.choose(await root(cwd), cwd, { script, scene, take }),
    "script.check": async ({ cwd, file }) => {
      const dir = await root(cwd);
      const names = await people.names(dir).then(
        (found) => ({ people: found }),
        (error: unknown) => ({ people: [], warning: `people.json could not be read, speakers not matched: ${(error as Error).message.split("\n")[0]}` }),
      );
      return checkScript(dir, cwd, file, names);
    },
    "voiceover.generate": async ({ cwd, script, lines, provider, voice, yes }, _caller, request) => {
      const dir = await root(cwd);
      // Built in: the daemon's own list, then this machine's `command` provider (global config only, ADR 0034).
      const command = await readCommandSpeechProvider(dirs.configDir);
      const builtIn = new Map([...(options.speechProviders ?? []), ...(command ? [command] : [])].map((speech) => [speech.id, speech] as const));
      const speechProvider = async (id: string): Promise<SpeechProvider> => {
        const own = builtIn.get(id);
        if (own) return own;
        try {
          return await plugins.speechProvider(dir, id);
        } catch (error) {
          if (!(error instanceof RpcError) || error.code !== ErrorCode.SpeechProviderNotFound) throw error;
          const available = [...builtIn.keys(), ...((error.data as { available?: string[] } | undefined)?.available ?? [])];
          if (id === COMMAND_SPEECH_PROVIDER) throw commandNotConfigured(dirs.configDir, available);
          if (builtIn.size === 0) throw error;
          throw new RpcError(ErrorCode.SpeechProviderNotFound, `${error.message} Built in: ${[...builtIn.keys()].join(", ")}.`, { provider: id, available });
        }
      };
      const work = () =>
        generateVoiceover({
          root: dir,
          cwd,
          script,
          ...(lines ? { lines } : {}),
          ...(provider ? { provider } : {}),
          ...(voice ? { voice } : {}),
          yes,
          speechProvider,
          speechProviders: async () => [
            ...builtIn.keys(),
            ...(await plugins.speechProviders(dir).then((found) => found.map((speech) => speech.id), () => [])),
          ],
          ensureBinary: async (name) => binaries.ensure(name, await projectBinaries(dir)),
          importAssets: (files) => media.import(dir, files, "copy"),
          progress: (update) => {
            try {
              request.progress(update);
            } catch {
              // Connection closed.
            }
          },
          signal: voiceoverAbort.signal,
        });
      // One run per project at a time: two runs over one script would write the same takes.
      const key = canonicalPathSync(dir);
      const run = (voiceoverRuns.get(key) ?? Promise.resolve()).then(work);
      const settled = run.then(
        () => undefined,
        () => undefined,
      );
      voiceoverRuns.set(key, settled);
      void settled.then(() => {
        if (voiceoverRuns.get(key) === settled) voiceoverRuns.delete(key);
      });
      return run;
    },
    "timeline.show": async ({ cwd, timeline, view }, caller) => {
      const dir = await root(cwd);
      return timelines.show(dir, timeline, await viewOf(dir, caller, view));
    },
    "track.list": async ({ cwd, timeline, view }, caller) => {
      const dir = await root(cwd);
      return timelines.tracks(dir, timeline, await viewOf(dir, caller, view));
    },
    "marker.list": async ({ cwd, timeline, view }, caller) => {
      const dir = await root(cwd);
      return timelines.markers(dir, timeline, await viewOf(dir, caller, view));
    },
    "marker.add": (params, caller) => operate("marker.add", params, caller),
    "marker.set": (params, caller) => operate("marker.set", params, caller),
    "marker.remove": (params, caller) => operate("marker.remove", params, caller),
    "track.add": (params, caller) => operate("track.add", params, caller),
    "track.remove": (params, caller) => operate("track.remove", params, caller),
    "track.set": async (params, caller) => {
      // ADR 0032 decision 6: image projects have no plates.
      if (typeof params.behind === "string" && (await readEnclosingProject(await root(params.cwd)))?.config.kind === "image") {
        throw new RpcError(ErrorCode.InvalidOperation, "track.set: image projects have no video to put a track behind (`behind`).", {
          op: "track.set",
          reason: "image project",
          field: "behind",
        });
      }
      return operate("track.set", params, caller);
    },
    "clip.add": (params, caller) => operate("clip.add", params, caller),
    "clip.move": (params, caller) => operate("clip.move", params, caller),
    "clip.trim": (params, caller) => operate("clip.trim", params, caller),
    "clip.split": (params, caller) => operate("clip.split", params, caller),
    "clip.remove": (params, caller) => operate("clip.remove", params, caller),
    "clip.set": (params, caller) => operate("clip.set", params, caller),
    "transition.set": (params, caller) => operate("transition.set", params, caller),
    "transition.remove": (params, caller) => operate("transition.remove", params, caller),
    "clip.key": (params, caller) => operate("clip.key", params, caller),
    "track.duck": async ({ cwd, timeline, track, under, depth, attackMs, releaseMs, threshold, gap }, caller) => {
      const dir = await root(cwd);
      const { timeline: loaded } = await loadFor(dir, timeline, caller);
      const invalid = (reason: string, field: string) => new RpcError(ErrorCode.InvalidOperation, `track.duck: ${reason}`, { op: "track.duck", reason, field });
      const known = (id: string) => {
        const found = loaded.tracks.find((candidate) => candidate.id === id);
        if (!found) throw new RpcError(ErrorCode.TrackNotFound, `track.duck: no track "${id}" in timeline ${timeline}.`, { track: id, available: loaded.tracks.map((t) => t.id) });
        return found;
      };
      const music = known(track);
      if (music.kind !== "audio") throw invalid(`${track} is a ${music.kind} track; ducking writes gain keys on the clips of an audio track.`, "track");
      for (const id of under) {
        const voice = known(id);
        if (id === track) throw invalid(`${id} is the track being ducked; name the tracks with the voice in \`under\`.`, "under");
        if (voice.kind !== "video" && voice.kind !== "audio") {
          throw invalid(`${id} is a ${voice.kind} track; \`under\` takes video and audio tracks (a multicam program track has no sound of its own).`, "under");
        }
      }
      const attack = attackMs / 1000;
      const release = releaseMs / 1000;
      let stretches: Span[] = [];
      let heardWarnings: string[] = [];
      // Measured against the timeline the operation applies to: a voice edited or a proposal rebased meanwhile is heard as it is then.
      const prepare = async (current: Timeline, request: OperationRequest): Promise<OperationRequest> => {
        const heard = await voiceRuns(current, under, { threshold, profile: (asset) => energy.profile(dir, asset) });
        stretches = speechStretches(heard.runs, { gap, attack, release });
        heardWarnings = heard.warnings;
        const curve = dipCurve(stretches, { depth, attack, release });
        return { ...request, args: { ...request.args, curve: curve.length > 0 ? curve : [{ time: 0, dip: 0 }] } } as OperationRequest;
      };
      const result = await operate("track.duck", { cwd, timeline, track, curve: [{ time: 0, dip: 0 }] }, caller, undefined, prepare);
      return {
        ...result,
        track,
        under,
        stretches: stretches.length,
        speechSeconds: Math.round(stretches.reduce((sum, span) => sum + (span.end - span.start), 0) * 1000) / 1000,
        warnings: [...result.warnings, ...heardWarnings],
      };
    },
    cut: (params, caller) => operate("cut", params, caller),
    cleanup: async ({ cwd, timeline, pauses, breath, retakes, minConfidence, dryRun, skip }, caller) => {
      const dir = await root(cwd);
      const { timeline: loaded, fps } = await loadFor(dir, timeline, caller);
      const plan = await planTimelineCleanup(
        dir,
        loaded,
        fps,
        { pauses, breath, retakes, minConfidence, skip },
        {
          assetHash: async (rel) => (await media.derivedAudio(dir, rel)).hash,
          profile: (asset) => energy.profile(dir, asset),
          hasAudio: async (asset) => (await media.probe(dir, asset)).audio !== null,
        },
      );
      if (dryRun || plan.candidates.length === 0) return { timeline, revision: loaded.revision, dryRun, applied: false, tx: null, ...plan };
      // The plan can take seconds (first energy profile): cuts at the times of an older timeline would cut the wrong audio.
      const fresh = (await loadFor(dir, timeline, caller)).timeline.revision;
      if (fresh !== loaded.revision) {
        throw new RpcError(ErrorCode.StaleRevision, `cleanup: timeline ${timeline} changed from revision ${loaded.revision} to ${fresh} while the cuts were planned. Nothing was cut; run it again.`, {
          op: "cleanup",
          timeline,
          revision: loaded.revision,
          current: fresh,
        });
      }
      const key = authorOf(caller);
      const next = transactions.next(key, { standalone: true });
      const tx = transactions.isOpen(key, next) ? next : { id: next.id, label: cleanupLabel(plan.candidates) };
      await transactions.touching(key, tx, { root: dir, timeline });
      const warnings = new Set(plan.warnings);
      let revision = loaded.revision;
      try {
        // Last cut first: a cut moves everything after it, so the earlier ones keep their times.
        for (const candidate of [...plan.candidates].sort((a, b) => b.start - a.start)) {
          const request = { op: "cut", args: { from: candidate.start, to: candidate.end, snap: false } } as const;
          const result = await timelines.apply({ root: dir, cwd, timeline, request, author: journalAuthorOf(caller), tx });
          await transactions.applied(key, tx);
          revision = result.revision;
          for (const warning of result.warnings) warnings.add(warning);
        }
      } finally {
        await settle(key, tx);
      }
      return { timeline, revision, dryRun, applied: true, tx: tx.id, ...plan, warnings: [...warnings] };
    },
    "multicam.create": (params, caller) => createGroup(params, caller),
    "multicam.gallery": async ({ cwd, timeline, asset, names, name, at, group: into, mic }, caller) => {
      const dir = await root(cwd);
      const plan = await planGallery(gallery, { root: dir, cwd, asset, names, at });
      let written: Timeline | undefined;
      const args = { cwd, timeline, asset: plan.asset, tiles: plan.tiles, ...(name ? { name } : {}), ...(into !== undefined ? { group: into } : {}), ...(mic !== undefined ? { mic } : {}) };
      const result = await operate("multicam.gallery", args, caller, (after) => {
        written = after;
      });
      const whole = written?.groups?.find((candidate) => (into !== undefined ? candidate.id === into : result.changes.added.includes(candidate.id)));
      const track = written?.tracks.find((candidate) => candidate.kind === "program" && candidate.group === whole?.id);
      if (!whole || (into === undefined && track?.kind !== "program")) throw new Error("multicam.gallery: the operation wrote no new group");
      // Into a group, only the tiles are new: the report and the tiles' mic are theirs.
      const tiles = into !== undefined ? whole.angles.slice(-plan.tiles.length) : whole.angles;
      const tileMic = into !== undefined ? (tiles[0]?.mic ?? null) : (whole.mics?.[0]?.id ?? null);
      const group = { ...whole, angles: tiles, mics: (whole.mics ?? []).filter((candidate) => candidate.id === tileMic) };
      const report = galleryReport(group, plan);
      return {
        ...result,
        group: group.id,
        track: track?.id ?? null,
        clip: into !== undefined || track?.kind !== "program" ? null : track.clips[0]!.id,
        mic: tileMic,
        confidence: report.confidence,
        samples: plan.analysis.samples,
        tiles: report.tiles,
        layouts: report.layouts,
        warnings: [...result.warnings, ...report.warnings],
      };
    },
    "multicam.offset": (params, caller) => operate("multicam.offset", params, caller),
    "multicam.angle": (params, caller) => operate("multicam.angle", params, caller),
    "multicam.mic": (params, caller) => operate("multicam.mic", params, caller),
    "multicam.reframe": (params, caller) => operate("multicam.reframe", params, caller),
    "multicam.paint": (params, caller) => operate("multicam.paint", params, caller),
    "shot.set": (params, caller) => operate("shot.set", params, caller),
    "segment.prepare": async ({ cwd, asset }, _caller, request) => {
      const dir = await root(cwd);
      // The model download is for image projects only (ADR 0022 §4).
      if ((await readEnclosingProject(dir))?.config.kind !== "image") {
        throw new RpcError(ErrorCode.InvalidOperation, "segment.prepare: only photos of image projects are segmented.", { op: "segment.prepare", reason: "not an image project", field: "cwd" });
      }
      const { rel } = await resolveAsset(dir, resolve(cwd, asset));
      const prepared = await segmentation.prepare(dir, rel, (update) => {
        try {
          request.progress(update);
        } catch {
          // Connection closed.
        }
      });
      return { asset: prepared.asset, size: { width: prepared.width, height: prepared.height }, hash: prepared.hash, model: segmentModel, cached: prepared.cached };
    },
    "image.cutout": async ({ cwd, timeline, clip: clipId, mask }, caller) => {
      const dir = await root(cwd);
      const project = (await readEnclosingProject(dir))?.config;
      if (project?.kind !== "image") {
        throw new RpcError(ErrorCode.InvalidOperation, "image.cutout: only image projects have photos to cut out of (File > New Image from Frame makes one from a video).", {
          op: "image.cutout",
          reason: "not an image project",
          field: "clip",
        });
      }
      const { timeline: loaded } = await loadFor(dir, timeline, caller);
      const place = loaded.tracks.flatMap((track) => (track.kind === "video" ? track.clips.map((clip) => ({ track, clip })) : [])).find(({ clip }) => clip.id === clipId);
      if (!place) {
        throw new RpcError(ErrorCode.ClipNotFound, `image.cutout: no clip "${clipId}" on a video track of timeline ${loaded.id}. List clip ids with "frameshell timeline show".`, { clip: clipId });
      }
      const { track, clip: photo } = place;
      if (!isMediaClip(photo)) {
        throw new RpcError(ErrorCode.InvalidOperation, `image.cutout: clip ${clipId} is not a still media clip.`, { op: "image.cutout", reason: "not a still image", field: "clip" });
      }
      const picture = (await media.probe(dir, photo.asset)).video;
      if (!picture?.still) {
        throw new RpcError(ErrorCode.InvalidOperation, `image.cutout: ${photo.asset} is not a still image.`, { op: "image.cutout", reason: "not a still image", field: "clip" });
      }
      const maskFile = await resolveMask(dir, mask);
      const ffmpeg = await projectFfmpeg(dir);
      const box = await checkMask(ffmpeg, maskFile, picture);
      const stem = basename(photo.asset, extname(photo.asset));
      const rendered = await renderCutout(ffmpeg, join(dir, ...photo.asset.split("/")), maskFile, box, await freeCutoutName(dir, stem));
      let asset: string;
      try {
        asset = (await media.import(dir, [rendered.file], "copy")).imported[0]!.asset;
      } finally {
        await rendered.cleanup();
      }
      // Both operations share one transaction, so one revert undoes the cut-out even from a sessionless client:
      // the caller's explicit one when open, else a labelled one of their own (never an automatic group).
      const key = authorOf(caller);
      const next = transactions.next(key, { standalone: true });
      const tx = transactions.isOpen(key, next) ? next : { id: next.id, label: `Cut out ${stem}` };
      const author = journalAuthorOf(caller);
      const apply = async (op: OperationRequest) => {
        const result = await timelines.apply({ root: dir, cwd, timeline, request: op, author, tx });
        await transactions.applied(key, tx);
        return result;
      };
      await transactions.touching(key, tx, { root: dir, timeline });
      try {
        const index = loaded.tracks.indexOf(track) + 1;
        const added = await apply({ op: "track.add", args: { kind: "video", name: basename(asset, extname(asset)), index } } as OperationRequest);
        const newTrack = added.changes.added[0]!;
        const duration = (photo.out - photo.in) / (photo.speed ?? 1);
        const transform = cutoutTransform(picture, box, project.resolution, photo.transform);
        let result: Awaited<ReturnType<typeof apply>>;
        try {
          result = await apply({ op: "clip.add", args: { track: newTrack, type: "media", asset, start: photo.start, duration, transform } } as OperationRequest);
        } catch (error) {
          // All or nothing: take the new track off again, in the same transaction.
          await timelines.revert({ root: dir, cwd, timeline, author, tx, target: added.operation.id }).catch(() => undefined);
          throw error;
        }
        const dropped = [photo.keys ? "keyframes" : null, photo.fadeIn !== undefined || photo.fadeOut !== undefined ? "fades" : null, photo.dissolve !== undefined ? "dissolve" : null].filter(
          (name) => name !== null,
        );
        const warnings =
          dropped.length > 0 ? [`image.cutout: the photo's ${dropped.join(", ")} were not copied; the cut-out lies over the photo as its static transform places it.`] : [];
        return { ...result, asset, track: newTrack, clip: result.changes.added[0]!, warnings: [...result.warnings, ...warnings] };
      } finally {
        await settle(key, tx);
      }
    },
    "multicam.faces": async ({ cwd, timeline, group, angles: named, replace }, caller, request) => {
      const dir = await root(cwd);
      const { timeline: loaded } = await loadFor(dir, timeline, caller);
      const found = groupOf(loaded, group, "multicam.faces");
      const chosen = (named ?? found.angles.filter((angle) => angle.screen !== true).map((angle) => angle.id)).map((id) => {
        const angle = found.angles.find((candidate) => candidate.id === id);
        const invalid = (reason: string) =>
          new RpcError(ErrorCode.InvalidOperation, `multicam.faces: ${reason}`, { op: "multicam.faces", reason, field: "angles" });
        if (!angle) throw invalid(`group ${group} has no angle "${id}" (angles: ${found.angles.map((candidate) => candidate.id).join(", ")}).`);
        if (angle.screen === true) throw invalid(`angle ${id} is a screen: screens are never cut, so they take no reframe keys.`);
        return angle;
      });
      const kept = replace === true ? [] : chosen.filter((angle) => angle.reframe).map((angle) => angle.id);
      const todo = chosen.filter((angle) => !kept.includes(angle.id));
      // The caller may be gone (the job outlives it): its progress is then dropped.
      const tell = (update: Progress) => {
        try {
          request.progress(update);
        } catch {
          // Connection closed.
        }
      };
      return inJob({ kind: "faces", project: dir, asset: `timelines/${timeline}.json` }, async (ctx) => {
        const warnings: string[] = [];
        const report: MethodResult<"multicam.faces">["angles"] = [];
        const proposed = new Map<string, { at: number; x: number; y: number }[]>();
        if (todo.length > 0) {
          const project = await projectBinaries(dir);
          const ffmpeg = await binaries.ensure("ffmpeg", project, { onProgress: tell });
          const scan =
            options.faceScanner ??
            yunetWorkerScanner({
              runtime: await binaries.ensure(ONNX_RUNTIME_WEB, project, { onProgress: tell }),
              model: await binaries.ensureModel(FACE_DETECTION_MODEL, { onProgress: tell }),
            });
          ctx.update({ step: "faces", progress: 0 });
          for (const [index, angle] of todo.entries()) {
            const probe = await media.probe(dir, angle.asset);
            if (!probe.video || probe.video.still) {
              warnings.push(`${angle.name} (${angle.asset}) has no moving picture: no keys.`);
              report.push({ angle: angle.id, name: angle.name, samples: 0, faces: 0, keys: 0, operation: null });
              continue;
            }
            const message = `Finding faces in ${angle.name}`;
            const detected = await scan({
              ffmpeg,
              path: join(dir, ...angle.asset.split("/")),
              width: probe.video.width,
              height: probe.video.height,
              duration: probe.duration ?? undefined,
              crop: angle.crop,
              signal: ctx.signal,
              onProgress: (fraction) => {
                ctx.update({ progress: (index + fraction) / todo.length });
                tell({ message, fraction, stage: "faces", values: { angle: angle.name } });
              },
            });
            // Keys sit on the group clock; a file that starts before the group loses what plays before group second 0.
            const keys = detected.keys
              .map((key) => ({ at: Math.round((key.time + angle.offset) * 1000) / 1000, x: key.x, y: key.y }))
              .filter((key) => key.at >= 0);
            if (keys.length > 0) proposed.set(angle.id, keys);
            if (detected.faces === 0) warnings.push(`${angle.name}: no face found in ${detected.samples} frames, so it keeps its framing.`);
            else if (detected.faces < detected.samples / 4) {
              warnings.push(`${angle.name}: a face in only ${detected.faces} of ${detected.samples} frames; check its keys.`);
            }
            report.push({ angle: angle.id, name: angle.name, samples: detected.samples, faces: detected.faces, keys: keys.length, operation: null });
          }
        }
        // Every write joins one transaction, so one revert undoes all angles.
        const author = authorOf(caller);
        const tx = transactions.next(author);
        let revision = loaded.revision;
        let wrote = false;
        for (const entry of report) {
          const keys = proposed.get(entry.angle);
          if (!keys) continue;
          await transactions.touching(author, tx, { root: dir, timeline });
          const reframe = { op: "multicam.reframe" as const, args: { group, angle: entry.angle, keys } };
          const result = await timelines
            .apply({
              root: dir,
              cwd,
              timeline,
              request: reframe,
              author: journalAuthorOf(caller),
              tx,
              // A person may have set keys while faces were being found: theirs stay unless `replace`.
              prepare: async (current) => {
                const now = current.groups?.find((candidate) => candidate.id === group)?.angles.find((angle) => angle.id === entry.angle);
                if (replace !== true && now?.reframe) throw new KeptAngle();
                return reframe;
              },
            })
            .catch((error: unknown) => {
              if (error instanceof KeptAngle) return null;
              throw error;
            });
          if (!result) {
            kept.push(entry.angle);
            entry.keys = 0;
            continue;
          }
          await transactions.applied(author, tx);
          entry.operation = result.operation.id;
          revision = result.revision;
          wrote = true;
        }
        if (wrote) await settle(author, tx);
        return { timeline, revision, group, angles: report, kept, tx: wrote ? tx.id : null, warnings };
      });
    },
    "clip.reframe": async ({ cwd, timeline, clip: clipId, format: formatText, person: personRef, anchor }, caller, request) => {
      const dir = await root(cwd);
      const invalid = (reason: string, field: string) => new RpcError(ErrorCode.InvalidOperation, `clip.reframe: ${reason}`, { op: "clip.reframe", reason, field });
      const format = parseFrameFormat(formatText ?? "9x16");
      if (!format) throw invalid(`format "${formatText}" is not <width>x<height>, e.g. 9x16.`, "format");
      if (personRef !== undefined && anchor !== undefined) throw invalid("`person` and `anchor` are two ways to place the picture: give one.", "anchor");
      const { timeline: loaded } = await loadFor(dir, timeline, caller);
      const place = loaded.tracks.flatMap((track) => (track.kind === "video" ? track.clips.map((clip) => ({ track, clip })) : [])).find(({ clip }) => clip.id === clipId);
      if (!place) {
        throw new RpcError(ErrorCode.ClipNotFound, `clip.reframe: no clip "${clipId}" on a video track of timeline ${loaded.id}. List clip ids with "frameshell timeline show".`, { clip: clipId });
      }
      const clip = place.clip;
      if (!isMediaClip(clip)) throw invalid(`clip ${clipId} is not a media clip: only footage and photos are reframed.`, "clip");
      const probe = await media.probe(dir, clip.asset);
      if (!probe.video) throw invalid(`${clip.asset} has no picture.`, "clip");
      const still = probe.video.still;
      const speed = clip.speed ?? 1;
      const end = clip.start + (clip.out - clip.in) / speed;
      const toTimeline = (source: number) => clip.start + (source - clip.in) / speed;
      const range = still ? undefined : { from: clip.in, to: clip.out };
      const project = (await readEnclosingProject(dir))?.config.resolution ?? { width: 1920, height: 1080 };
      const warnings: string[] = [];
      let samples = 0;
      let faces = 0;
      let follows: "face" | "person" | "anchor" = "face";
      let points: FacePoint[];
      if (anchor !== undefined) {
        follows = "anchor";
        points = [{ time: clip.in, x: anchor, y: 0.5 }];
      } else if (personRef !== undefined) {
        follows = "person";
        const found = await people.faceTrack(dir, personRef, clip.asset, faceScans(dir), range);
        if (!found.scanned) {
          throw invalid(`${clip.asset} has no face scan, so ${found.person.name}'s face is not known there: frameshell people scan ${clip.asset}`, "person");
        }
        samples = still ? 1 : Math.max(1, Math.round((clip.out - clip.in) * FACE_SAMPLE_HZ));
        faces = found.points.length;
        points = proposeReframeKeys(found.points);
        if (faces === 0) warnings.push(`${found.person.name} has no face in ${clip.asset} between ${clip.in} and ${clip.out} s, so the clip keeps its framing (link their face: frameshell people link).`);
      } else {
        if (!probe.video.width || !probe.video.height) throw invalid(`${clip.asset} has no readable picture size.`, "clip");
        const tell = (update: Progress) => {
          try {
            request.progress(update);
          } catch {
            // Connection closed.
          }
        };
        const detected = await inJob({ kind: "faces", project: dir, asset: clip.asset }, async (ctx) => {
          const projectBins = await projectBinaries(dir);
          const ffmpeg = await binaries.ensure("ffmpeg", projectBins, { onProgress: tell });
          const scan =
            options.faceScanner ??
            yunetWorkerScanner({
              runtime: await binaries.ensure(ONNX_RUNTIME_WEB, projectBins, { onProgress: tell }),
              model: await binaries.ensureModel(FACE_DETECTION_MODEL, { onProgress: tell }),
            });
          ctx.update({ step: "faces", progress: 0 });
          const message = `Finding faces in ${basename(clip.asset)}`;
          return scan({
            ffmpeg,
            path: join(dir, ...clip.asset.split("/")),
            width: probe.video!.width,
            height: probe.video!.height,
            duration: probe.duration ?? undefined,
            range,
            signal: ctx.signal,
            onProgress: (fraction) => {
              ctx.update({ progress: fraction });
              tell({ message, fraction, stage: "faces", values: { angle: basename(clip.asset) } });
            },
          });
        });
        samples = detected.samples;
        faces = detected.faces;
        points = detected.keys;
        if (faces === 0) warnings.push(`No face found in ${detected.samples} frames of ${clip.id}, so it keeps its framing (look at a frame, then pass --anchor).`);
        else if (faces < samples / 4) warnings.push(`A face in only ${faces} of ${samples} frames of ${clip.id}; check its keys.`);
      }
      const nothing = (): MethodResult<"clip.reframe"> => ({
        timeline,
        revision: loaded.revision,
        clip: clip.id,
        format: `${format.width}x${format.height}`,
        follows,
        samples,
        faces,
        placement: null,
        keys: 0,
        operations: [],
        tx: null,
        warnings,
      });
      if (points.length === 0) return nothing();
      const plan = planReframe({ source: { width: probe.video.width, height: probe.video.height }, project, format }, points, toTimeline);
      if (Math.abs(project.width / project.height - format.width / format.height) > 0.01) {
        warnings.push(
          `The project is ${project.width}x${project.height}: its preview shows the clip zoomed, and an export in ${format.width}:${format.height} (e.g. the vertical-1080x1920 preset) shows the framing.`,
        );
      }
      const had = clip.keys?.x || clip.keys?.y || clip.keys?.scale || clip.transform?.x !== undefined || clip.transform?.y !== undefined || clip.transform?.scale !== undefined;
      if (had) warnings.push(`${clip.id} had its own x, y or scale (static or keys): replaced.`);
      // Every write joins one transaction, so one revert undoes the framing even from a sessionless client.
      const key = authorOf(caller);
      const next = transactions.next(key, { standalone: true });
      const tx = transactions.isOpen(key, next) ? next : { id: next.id, label: `Reframe ${basename(clip.asset, extname(clip.asset))}` };
      const author = journalAuthorOf(caller);
      const written: string[] = [];
      let revision = loaded.revision;
      const apply = async (op: OperationRequest) => {
        const result = await timelines.apply({ root: dir, cwd, timeline, request: op, author, tx });
        await transactions.applied(key, tx);
        written.push(result.operation.id);
        revision = result.revision;
      };
      await transactions.touching(key, tx, { root: dir, timeline });
      try {
        for (const prop of ["x", "y", "scale"] as const) {
          if (clip.keys?.[prop]) await apply({ op: "clip.key", args: { clip: clip.id, prop, clear: true } } as OperationRequest);
        }
        await apply({ op: "clip.set", args: { clip: clip.id, transform: { scale: plan.scale, x: plan.x, y: plan.y } } } as OperationRequest);
        for (const prop of ["x", "y"] as const) {
          if (!plan.moves[prop]) continue;
          for (const point of plan.keys) {
            const time = Math.min(end, Math.max(clip.start, point.time));
            await apply({ op: "clip.key", args: { clip: clip.id, prop, time, value: point[prop], ...(point.ease ? { ease: point.ease } : {}) } } as OperationRequest);
          }
        }
      } catch (error) {
        // All or nothing: take back what was written, in the same transaction.
        for (const id of written.reverse()) await timelines.revert({ root: dir, cwd, timeline, author, tx, target: id }).catch(() => undefined);
        throw error;
      }
      await settle(key, tx);
      return {
        ...nothing(),
        revision,
        placement: { scale: plan.scale, x: plan.x, y: plan.y },
        keys: plan.moves.x || plan.moves.y ? plan.keys.length : 0,
        operations: written,
        tx: tx.id,
      };
    },
    "multicam.turns": async ({ cwd, timeline, group }, caller) => {
      const dir = await root(cwd);
      const { timeline: loaded } = await loadFor(dir, timeline, caller);
      const found = groupOf(loaded, group, "multicam.turns");
      const result = await groupTurns(turnsSource, dir, found);
      return { timeline, revision: loaded.revision, group, ...result };
    },
    "captions.set": async ({ cwd, timeline, track: trackId, text, file, from, to, replace }, caller) => {
      const dir = await root(cwd);
      const { timeline: loaded, fps } = await loadFor(dir, timeline, caller);
      const track = loaded.tracks.find((candidate) => candidate.id === trackId);
      const invalid = (message: string, field: string) =>
        new RpcError(ErrorCode.InvalidOperation, `captions.set: ${message}`, { op: "captions.set", reason: field, field });
      if (!track || track.kind !== "subtitles") {
        // The engine names what is wrong with the track.
        await operate("captions.set", { cwd, timeline, track: trackId, phrases: [], replace: false }, caller);
        throw new Error("captions.set: the operation accepted a track that is not a subtitle track");
      }
      if (text !== undefined && file !== undefined) throw invalid("give `text` or `file`, not both.", "file");
      const source = text ?? (file === undefined ? undefined : await readCaptionFile(dir, cwd, file));
      if (source === undefined && replace !== true) {
        throw invalid("give `text` or `file` (the captions, one phrase per line), or `replace: true` alone to clear the phrases.", "text");
      }
      const grid = new FrameGrid(fps);
      const first = from === undefined ? 0 : grid.frame(from);
      const last = to === undefined ? Number.POSITIVE_INFINITY : grid.frame(to);
      const transcripts = new Map<string, Transcript>();
      let phrases: CaptionPhrase[] = [];
      let covered = 0;
      let warnings: string[] = [];
      if (source !== undefined) {
        const followed = loaded.tracks.find((candidate) => candidate.id === track.follows);
        const assets = followed && followed.kind !== "subtitles" ? followed.clips.flatMap((clip) => (clip.type === "media" && "asset" in clip ? [clip.asset] : [])) : [];
        for (const asset of new Set(assets)) {
          const found = await resolveTranscript(dir, asset).then((resolved) => resolved.previous, () => null);
          if (found) transcripts.set(asset, found);
        }
        const shown = subtitleWords(loaded, track.id, (asset) => transcripts.get(asset) ?? null, fps).filter((word) => word.start >= first && word.start < last);
        if (shown.length === 0) {
          throw invalid(
            `track ${track.id} shows no words in that range. Transcribe the assets of ${track.follows} first (\`frameshell transcribe\`), or check \`from\` and \`to\`.`,
            "text",
          );
        }
        const resolved = resolveCaptions(parseCaptionText(source), shown, (word) => word.start / fps);
        phrases = resolved.phrases;
        covered = resolved.words;
        warnings = resolved.warnings;
      }
      let written: Timeline | undefined;
      const result = await operate("captions.set", { cwd, timeline, track: trackId, phrases, replace: replace === true }, caller, (after) => {
        written = after;
      });
      const shown = written ? subtitleTracks(written, (asset) => transcripts.get(asset) ?? null, fps).find((candidate) => candidate.track === trackId) : undefined;
      const cues = (shown?.cues ?? [])
        .filter((cue) => cue.start >= first && cue.start < last)
        .map((cue) => {
          const lead = cueTokens(cue).length - cue.words.length;
          const text = cueTokens(cue)
            .map((token, i) => (cue.keyword !== undefined && i === cue.keyword + lead ? `*${token}*` : token))
            .join(" ");
          return { start: grid.seconds(cue.start), end: grid.seconds(cue.end), text, entry: cue.entry };
        });
      return { ...result, track: trackId, phrases: phrases.length, words: covered, cues: source === undefined ? [] : cues, warnings: [...result.warnings, ...warnings] };
    },
    "multicam.direct": async ({ cwd, timeline, group, template, rules, from, to, replaceHuman }, caller) => {
      const dir = await root(cwd);
      const { timeline: loaded, fps } = await loadFor(dir, timeline, caller);
      const found = groupOf(loaded, group, "multicam.direct");
      const loadedRules = await loadDirectorRules(dir, cwd, rules, template);
      const measured = await groupTurns(turnsSource, dir, found);
      const turns = measured.turns.map(({ angle, start, end }) => ({ angle, start, end }));
      const screens = loadedRules.rules.screen.motion === null ? null : await groupMotion(motion, dir, found, loadedRules.rules.screen.threshold);
      let written: Timeline | undefined;
      let keep: string[] = [];
      const args = { cwd, timeline, group, from, to, turns, ...(screens ? { motion: screens.motion } : {}), rules: loadedRules.rules, keep };
      // Human shots come from the timeline and journal the operation applies to: measuring turns
      // can take long, and a shot a person sets meanwhile must still be kept.
      const prepare = async (current: Timeline, request: OperationRequest): Promise<OperationRequest> => {
        const program = current.tracks.find((track): track is ProgramTrack => track.kind === "program" && track.group === group);
        keep = replaceHuman === true || !program ? [] : humanShots(await readJournal(dir, timeline), program);
        return { ...request, args: { ...request.args, keep } } as OperationRequest;
      };
      const result = await operate(
        "multicam.direct",
        args,
        caller,
        (after) => {
          written = after;
        },
        prepare,
      );
      const track = written?.tracks.find((candidate): candidate is ProgramTrack => candidate.kind === "program" && candidate.group === group);
      if (!track) throw new Error("multicam.direct: the operation left no program track");
      const grid = new FrameGrid(fps);
      const first = grid.frame(grid.snap(from ?? 0));
      // A shot cut by both ends of the range leaves its tail as a new id after `to`: not a directed shot.
      const end = to === undefined ? Number.POSITIVE_INFINITY : grid.snap(to);
      const last = to === undefined ? Number.POSITIVE_INFINITY : grid.frame(end);
      const added = new Set(track.clips.filter((shot) => result.changes.added.includes(shot.id) && shot.start < end - 1e-6).map((shot) => shot.id));
      const keptIds = new Set(keep);
      const inRange = (shot: ShotClip) => grid.frame(shot.start + shot.out - shot.in) > first && grid.frame(shot.start) < last;
      const unknown = unknownWeights(loadedRules.rules, found);
      const warnings = [
        ...result.warnings,
        ...measured.warnings,
        ...(screens?.warnings ?? []),
        ...(unknown.length > 0 ? [`weights name ${unknown.join(", ")}, not angles of group ${group} (angles: ${found.angles.map((angle) => angle.id).join(", ")}).`] : []),
      ];
      return {
        ...result,
        // The journal keeps every turn; the reply only counts them, so an agent's context is not spent on them.
        operation: { ...result.operation, args: { ...result.operation.args, turns: turns.length } },
        group,
        track: track.id,
        template: loadedRules.template,
        rulesFile: loadedRules.rulesFile,
        shots: added.size,
        kept: track.clips.filter((shot) => keptIds.has(shot.id) && inRange(shot)).map((shot) => shot.id),
        low: lowShots(track, added),
        warnings,
      };
    },
    "tx.begin": async ({ label, autoCommitAfter, cwd }, caller) => {
      const author = authorOf(caller);
      const project = cwd === undefined ? undefined : ((await readEnclosingProject(cwd))?.dir ?? null);
      // A directory in no project has no proposal to wait for.
      if (project !== null) await timelines.assertCanBegin(author, project);
      const autoCommitMs = autoCommitAfter === undefined ? undefined : autoCommitAfter * 1000;
      const tx = await transactions.begin(author, label, { autoCommitMs });
      return { tx: tx.id, label, author };
    },
    "tx.commit": async (_params, caller) => {
      const author = authorOf(caller);
      const { tx, operations } = await transactions.end(author);
      return { tx: tx.id, label: tx.label, author, operations, proposal: await timelines.ready(tx.id) };
    },
    "tx.abort": async (_params, caller) => {
      const author = authorOf(caller);
      const { tx, touched } = transactions.peek(author);
      const configRoots: string[] = [];
      // A config root whose change failed journaled nothing: nothing to undo there.
      for (const where of touched) if (!isTouchedTimeline(where) && (await configJournal.has(where.root, tx.id))) configRoots.push(where.root);
      // Config undo cannot wait as a proposal yet (ADR 0036 slice 2): refused before anything is dropped.
      for (const dir of configRoots) await formatsOutsideReview(dir, caller);
      // A proposal still building holds what the file never got (ADR 0019 §3).
      await timelines.abortProposal(tx.id);
      // All or nothing; a conflict leaves the transaction open to resolve, or to commit instead.
      // In review mode an undo of what reached the file waits as a proposal of its own.
      // Config is planned before the timelines and written after them (ADR 0036).
      const done = await holdingConfig(configRoots, async () => {
        const plans = [];
        for (const dir of new Set(configRoots)) {
          try {
            plans.push({ dir, plans: await configJournal.planRevert(dir, tx.id) });
          } catch (error) {
            if (!(error instanceof RpcError && error.code === ErrorCode.RevertConflict)) throw error;
            throw new RpcError(
              ErrorCode.RevertConflict,
              `Cannot abort ${tx.id}: nothing was undone, because reverting it conflicts in the project config.\n${error.message}\n` +
                "The transaction stays open: resolve the conflict and abort again, or commit it.",
              { ...(error.data as Record<string, unknown>), target: tx.id, timelines: [] },
            );
          }
        }
        const timelineUndo = touched.filter(isTouchedTimeline);
        const { reverted, proposal } = await timelines.revertAll({ author: journalAuthorOf(caller), tx, target: tx.id, timelines: timelineUndo });
        const config = [];
        for (const { dir, plans: planned } of plans) {
          const written = await configJournal.commitRevert(dir, planned, { author: journalAuthorOf(caller), tx, target: tx.id });
          config.push(...written.map(configOperation));
        }
        return { reverted, proposal, config };
      });
      await transactions.end(author);
      return { tx: tx.id, label: tx.label, author, ...done };
    },
    history: async ({ cwd, timeline, since }) => timelines.history(await root(cwd), timeline, { since }),
    "history.diff": async ({ cwd, timeline, target }) => {
      const dir = await root(cwd);
      try {
        return await timelines.diff(dir, timeline, target);
      } catch (error) {
        if (!(error instanceof RpcError && error.code === ErrorCode.HistoryNotFound && (await configJournal.has(dir, target)))) throw error;
        const holding = await timelinesHolding(dir, target);
        if (holding.length > 0) throw historyElsewhere(target, timeline, holding);
        // A config-only target (ADR 0036) changed no clips.
        return { timeline, target, clips: [] };
      }
    },
    revert: async ({ cwd, timeline, target }, caller) => {
      const dir = await root(cwd);
      if (await configJournal.has(dir, target)) return revertConfig(dir, cwd, timeline, target, caller);
      return { ...(await revert(dir, cwd, timeline, target, caller)), config: [] };
    },
    "review.set": async ({ cwd, enabled }, caller) => {
      onlyUi(caller, "turn review mode on or off");
      const dir = await root(cwd);
      await review.set(await canonicalPath(dir), enabled);
      return { dir, enabled };
    },
    "proposal.diff": async ({ cwd, tx }) => timelines.proposalDiff(await root(cwd), tx),
    "proposal.status": async ({ cwd }) => {
      const dir = await root(cwd);
      return { dir, ...(await timelines.review(dir)) };
    },
    "proposal.wait": async ({ cwd, timeout }, caller) =>
      timelines.waitProposal(await root(cwd), (timeout ?? PROPOSAL_WAIT_DEFAULT_S) * 1000, journalAuthorOf(caller)),
    "proposal.accept": async ({ cwd, tx }, caller) => {
      onlyUi(caller, "accept a proposal", tx);
      return timelines.acceptProposal(await root(cwd), tx);
    },
    "proposal.reject": async ({ cwd, tx }, caller) => {
      onlyUi(caller, "reject a proposal", tx);
      return timelines.rejectProposal(await root(cwd), tx);
    },
    "style.show": async ({ cwd }) => showStyle(await root(cwd)),
    "people.list": async ({ cwd }) => {
      const dir = await root(cwd);
      return { dir, ...(await people.list(dir)) };
    },
    "people.add": async ({ cwd, name }) => {
      const dir = await root(cwd);
      return { dir, person: await people.add(dir, name) };
    },
    "people.rename": async ({ cwd, person, name }) => {
      const dir = await root(cwd);
      return { dir, ...(await people.rename(dir, person, name)) };
    },
    "people.remove": async ({ cwd, person }) => {
      const dir = await root(cwd);
      return { dir, removed: await people.remove(dir, person) };
    },
    "people.link": async ({ cwd, person, speaker, angle, face }, caller) => {
      const dir = await root(cwd);
      // An agent's confirmation is marked on the link (ADR 0020 §10); a person's own is not.
      const author = journalAuthorOf(caller);
      return { dir, ...(await people.link(dir, person, { speaker, angle, face }, author.startsWith("agent:") ? author : undefined)) };
    },
    "people.unlink": async ({ cwd, person, speaker, angle, face }) => {
      const dir = await root(cwd);
      return { dir, person: await people.unlink(dir, person, { speaker, angle, face }) };
    },
    "people.scan": async ({ cwd, assets, force }, _caller, request) => {
      const dir = await root(cwd);
      // The caller may be gone (the job outlives it): its progress is then dropped.
      const tell = (update: Progress) => {
        try {
          request.progress(update);
        } catch {
          // Connection closed.
        }
      };
      const names = assets ?? (await media.list(dir)).map((asset) => asset.path);
      return inJob({ kind: "people", project: dir, asset: [...names].sort().join(",") }, async (ctx) => {
        ctx.update({ step: "people", progress: 0 });
        const project = await projectBinaries(dir);
        const result = await scanProjectFaces(dir, { assets, force }, {
          listAssets: async () => names,
          probe: (d, rel) => media.probe(d, rel),
          hash: async (d, rel) => (await media.derivedAudio(d, rel)).hash,
          ffmpeg: () => binaries.ensure("ffmpeg", project, { onProgress: tell }),
          scanner: async () =>
            options.peopleScanner ??
            peopleScanWorker({
              runtime: await binaries.ensure(ONNX_RUNTIME_WEB, project, { onProgress: tell }),
              detector: await binaries.ensureModel(FACE_DETECTION_MODEL, { onProgress: tell }),
              recognizer: await binaries.ensureModel(FACE_RECOGNITION_MODEL, { onProgress: tell }),
            }),
          onProgress: (progress) => ctx.update({ progress }),
          report: tell,
          signal: ctx.signal,
        });
        return { dir, ...result };
      });
    },
    "matte.prepare": async ({ cwd, asset }, _caller, request) => {
      const dir = await root(cwd);
      const invalid = (reason: string, message: string) => new RpcError(ErrorCode.InvalidOperation, `matte.prepare: ${message}`, { op: "matte.prepare", reason, field: "asset" });
      const project = await readEnclosingProject(dir);
      // ADR 0032 decision 6: no plates in image projects.
      if (project?.config.kind === "image") throw invalid("image project", "image projects have no video to matte.");
      const { rel } = await resolveAsset(dir, resolve(cwd, asset));
      const probe = await media.probe(dir, rel);
      if (!probe.video || probe.video.still) throw invalid("not a video", `${rel} has no moving picture to matte.`);
      // Before the job: the ingest needs a slot of the same queue.
      const ready = await media.ingested(dir, rel);
      if (!ready.proxy) throw invalid("not a video", `${rel} has no moving picture to matte.`);
      const proxy = ready.proxy;
      const fps = project?.config.fps ?? 30;
      const key = matteKey(ready.hash, matteModel, fps);
      const describe = (info: MatteInfo, cached: boolean): MethodResult<"matte.prepare"> => ({
        asset: rel,
        hash: ready.hash,
        model: matteModel,
        matte: mattePaths(key).video,
        size: { width: info.width, height: info.height },
        fps: info.fps,
        frames: info.frames,
        cached,
        seconds: info.seconds,
      });
      const known = await readMatteInfo(dir, key, ready.hash);
      if (known) return describe(known, true);
      // The caller may be gone (the job outlives it): its progress is then dropped.
      const tell = (update: Progress) => {
        try {
          request.progress(update);
        } catch {
          // Connection closed.
        }
      };
      const made = await matteInJob(dir, rel, { hash: ready.hash, proxy }, tell);
      return describe(made.info, made.cached);
    },
    "matte.status": async ({ cwd, timeline, view }, caller) => {
      const dir = await root(cwd);
      const shown = await timelines.viewTimeline(dir, timeline, await viewOf(dir, caller, view));
      const flat = await resolveNested(dir, shown.timeline, undefined, shown.fps);
      const listed = new Map((await media.list(dir)).map((info) => [info.path, info]));
      // Not probed yet counts as moving: it is `waiting` until its ingest says.
      const moving = (asset: string) => {
        const info = listed.get(asset);
        if (info?.kind !== "media" || info.state === "failed") return false;
        return info.media === null || (info.media.video !== null && !info.media.video.still);
      };
      const assets = subjectAssets(flat, moving);
      if (assets.length === 0) return { timeline, revision: shown.timeline.revision, mattes: [] };
      const fps = (await readEnclosingProject(dir))?.config.fps ?? 30;
      const canonical = canonicalPathSync(dir);
      const mattes: MatteStateInfo[] = [];
      for (const asset of assets) {
        const info = listed.get(asset)!;
        const base = { asset, matte: null, progress: 0, job: null, error: null };
        if (info.state !== "ready" || info.hash === null || info.proxy === null) {
          mattes.push({ ...base, state: "waiting" });
          continue;
        }
        const ready = { hash: info.hash, proxy: info.proxy };
        const key = matteKey(ready.hash, matteModel, fps);
        if (await readMatteInfo(dir, key, ready.hash)) {
          mattes.push({ ...base, state: "ready", matte: mattePaths(key).video, progress: 1 });
          continue;
        }
        const slot = `${canonical}\0${key}`;
        const failed = matteFailures.get(slot);
        if (failed !== undefined) {
          mattes.push({ ...base, state: "failed", error: failed });
          continue;
        }
        const active = () => jobs.list({ project: dir, active: true }).find((job) => job.kind === "matte" && job.asset === asset);
        if (!active()) {
          // The job's own end, not the promise: a job canceled by the user or a daemon stop is queued again next read.
          matteInJob(dir, asset, ready).catch(() => {});
          const queued = active()?.id;
          const stop = jobs.watch(({ job: change }) => {
            if (change.id !== queued || (change.state !== "done" && change.state !== "failed" && change.state !== "canceled")) return;
            stop();
            if (change.state === "failed") matteFailures.set(slot, change.error ?? "The matte could not be made.");
          });
          if (queued === undefined) stop();
        }
        const job = active();
        mattes.push({ ...base, state: job?.state === "running" ? "making" : "queued", progress: job?.progress ?? 0, job: job?.id ?? null });
      }
      return { timeline, revision: shown.timeline.revision, mattes };
    },
    "beats.measure": async ({ cwd, asset, bpm, resetEdits }, _caller, request) => {
      const dir = await root(cwd);
      const { rel } = await resolveAsset(dir, resolve(cwd, asset));
      const probe = await media.probe(dir, rel);
      if (!probe.audio) {
        throw new RpcError(ErrorCode.InvalidOperation, `beats.measure: ${rel} has no audio to measure.`, { op: "beats.measure", reason: "no audio", field: "asset" });
      }
      return inJob({ kind: "beats", project: dir, asset: rel }, async (ctx) => {
        ctx.update({ step: "beats", progress: 0 });
        // The caller may be gone (the job outlives it): its progress is then dropped.
        try {
          request.progress({ message: `Measuring the beats of ${rel}`, stage: "beats", values: { asset: rel } });
        } catch {
          // Connection closed.
        }
        const started = Date.now();
        // Named before the work: a broken or foreign file fails now, not after a minute of analysis.
        const target = await resolveBeatsFile(dir, rel);
        const measured = await beats.measure(dir, rel, { hint: bpm, signal: ctx.signal, onProgress: (progress) => ctx.update({ progress }) });
        const file = beatsFileOf({ asset: rel, measured, previous: target.previous, keepEdits: !resetEdits });
        await writeTextAtomic(target.path, formatBeatsFile(file));
        return {
          ...summarizeBeats(file, target.rel).summary,
          cached: measured.cached,
          keptEdits: Object.keys(file.edits).length > 0,
          seconds: Math.round((Date.now() - started) / 100) / 10,
        };
      });
    },
    "beats.show": async ({ cwd, asset }) => {
      const dir = await root(cwd);
      const { rel } = await resolveAsset(dir, resolve(cwd, asset));
      const found = await ownBeatsFile(dir, rel);
      if (!found) {
        throw new RpcError(ErrorCode.InvalidOperation, `beats.show: ${rel} has no beat grid yet. Run \`beats.measure\` (CLI: frameshell beats measure ${rel}).`, {
          op: "beats.show",
          reason: "not measured",
          field: "asset",
        });
      }
      const { grid, summary } = summarizeBeats(found.file, found.rel);
      const { hash } = await media.derivedAudio(dir, rel);
      return { ...summary, current: hash === found.file.assetHash, edits: found.file.edits, beats: grid.beats, downbeats: grid.downbeats };
    },
    "people.ranges": async ({ cwd, person, kind, timeline }, caller) => {
      const dir = await root(cwd);
      const { timeline: loaded } = await loadFor(dir, timeline, caller);
      const flat = await resolveNested(dir, loaded);
      const found = await people.ranges(dir, person, kind, flat, (group) => groupTurns(turnsSource, dir, group), faceScans(dir));
      return { dir, person: { id: found.person.id, name: found.person.name }, kind, timeline, spans: found.spans, total: found.total, warnings: found.warnings };
    },
    // Both read transcription WAVs: `transcribing` keeps `gc` off them meanwhile.
    "people.suggest": async ({ cwd, download }, _caller, request) => {
      const dir = await root(cwd);
      const missing = download ? 0 : await voiceDownloadBytes(dir);
      let held = false;
      // Without the download, voices that would need the model are reported as not compared.
      const voices: VoicePrinter =
        missing === 0
          ? voicePrinter(dir, request.progress)
          : async (wanted) => {
              if (wanted.length > 0) held = true;
              return new Map(wanted.map((entry) => [voiceKey(entry), { ok: false, reason: "the voice model is not downloaded yet" }]));
            };
      const found = await transcribing(dir, () => people.suggest(dir, { voices, faces: faceScans(dir), scripts: () => shoots.voices(dir) }));
      return { dir, ...found, ...(held ? { voiceDownload: { bytes: missing } } : {}) };
    },
    "people.confirm": async ({ cwd, suggestions, reject, person }, caller, request) => {
      const dir = await root(cwd);
      const author = journalAuthorOf(caller);
      const by = author.startsWith("agent:") ? author : undefined;
      return { dir, ...(await transcribing(dir, () => people.confirm(dir, suggestions, { reject, by, person, voices: voicePrinter(dir, request.progress), faces: faceScans(dir), scripts: () => shoots.voices(dir) }))) };
    },
    "target.register": async ({ cwd, client, title, kind }, caller) => {
      const dir = await root(cwd);
      return { dir, target: targets.register(caller, await canonicalPath(dir), { client, title, kind }) };
    },
    "target.unregister": async ({ cwd }, caller) => {
      const dir = await root(cwd);
      targets.unregister(caller, await canonicalPath(dir));
      return { dir };
    },
    "target.list": async ({ cwd }) => {
      const dir = await root(cwd);
      return { dir, targets: targets.list(await canonicalPath(dir)) };
    },
    "inbox.put": async ({ cwd, target, lines }) => {
      const dir = await root(cwd);
      return { dir, ...targets.put(await canonicalPath(dir), target, lines) };
    },
    "inbox.take": async ({ cwd, target }, caller) => {
      const dir = await root(cwd);
      const key = await canonicalPath(dir);
      const id = inboxOf(caller, key, target);
      return { dir, target: id, references: id === null ? [] : targets.take(key, id) };
    },
    "inbox.wait": async ({ cwd, target, timeout }, caller) => {
      const dir = await root(cwd);
      const key = await canonicalPath(dir);
      const id = inboxOf(caller, key, target);
      if (id === null || !targets.has(key, id)) {
        const known = targets.list(key).map((each) => each.id);
        throw new RpcError(
          ErrorCode.InvalidParams,
          id === null
            ? "This connection is no agent target of the project: register first (`frameshell ask --wait` does) or name a `target`."
            : `No agent target \`${id}\` in this project; ${known.length > 0 ? `targets: ${known.join(", ")}` : "none is registered"}.`,
          { issues: [{ path: ["target"], message: id === null ? "required" : "unknown target" }], targets: known },
        );
      }
      return { dir, target: id, references: await targets.wait(caller, key, id, (timeout ?? INBOX_WAIT_DEFAULT_S) * 1000) };
    },
    "ui.state": async ({ cwd }) => ui.state(await projectKey(cwd)),
    "ui.seek": async ({ cwd, at }) => ui.command(await projectKey(cwd), { kind: "seek", at }),
    "ui.play": async ({ cwd }) => ui.command(await projectKey(cwd), { kind: "play" }),
    "ui.pause": async ({ cwd }) => ui.command(await projectKey(cwd), { kind: "pause" }),
    "ui.select": async ({ cwd, clips, words, range, reveal, points, person }) => {
      // A name is resolved here, so an unknown person fails with the people list, as `people.ranges` would.
      let picked: { id: string; what: "speaks" | "onscreen" } | null = null;
      if (person) {
        const known = await people.list(await root(cwd));
        const found = findPerson(known, person.id);
        if (!found) {
          const names = known.people.map((candidate) => `${candidate.name} (${candidate.id})`).join(", ");
          throw new RpcError(ErrorCode.InvalidOperation, `ui.select: no person "${person.id}"${names ? ` (people: ${names})` : ", the project has no people yet"}.`, {
            op: "ui.select",
            reason: "unknown person",
            field: "person",
          });
        }
        picked = { id: found.id, what: person.what };
      }
      // Points are inspected here, so the app shows exactly what `inspect.point` reports.
      const dir = points.length > 0 ? await root(cwd) : null;
      const inspected = [];
      for (const point of points) {
        const { timeline: _timeline, frame: _frame, pixel: _pixel, ...picked } = await inspector.point(dir!, { timeline: "main", ...point });
        inspected.push(picked);
      }
      return ui.command(await projectKey(cwd), { kind: "select", clips, words, range, reveal, points: inspected, person: picked });
    },
    "ui.openFile": async ({ cwd, file }) => {
      const dir = await root(cwd);
      return ui.command(await canonicalPath(dir), { kind: "openFile", path: projectRelative(dir, file) });
    },
    "ui.showTxDiff": async ({ cwd, timeline, target }) => ui.command(await projectKey(cwd), { kind: "showTxDiff", timeline, target }),
    "ui.publish": async ({ cwd, view, state, focused }, _caller, request) => {
      // Sent on every change: resolve the project once per window and cwd, not per playhead move.
      const known = ui.registered(request.sink, view);
      if (known?.cwd === cwd) {
        ui.publish(request.sink, view, known, state, focused);
        return { dir: known.dir };
      }
      const dir = await root(cwd);
      ui.publish(request.sink, view, { key: await canonicalPath(dir), dir, cwd }, state, focused);
      return { dir };
    },
    "ui.active": async () => ({ dir: ui.active()?.dir ?? null }),
    "ui.reply": async ({ view, id, error, state }, _caller, request) => {
      ui.reply(request.sink, view, id, error, state);
      return {};
    },
    "ui.detach": async ({ view }, _caller, request) => {
      ui.detach(request.sink, view);
      return {};
    },
  };

  const server: Server = createServer((socket) => {
    clients.add(socket);
    armIdleTimer();
    let handshaken = false;
    const caller: Caller = { client: "", session: null };
    const sink: EventSink = { notify: (method, params) => writeMessage(socket, { jsonrpc: "2.0", method, params }) };
    socket.on("error", () => socket.destroy());
    socket.on("close", () => {
      events.drop(sink);
      for (const [session, tag] of sessionTags) if (tag.owner === caller) sessionTags.delete(session);
      targets.drop(caller);
      ui.drop(sink);
      clients.delete(socket);
      armIdleTimer();
    });
    readMessages(
      socket,
      (message) => {
        // Never let one bad message reject unhandled: Node would kill the daemon.
        void dispatch(message)
          .then((reply) => {
            if (reply) writeMessage(socket, reply);
          })
          .catch(() => socket.destroy());
      },
      () => writeMessage(socket, errorReply(null, ErrorCode.ParseError, "Parse error: each line must be one JSON value")),
    );

    /** Any JSON value may arrive; shape is checked before any field is trusted. */
    async function dispatch(message: unknown) {
      const id = requestId(message);
      if (!isRequest(message)) return errorReply(id, ErrorCode.InvalidRequest, "Invalid JSON-RPC 2.0 request");
      const request = message;
      try {
        const { method } = request;
        if (method === "handshake") {
          checkProtocolVersion(request.params);
        } else if (!handshaken) {
          throw new RpcError(ErrorCode.HandshakeRequired, "Send `handshake` before any other method");
        }
        if (!isMethodName(method)) throw new RpcError(ErrorCode.MethodNotFound, `Unknown method: ${method}`);
        const { params, idempotencyKey } = parseRequest(method, request.params);
        // Set before the await: a request pipelined behind the handshake is dispatched
        // while the handshake handler is still pending. Invalid params never get here.
        if (method === "handshake") handshaken = true;
        const context: RequestContext = {
          progress: (update) => {
            if (request.id !== undefined) writeMessage(socket, { jsonrpc: "2.0", method: "progress", params: { requestId: request.id, ...update } });
          },
          sink,
        };
        const handler = handlers[method] as (p: typeof params, c: Caller, r: RequestContext) => Promise<unknown>;
        const result = await (idempotencyKey === null
          ? handler(params, caller, context)
          : replays.run(authorOf(caller), idempotencyKey, method, params, () => handler(params, caller, context)));
        return request.id === undefined ? undefined : { jsonrpc: "2.0" as const, id, result };
      } catch (error) {
        if (request.id === undefined) return undefined;
        if (error instanceof RpcError) return errorReply(id, error.code, error.message, error.data);
        return errorReply(id, ErrorCode.InternalError, (error as Error).message ?? String(error));
      }
    }
  });

  function armIdleTimer() {
    clearTimeout(idleTimer);
    if (clients.size > 0 || jobs.busy || clipJobs.busy || closing || !Number.isFinite(idleTimeoutMs)) return;
    idleTimer = setTimeout(() => void close(), idleTimeoutMs);
    idleTimer.unref?.();
  }

  function close(): Promise<void> {
    closing ??= (async () => {
      clearTimeout(idleTimer);
      transactions.close();
      await new Promise<void>((resolve) => {
        for (const socket of clients) socket.destroy();
        server.close(() => resolve());
      });
      // Canceled jobs are found again from disk when the project next opens.
      voiceoverAbort.abort();
      await media.close();
      await segmentation.close();
      await timelineWatcher.close();
      await clips.close();
      await clipJobs.close();
      await jobs.close();
    })().then(resolveClosed);
    return closing;
  }

  await listenCleaningStaleSocket(server, socketPath);
  armIdleTimer();
  return { socketPath, closed, close };
}

/**
 * SPEC §6.2 author of a connection's operations as transactions and replays
 * key them: the app is `ui`, a Frameshell terminal `cli:<session>`, whether
 * or not an agent runs in it (journal authors may say `agent:…`).
 */
function authorOf(caller: Caller): string {
  if (caller.client.startsWith("desktop/")) return "ui";
  return caller.session ? `cli:${caller.session}` : "cli";
}

/** {@link authorOf} key of a journal author: an agent's operations belong to its terminal session's transactions. */
function transactionKey(author: string): string {
  const match = /^agent:[^:]+(?::(.+))?$/.exec(author);
  if (!match) return author;
  return match[1] ? `cli:${match[1]}` : "cli";
}

/** Thrown from `multicam.faces`' prepare step: the angle got keys meanwhile, so nothing is written for it. */
class KeptAngle extends Error {}

/** Group `group` of `timeline`; InvalidOperation for `op` listing the groups there are. */
function groupOf(timeline: Timeline, group: string, op: string): MulticamGroup {
  const found = timeline.groups?.find((candidate) => candidate.id === group);
  if (found) return found;
  const ids = timeline.groups?.map((candidate) => candidate.id).join(", ");
  throw new RpcError(
    ErrorCode.InvalidOperation,
    `${op}: no group "${group}" in this timeline${ids ? ` (groups: ${ids})` : " (it has no multicam groups; make one with `multicam create`)"}.`,
    { op, reason: "unknown group", field: "group", groups: timeline.groups?.map((candidate) => candidate.id) ?? [] },
  );
}

/** `file` (absolute, or relative to the project root) as a project-relative `/`-separated path; OutsideProject beyond `root`. */
function projectRelative(root: string, file: string): string {
  const rel = relative(root, resolve(root, file));
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new RpcError(ErrorCode.OutsideProject, `${file} is not a file inside the project ${root}.`, { path: file });
  }
  return rel.split(sep).join("/");
}

function isRequest(message: unknown): message is JsonRpcRequest {
  if (typeof message !== "object" || message === null || Array.isArray(message)) return false;
  const { jsonrpc, method, id } = message as Record<string, unknown>;
  return jsonrpc === "2.0" && typeof method === "string" && (id === undefined || isValidId(id));
}

function isValidId(id: unknown): id is number | string | null {
  return id === null || typeof id === "string" || typeof id === "number";
}

/** Echoable id, or `null` when the message has none usable (JSON-RPC 2.0 §5). */
function requestId(message: unknown): number | string | null {
  if (typeof message !== "object" || message === null) return null;
  const id = (message as { id?: unknown }).id;
  return isValidId(id) ? id : null;
}

/** Runs before param validation so a future client's handshake still gets the actionable mismatch error. */
function checkProtocolVersion(params: unknown): void {
  const clientVersion = (params as { protocolVersion?: unknown } | null | undefined)?.protocolVersion;
  if (typeof clientVersion !== "number") return; // parseParams reports it.
  if (clientVersion === PROTOCOL_VERSION) return;
  const older = clientVersion < PROTOCOL_VERSION ? "the client (frameshell CLI or app)" : "frameshelld";
  throw new RpcError(
    ErrorCode.IncompatibleProtocol,
    `Protocol mismatch: client speaks v${clientVersion}, frameshelld ${DAEMON_VERSION} (pid ${process.pid}) speaks v${PROTOCOL_VERSION}. ` +
      `Upgrade ${older} so both match. A stale daemon exits after its idle timeout, or stop it with \`kill ${process.pid}\`.`,
    { clientProtocolVersion: clientVersion, daemonProtocolVersion: PROTOCOL_VERSION, daemonVersion: DAEMON_VERSION },
  );
}

function errorReply(id: number | string | null, code: number, message: string, data?: unknown) {
  return { jsonrpc: "2.0" as const, id, error: data === undefined ? { code, message } : { code, message, data } };
}
