import { createRequire } from "node:module";
import { type Server, type Socket, createServer } from "node:net";
import { resolve } from "node:path";
import {
  ErrorCode,
  type HandshakeResult,
  type JsonRpcRequest,
  type MethodName,
  type MethodResult,
  PROTOCOL_VERSION,
  type Progress,
  RpcError,
  type ValidatedParams,
  type AppDirs,
  assertSocketPathFits,
  isMethodName,
  parseParams,
  readMessages,
  resolveAppDirs,
  writeMessage,
} from "@frameshell/protocol";
import { runDoctor } from "./binaries/doctor.js";
import { BinaryManager } from "./binaries/manager.js";
import { JobQueue } from "./jobs/queue.js";
import { listenCleaningStaleSocket } from "./listen.js";
import { MediaService } from "./media/service.js";
import { PluginHost } from "./plugins/host.js";
import { ProjectRegistry, readEnclosingProject } from "./projects.js";
import type { AudioExtractor } from "./transcripts/audio.js";
import { transcribeAsset } from "./transcripts/transcriber.js";

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
  /** Audio extraction for `transcribe`. Defaults to ffmpeg from {@link DaemonOptions.binaries}. */
  extractAudio?: AudioExtractor;
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
  const jobs = new JobQueue({ concurrency: options.jobConcurrency ?? 2, onBusyChange: () => armIdleTimer() });
  const media = new MediaService({ binaries, jobs });
  const projects = new ProjectRegistry({ onOpen: (dir) => media.attach(dir) });
  const plugins = new PluginHost({ dirs, pins: projects });
  const root = async (cwd: string) => (await projects.requireEnclosing(cwd)).dir;
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
        jobs: project ? jobs.list({ project: project.dir }) : [],
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
    "export.presets": async ({ cwd }) => plugins.presets(await root(cwd)),
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
    "file.write": ({ path, content }) => projects.writeFile(path, content),
    "asset.import": async ({ cwd, files, mode }) => media.import(await root(cwd), files, mode),
    "asset.list": async ({ cwd }) => {
      const dir = await root(cwd);
      return { dir, assets: await media.list(dir) };
    },
    "job.list": async ({ cwd, active }) => {
      const dir = await root(cwd);
      return { dir, jobs: jobs.list({ project: dir, active }) };
    },
  };

  const server: Server = createServer((socket) => {
    clients.add(socket);
    armIdleTimer();
    let handshaken = false;
    const caller: Caller = { client: "", session: null };
    socket.on("error", () => socket.destroy());
    socket.on("close", () => {
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
        const params = parseParams(method, request.params);
        // Set before the await: a request pipelined behind the handshake is dispatched
        // while the handshake handler is still pending. Invalid params never get here.
        if (method === "handshake") handshaken = true;
        const context: RequestContext = {
          progress: (update) => {
            if (request.id !== undefined) writeMessage(socket, { jsonrpc: "2.0", method: "progress", params: { requestId: request.id, ...update } });
          },
        };
        const handler = handlers[method] as (p: typeof params, c: Caller, r: RequestContext) => Promise<unknown>;
        const result = await handler(params, caller, context);
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
      await new Promise<void>((resolve) => {
        for (const socket of clients) socket.destroy();
        server.close(() => resolve());
      });
      // Canceled jobs are found again from disk when the project next opens.
      await media.close();
      await jobs.close();
    })().then(resolveClosed);
    return closing;
  }

  await listenCleaningStaleSocket(server, socketPath);
  armIdleTimer();
  return { socketPath, closed, close };
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
