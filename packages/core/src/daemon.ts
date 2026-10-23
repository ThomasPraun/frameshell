import { createRequire } from "node:module";
import { type Server, type Socket, createServer } from "node:net";
import { readFile } from "node:fs/promises";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  ErrorCode,
  type EventName,
  type EventParams,
  type HandshakeResult,
  type JsonRpcRequest,
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
  type TimelineViewName,
  assertSocketPathFits,
  isMethodName,
  parseRequest,
  readMessages,
  resolveAppDirs,
  writeMessage,
} from "@frameshell/protocol";
import { type MulticamGroup, type ProgramTrack, type ShotClip, type Timeline, parseTimeline } from "@frameshell/schema";
import { runDoctor } from "./binaries/doctor.js";
import { ExportService } from "./export/service.js";
import { EventHub, type EventSink } from "./events.js";
import { canonicalPath, canonicalPathSync } from "./fs-util.js";
import { BinaryManager } from "./binaries/manager.js";
import { type JobContext, JobQueue, type JobRequest } from "./jobs/queue.js";
import { listenCleaningStaleSocket } from "./listen.js";
import { EnergyStore } from "./media/energy-store.js";
import { MediaService } from "./media/service.js";
import { probeMedia } from "./media/ffmpeg.js";
import { type TurnsSource, groupTurns } from "./multicam/group-turns.js";
import { MotionStore, groupMotion } from "./multicam/motion.js";
import { humanShots, loadDirectorRules, lowShots, unknownWeights } from "./multicam/direct.js";
import { readJournal } from "./history/journal.js";
import { measureAngles, syncReport } from "./multicam/measure.js";
import { analyseGallery } from "./multicam/gallery.js";
import { type FaceScanner, yunetWorkerScanner } from "./multicam/faces.js";
import {
  FACE_DETECTION_MODEL,
  ONNX_RUNTIME_WEB,
  PHOTO_SEGMENTATION_DECODER_MODEL,
  PHOTO_SEGMENTATION_ENCODER_MODEL,
} from "./binaries/manifest.js";
import { workerSegmentEngine } from "./segment/engine.js";
import type { SegmentEngine } from "./segment/segmenter.js";
import { checkMask, cutoutTransform, freeCutoutName, isMediaClip, renderCutout, resolveMask } from "./segment/cutout.js";
import { SEGMENT_MODEL_PIN, SegmentService } from "./segment/service.js";
import { type GallerySource, galleryReport, planGallery } from "./multicam/gallery-plan.js";
import { projectFormat, type ProjectFormat } from "./media/format.js";
import { ClipRenderer, listTimelineIds } from "./clips/renderer.js";
import { PluginHost } from "./plugins/host.js";
import { ProjectRegistry, readEnclosingProject } from "./projects.js";
import { syncedFolder } from "./synced-folder.js";
import { FileTransactionStore, TransactionTracker } from "./history/transactions.js";
import { ReviewSwitch } from "./proposals/review-switch.js";
import { IdempotencyCache } from "./idempotency.js";
import { outlineScript } from "./scripts/outline.js";
import type { OperationRequest } from "./timeline/engine.js";
import { TimelineService, type TxRef } from "./timeline/service.js";
import { FrameGrid } from "./timeline/grid.js";
import { TimelineWatcher } from "./timeline/watcher.js";
import { energySnapper } from "./timeline/snap.js";
import type { AudioExtractor } from "./transcripts/audio.js";
import { type Diarizer, diarizeAsset } from "./transcripts/speakers.js";
import { resolveAsset, resolveTranscript, transcribeAsset } from "./transcripts/transcriber.js";
import { verifyExport } from "./transcripts/verify.js";
import { UiBroker } from "./ui/broker.js";
import { writeContext } from "./context.js";
import { InspectService } from "./inspect/service.js";
import { resolveNested } from "./timeline/nested.js";

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
  /** Speaker diarization for `transcribe.speakers`. Defaults to sherpa-onnx from {@link DaemonOptions.binaries}. */
  diarize?: Diarizer;
  /** Face scan of one angle for `multicam.faces`. Defaults to YuNet on ONNX Runtime Web from {@link DaemonOptions.binaries}, in a worker thread. */
  faceScanner?: FaceScanner;
  /** Photo segmentation model for `segment.prepare`. Defaults to MobileSAM on ONNX Runtime Web from {@link DaemonOptions.binaries}, in a worker thread. */
  segmentEngine?: SegmentEngine;
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
  const media = new MediaService({
    binaries,
    jobs,
    onAssetChanged: (root, path, asset) => publishFor("asset.changed", root, { project: root, path, asset }),
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
  const projects = new ProjectRegistry({
    onOpen: (dir) => {
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
    onChanged: ({ root, timeline, revision, author, changes }) => {
      events.publish("timeline.changed", root, { project: root, timeline, revision, author, changes });
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
  const exports = new ExportService({
    jobs,
    ffmpeg: async (dir) => {
      const project = await readEnclosingProject(dir);
      return binaries.ensure("ffmpeg", project ? { dir: project.dir, binaries: project.config.binaries } : undefined);
    },
    probe: (dir, asset) => media.probe(dir, asset),
    loadTimeline: (dir, id) => timelines.load(dir, id),
    pluginPresets: async (dir) => (await plugins.presets(dir)).presets,
    clips: {
      check: (dir, timeline) => clips.check(clipRoot(dir), timeline),
      ensure: (dir, timeline, onProgress) => clips.ensure(clipRoot(dir), timeline, onProgress),
    },
    ...(options.renderParallelism !== undefined ? { parallelism: options.renderParallelism } : {}),
    ...(options.renderSegmentSeconds !== undefined ? { segmentSeconds: options.renderSegmentSeconds } : {}),
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
      return { timeline: await resolveNested(dir, timeline), fps };
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
  /** Open explicit transactions that changed project `dir` (however its root was spelled) or nothing yet. */
  const openTransactions = async (dir: string): Promise<OpenTransaction[]> => {
    const real = await canonicalPath(dir);
    const listed: OpenTransaction[] = [];
    for (const { author, tx, operations, touched, openedAt } of transactions.list()) {
      const here = [];
      for (const where of touched) if ((await canonicalPath(where.root)) === real) here.push(where.timeline);
      if (touched.length > 0 && here.length === 0) continue;
      listed.push({
        tx: tx.id,
        label: tx.label,
        author,
        session: author.startsWith("cli:") ? author.slice("cli:".length) : null,
        operations,
        timelines: here,
        openedAt,
        ageMs: openedAt === null ? null : Math.max(0, Date.now() - Date.parse(openedAt)),
      });
    }
    return listed;
  };
  const ui = new UiBroker();
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
      if (project) {
        const pins = await projects.readPins(project.dir);
        trust = { state: await plugins.trustState(project.dir, pins), plugins: pins };
      }
      return {
        daemon: { ...identity, uptimeMs: Date.now() - startedAt, clients: clients.size, socketPath },
        project,
        trust,
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
    doctor: async ({ cwd, install }) => {
      const found = await readEnclosingProject(cwd);
      const project = found ? { dir: found.dir, binaries: found.config.binaries } : undefined;
      return runDoctor(binaries, { project, install });
    },
    "project.trust": async ({ cwd, decision }) => plugins.setTrust(await root(cwd), decision),
    "plugin.list": async ({ cwd }) => plugins.list(await root(cwd)),
    "plugin.install": async ({ cwd, spec }) => plugins.install(await root(cwd), spec, cwd),
    "plugin.remove": async ({ cwd, name }) => plugins.remove(await root(cwd), name),
    "plugin.run": async ({ cwd, plugin, command, args }) => plugins.run(await root(cwd), cwd, plugin, command, args),
    "export.presets": async ({ cwd }) => ({ presets: await exports.presets(await root(cwd)) }),
    render: async ({ cwd, timeline, preset, out }) => exports.render(await root(cwd), { timeline, preset, out }),
    frame: async ({ cwd, timeline, at, out, preset, format, quality, view }, caller) => {
      const dir = await root(cwd);
      const { view: shown, proposal, ...loaded } = await timelines.viewTimeline(dir, timeline, await viewOf(dir, caller, view));
      return { view: shown, proposal, ...(await exports.frame(dir, { timeline, at, out, preset, format, quality }, loaded)) };
    },
    transcribe: async ({ cwd, asset, provider, model, language }, _caller, request) => {
      await projects.requireEnclosing(cwd); // Throws ProjectNotFound.
      const { dir, config } = (await readEnclosingProject(cwd))!;
      const providerId = provider ?? config.transcription?.provider ?? "whisper-cpp";
      const overrides = { dir, binaries: config.binaries };
      return transcribing(dir, () => transcribeAsset({
        projectDir: dir,
        asset: resolve(cwd, asset),
        providerId,
        provider: () => plugins.transcriptionProvider(dir, providerId),
        model: model ?? config.transcription?.model,
        language: language ?? config.transcription?.language,
        tools: {
          ensureBinary: (name, onProgress) => binaries.ensure(name, overrides, { onProgress }),
          ensureModel: (id, onProgress) => binaries.ensureModel(id, { onProgress }),
        },
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
        tools: {
          ensureBinary: (name, onProgress) => binaries.ensure(name, overrides, { onProgress }),
          ensureModel: (id, onProgress) => binaries.ensureModel(id, { onProgress }),
        },
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
        language: language ?? config.transcription?.language,
        tools: {
          ensureBinary: (name, onProgress) => binaries.ensure(name, overrides, { onProgress }),
          ensureModel: (id, onProgress) => binaries.ensureModel(id, { onProgress }),
        },
        assetHash: async (rel) => (await media.derivedAudio(dir, rel)).hash,
        extractAudio: options.extractAudio,
        progress: request.progress,
      }));
    },
    "file.write": ({ path, content }, caller) => projects.writeFile(path, content, journalAuthorOf(caller)),
    "asset.import": async ({ cwd, files, mode }) => media.import(await root(cwd), files, mode),
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
      const removed = [...derived.removed, ...cache.removed, ...proposals].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
      const skipped = [...derived.skipped, ...cache.skipped];
      if (!temps) skipped.push({ area: "temp", reason: "jobs of this project are running; temp files may be theirs." });
      const bytes = removed.reduce((sum, entry) => sum + entry.bytes, 0);
      return { dir, dryRun, removed, bytes, forgotten: derived.forgotten, skipped };
    },
    "clip.renders": async ({ cwd, timeline }) => clips.status(clipRoot(await root(cwd)), timeline),
    "clip.live": async ({ cwd, timeline, clip }) => clips.live(clipRoot(await root(cwd)), timeline, clip),
    "context.write": async ({ cwd, name, content }) => writeContext(await root(cwd), name, content),
    "inspect.point": async ({ cwd, timeline, at, x, y, unit, segment, view }, caller, request) => {
      const dir = await root(cwd);
      const shown = await timelines.viewTimeline(dir, timeline, await viewOf(dir, caller, view));
      const loaded = { timeline: await resolveNested(dir, shown.timeline), fps: shown.fps };
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
    "timeline.show": async ({ cwd, timeline, view }, caller) => {
      const dir = await root(cwd);
      return timelines.show(dir, timeline, await viewOf(dir, caller, view));
    },
    "track.list": async ({ cwd, timeline, view }, caller) => {
      const dir = await root(cwd);
      return timelines.tracks(dir, timeline, await viewOf(dir, caller, view));
    },
    "track.add": (params, caller) => operate("track.add", params, caller),
    "track.remove": (params, caller) => operate("track.remove", params, caller),
    "track.set": (params, caller) => operate("track.set", params, caller),
    "clip.add": (params, caller) => operate("clip.add", params, caller),
    "clip.move": (params, caller) => operate("clip.move", params, caller),
    "clip.trim": (params, caller) => operate("clip.trim", params, caller),
    "clip.split": (params, caller) => operate("clip.split", params, caller),
    "clip.remove": (params, caller) => operate("clip.remove", params, caller),
    "clip.set": (params, caller) => operate("clip.set", params, caller),
    "transition.set": (params, caller) => operate("transition.set", params, caller),
    "transition.remove": (params, caller) => operate("transition.remove", params, caller),
    "clip.key": (params, caller) => operate("clip.key", params, caller),
    cut: (params, caller) => operate("cut", params, caller),
    "multicam.create": async ({ cwd, timeline, assets, names, mics, micNames, soundOf, name }, caller) => {
      const dir = await root(cwd);
      const measured = await measureAngles({ probe: (d, a) => media.probe(d, a), profile: (d, a) => energy.profile(d, a) }, {
        root: dir,
        cwd,
        assets,
        names,
        mics,
        micNames,
        soundOf,
      });
      const angles = measured.assets.map((asset, i) => ({
        asset,
        ...(names ? { name: names[i]! } : {}),
        offset: measured.plan[i]!.offset,
        ...(measured.soundOf[i] !== undefined ? { mic: measured.soundOf[i]! } : {}),
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
    },
    "multicam.gallery": async ({ cwd, timeline, asset, names, name, at }, caller) => {
      const dir = await root(cwd);
      const plan = await planGallery(gallery, { root: dir, cwd, asset, names, at });
      let written: Timeline | undefined;
      const result = await operate("multicam.gallery", { cwd, timeline, asset: plan.asset, tiles: plan.tiles, ...(name ? { name } : {}) }, caller, (after) => {
        written = after;
      });
      const group = written?.groups?.find((candidate) => result.changes.added.includes(candidate.id));
      const track = written?.tracks.find((candidate) => candidate.kind === "program" && candidate.group === group?.id);
      if (!group || !track || track.kind !== "program") throw new Error("multicam.gallery: the operation wrote no new group");
      const report = galleryReport(group, plan);
      return {
        ...result,
        group: group.id,
        track: track.id,
        clip: track.clips[0]!.id,
        mic: group.mics?.[0]?.id ?? null,
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
    "multicam.turns": async ({ cwd, timeline, group }, caller) => {
      const dir = await root(cwd);
      const { timeline: loaded } = await loadFor(dir, timeline, caller);
      const found = groupOf(loaded, group, "multicam.turns");
      const result = await groupTurns(turnsSource, dir, found);
      return { timeline, revision: loaded.revision, group, ...result };
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
      // A proposal still building holds what the file never got (ADR 0019 §3).
      await timelines.abortProposal(tx.id);
      // All or nothing; a conflict leaves the transaction open to resolve, or to commit instead.
      const reverted = await timelines.revertAll({ author: journalAuthorOf(caller), tx, target: tx.id, timelines: touched });
      await transactions.end(author);
      return { tx: tx.id, label: tx.label, author, reverted };
    },
    history: async ({ cwd, timeline, since }) => timelines.history(await root(cwd), timeline, { since }),
    "history.diff": async ({ cwd, timeline, target }) => timelines.diff(await root(cwd), timeline, target),
    revert: async ({ cwd, timeline, target }, caller) => revert(await root(cwd), cwd, timeline, target, caller),
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
    "ui.state": async ({ cwd }) => ui.state(await projectKey(cwd)),
    "ui.seek": async ({ cwd, at }) => ui.command(await projectKey(cwd), { kind: "seek", at }),
    "ui.play": async ({ cwd }) => ui.command(await projectKey(cwd), { kind: "play" }),
    "ui.pause": async ({ cwd }) => ui.command(await projectKey(cwd), { kind: "pause" }),
    "ui.select": async ({ cwd, clips, words, range, reveal, points }) => {
      // Points are inspected here, so the app shows exactly what `inspect.point` reports.
      const dir = points.length > 0 ? await root(cwd) : null;
      const inspected = [];
      for (const point of points) {
        const { timeline: _timeline, frame: _frame, pixel: _pixel, ...picked } = await inspector.point(dir!, { timeline: "main", ...point });
        inspected.push(picked);
      }
      return ui.command(await projectKey(cwd), { kind: "select", clips, words, range, reveal, points: inspected });
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
