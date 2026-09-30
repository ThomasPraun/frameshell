import { createRequire } from "node:module";
import { type Server, type Socket, createServer } from "node:net";
import { resolve } from "node:path";
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
  RpcError,
  type ValidatedParams,
  type AppDirs,
  assertSocketPathFits,
  isMethodName,
  parseRequest,
  readMessages,
  resolveAppDirs,
  writeMessage,
} from "@frameshell/protocol";
import { runDoctor } from "./binaries/doctor.js";
import { ExportService } from "./export/service.js";
import { EventHub, type EventSink } from "./events.js";
import { canonicalPath, canonicalPathSync } from "./fs-util.js";
import { BinaryManager } from "./binaries/manager.js";
import { JobQueue } from "./jobs/queue.js";
import { listenCleaningStaleSocket } from "./listen.js";
import { EnergyStore } from "./media/energy-store.js";
import { MediaService } from "./media/service.js";
import { PluginHost } from "./plugins/host.js";
import { ProjectRegistry, readEnclosingProject } from "./projects.js";
import { FileTransactionStore, TransactionTracker } from "./history/transactions.js";
import { IdempotencyCache } from "./idempotency.js";
import { outlineScript } from "./scripts/outline.js";
import type { OperationRequest } from "./timeline/engine.js";
import { TimelineService } from "./timeline/service.js";
import { TimelineWatcher } from "./timeline/watcher.js";
import { energySnapper } from "./timeline/snap.js";
import type { AudioExtractor } from "./transcripts/audio.js";
import { transcribeAsset } from "./transcripts/transcriber.js";
import { verifyExport } from "./transcripts/verify.js";

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
  /** Video segments a render encodes at once. Default: half the cores, 1 to 4. */
  renderParallelism?: number;
  /** Render video segment length in seconds. Default 10. */
  renderSegmentSeconds?: number;
  /**
   * Operations from one terminal session join one transaction until this long
   * passes without one (SPEC §6.2). Default {@link DEFAULT_TX_IDLE_GAP_MS}.
   */
  txIdleGapMs?: number;
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
  const media = new MediaService({
    binaries,
    jobs,
    onAssetChanged: (root, path, asset) => publishFor("asset.changed", root, { project: root, path, asset }),
  });
  const timelineWatcher = new TimelineWatcher({ onChange: (dir, id): Promise<void> => timelines.reconcile(dir, id) });
  const projects = new ProjectRegistry({
    onOpen: (dir) => {
      media.attach(dir);
      timelineWatcher.attach(dir);
    },
    writeTimeline: async (dir, id, content, author = "file") => {
      // The saver's transaction, like any operation of theirs (SPEC §6.2).
      const tx = transactions.next(author);
      await transactions.touching(author, tx, { root: dir, timeline: id });
      if (await timelines.writeFile(dir, id, content, { author, tx })) await transactions.applied(author, tx);
    },
  });
  const plugins = new PluginHost({ dirs, pins: projects });
  const energy = new EnergyStore({
    derivedAudio: (dir, rel) => media.derivedAudio(dir, rel),
    ffmpeg: async (dir) => {
      const project = await readEnclosingProject(dir);
      return binaries.ensure("ffmpeg", project ? { dir: project.dir, binaries: project.config.binaries } : undefined);
    },
    extractAudio: options.extractAudio,
  });
  const transactions = new TransactionTracker({
    idleGapMs: options.txIdleGapMs,
    store: new FileTransactionStore(dirs.dataDir, socketPath),
  });
  await transactions.restore();
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
    onChanged: ({ root, timeline, revision, author, changes }) =>
      events.publish("timeline.changed", root, { project: root, timeline, revision, author, changes }),
    onRejected: ({ root, ...rejection }) => events.publish("timeline.rejected", root, { project: root, ...rejection }),
    fileTx: () => transactions.next("file"),
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
    ...(options.renderParallelism !== undefined ? { parallelism: options.renderParallelism } : {}),
    ...(options.renderSegmentSeconds !== undefined ? { segmentSeconds: options.renderSegmentSeconds } : {}),
  });
  /** Run one timeline operation for `caller` in its transaction; params minus `cwd`/`timeline` are the op's args. */
  const operate = async (op: OperationRequest["op"], params: { cwd: string; timeline: string }, caller: Caller) => {
    const { cwd, timeline, ...args } = params;
    const request = { op, args } as OperationRequest;
    const dir = await root(cwd);
    const author = authorOf(caller);
    const tx = transactions.next(author);
    await transactions.touching(author, tx, { root: dir, timeline });
    const result = await timelines.apply({ root: dir, cwd, timeline, request, author, tx });
    await transactions.applied(author, tx);
    return result;
  };
  /** Revert `target` on one timeline; its own transaction unless an explicit one is open. */
  const revert = async (dir: string, cwd: string, timeline: string, target: string, author: string, standalone: boolean) => {
    const tx = transactions.next(author, { standalone });
    await transactions.touching(author, tx, { root: dir, timeline });
    const result = await timelines.revert({ root: dir, cwd, timeline, author, tx, target });
    await transactions.applied(author, tx);
    return result;
  };
  const root = async (cwd: string) => (await projects.requireEnclosing(cwd)).dir;
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
  const identity: HandshakeResult = { protocolVersion: PROTOCOL_VERSION, daemonVersion: DAEMON_VERSION, pid: process.pid };

  let idleTimer: NodeJS.Timeout | undefined;
  let closing: Promise<void> | undefined;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => (resolveClosed = resolve));

  const handlers: Handlers = {
    handshake: async ({ client, session }, caller) => {
      caller.client = client;
      caller.session = session ?? null;
      return identity;
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
        openProjects: projects.list(),
        rejections: project ? await timelines.rejections(project.dir) : [],
        jobs: project ? jobs.list({ project: project.dir }) : [],
        transactions: project ? await openTransactions(project.dir) : [],
        caller: { ...caller },
      };
    },
    "project.init": (params) => projects.init(params.dir, params.name),
    doctor: async ({ cwd, install }) => {
      const found = await readEnclosingProject(cwd);
      const project = found ? { dir: found.dir, binaries: found.config.binaries } : undefined;
      return runDoctor(binaries, { project, install });
    },
    "project.trust": async ({ cwd, decision }) => plugins.setTrust(await root(cwd), decision),
    "plugin.list": async ({ cwd }) => plugins.list(await root(cwd)),
    "plugin.install": async ({ cwd, spec }) => plugins.install(await root(cwd), spec),
    "plugin.remove": async ({ cwd, name }) => plugins.remove(await root(cwd), name),
    "plugin.run": async ({ cwd, plugin, command, args }) => plugins.run(await root(cwd), cwd, plugin, command, args),
    "export.presets": async ({ cwd }) => ({ presets: await exports.presets(await root(cwd)) }),
    render: async ({ cwd, timeline, preset, out }) => exports.render(await root(cwd), { timeline, preset, out }),
    frame: async ({ cwd, timeline, at, out, preset }) => exports.frame(await root(cwd), { timeline, at, out, preset }),
    transcribe: async ({ cwd, asset, provider, model, language }, _caller, request) => {
      await projects.requireEnclosing(cwd); // Throws ProjectNotFound.
      const { dir, config } = (await readEnclosingProject(cwd))!;
      const providerId = provider ?? config.transcription?.provider ?? "whisper-cpp";
      const overrides = { dir, binaries: config.binaries };
      return transcribeAsset({
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
      });
    },
    "transcribe.verify": async ({ cwd, export: file, timeline, provider, model, language }, _caller, request) => {
      await projects.requireEnclosing(cwd); // Throws ProjectNotFound.
      const { dir, config } = (await readEnclosingProject(cwd))!;
      const providerId = provider ?? config.transcription?.provider ?? "whisper-cpp";
      const overrides = { dir, binaries: config.binaries };
      return verifyExport({
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
      });
    },
    "file.write": ({ path, content }, caller) => projects.writeFile(path, content, authorOf(caller)),
    "asset.import": async ({ cwd, files, mode }) => media.import(await root(cwd), files, mode),
    "asset.list": async ({ cwd }) => {
      const dir = await root(cwd);
      return { dir, assets: await media.list(dir) };
    },
    "job.list": async ({ cwd, active }) => {
      const dir = await root(cwd);
      return { dir, jobs: jobs.list({ project: dir, active }) };
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
    "timeline.show": async ({ cwd, timeline }) => timelines.show(await root(cwd), timeline),
    "track.list": async ({ cwd, timeline }) => timelines.tracks(await root(cwd), timeline),
    "track.add": (params, caller) => operate("track.add", params, caller),
    "track.remove": (params, caller) => operate("track.remove", params, caller),
    "clip.add": (params, caller) => operate("clip.add", params, caller),
    "clip.move": (params, caller) => operate("clip.move", params, caller),
    "clip.trim": (params, caller) => operate("clip.trim", params, caller),
    "clip.split": (params, caller) => operate("clip.split", params, caller),
    "clip.remove": (params, caller) => operate("clip.remove", params, caller),
    "clip.set": (params, caller) => operate("clip.set", params, caller),
    cut: (params, caller) => operate("cut", params, caller),
    "tx.begin": async ({ label, autoCommitAfter }, caller) => {
      const author = authorOf(caller);
      const autoCommitMs = autoCommitAfter === undefined ? undefined : autoCommitAfter * 1000;
      const tx = await transactions.begin(author, label, { autoCommitMs });
      return { tx: tx.id, label, author };
    },
    "tx.commit": async (_params, caller) => {
      const author = authorOf(caller);
      const { tx, operations } = await transactions.end(author);
      return { tx: tx.id, label: tx.label, author, operations };
    },
    "tx.abort": async (_params, caller) => {
      const author = authorOf(caller);
      const { tx, touched } = transactions.peek(author);
      // All or nothing; a conflict leaves the transaction open to resolve, or to commit instead.
      const reverted = await timelines.revertAll({ author, tx, target: tx.id, timelines: touched });
      await transactions.end(author);
      return { tx: tx.id, label: tx.label, author, reverted };
    },
    history: async ({ cwd, timeline, since }) => timelines.history(await root(cwd), timeline, { since }),
    revert: async ({ cwd, timeline, target }, caller) => revert(await root(cwd), cwd, timeline, target, authorOf(caller), true),
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
    if (clients.size > 0 || jobs.busy || closing || !Number.isFinite(idleTimeoutMs)) return;
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
      await timelineWatcher.close();
      await jobs.close();
    })().then(resolveClosed);
    return closing;
  }

  await listenCleaningStaleSocket(server, socketPath);
  armIdleTimer();
  return { socketPath, closed, close };
}

/** SPEC §6.2 author of a connection's operations: the app is `ui`, a Frameshell terminal `cli:<session>`. */
function authorOf(caller: Caller): string {
  if (caller.client.startsWith("desktop/")) return "ui";
  return caller.session ? `cli:${caller.session}` : "cli";
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
