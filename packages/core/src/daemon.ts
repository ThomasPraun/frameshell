import { createRequire } from "node:module";
import { type Server, type Socket, createServer } from "node:net";
import {
  ErrorCode,
  type HandshakeResult,
  type JsonRpcRequest,
  type MethodName,
  type MethodResult,
  PROTOCOL_VERSION,
  RpcError,
  type ValidatedParams,
  assertSocketPathFits,
  isMethodName,
  parseParams,
  readMessages,
  writeMessage,
} from "@frameshell/protocol";
import { listenCleaningStaleSocket } from "./listen.js";
import { ProjectRegistry } from "./projects.js";

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
   * Exit after this long with no connected clients. Counted from start and
   * from each last disconnect. `Infinity` disables.
   */
  idleTimeoutMs?: number;
}

/** Running daemon handle. */
export interface Daemon {
  readonly socketPath: string;
  /** Resolves once the daemon has stopped, by idle timeout or {@link Daemon.close}. */
  readonly closed: Promise<void>;
  /** Stop listening, drop clients, release the socket. Idempotent. */
  close(): Promise<void>;
}

/** One handler per registry method; params arrive already validated. */
type Handlers = { [M in MethodName]: (params: ValidatedParams<M>) => Promise<MethodResult<M>> };

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
  const projects = new ProjectRegistry();
  const identity: HandshakeResult = { protocolVersion: PROTOCOL_VERSION, daemonVersion: DAEMON_VERSION, pid: process.pid };

  let idleTimer: NodeJS.Timeout | undefined;
  let closing: Promise<void> | undefined;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => (resolveClosed = resolve));

  const handlers: Handlers = {
    handshake: async () => identity,
    status: async ({ cwd }) => {
      const project = await projects.openEnclosing(cwd);
      return {
        daemon: { ...identity, uptimeMs: Date.now() - startedAt, clients: clients.size, socketPath },
        project,
        openProjects: projects.list(),
      };
    },
    "project.init": (params) => projects.init(params.dir, params.name),
  };

  const server: Server = createServer((socket) => {
    clients.add(socket);
    armIdleTimer();
    let handshaken = false;
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
        const result = await (handlers[method] as (p: typeof params) => Promise<unknown>)(params);
        if (method === "handshake") handshaken = true;
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
    if (clients.size > 0 || !Number.isFinite(idleTimeoutMs)) return;
    idleTimer = setTimeout(() => void close(), idleTimeoutMs);
    idleTimer.unref?.();
  }

  function close(): Promise<void> {
    closing ??= new Promise<void>((resolve) => {
      clearTimeout(idleTimer);
      for (const socket of clients) socket.destroy();
      server.close(() => resolve());
    }).then(resolveClosed);
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
