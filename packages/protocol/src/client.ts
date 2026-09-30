import { createConnection, type Socket } from "node:net";
import { type JsonRpcResponse, readMessages, writeMessage } from "./framing.js";
import {
  type EventParams,
  type NotificationName,
  type HandshakeResult,
  type MethodName,
  type MethodParams,
  type MethodResult,
  PROTOCOL_VERSION,
  type Progress,
  RpcError,
  notifications,
} from "./methods.js";
import { assertSocketPathFits } from "./socket-path.js";

/** Options for {@link connectToDaemon}. */
export interface ConnectOptions {
  /** Client id sent in the handshake, e.g. `cli/0.1.0`. */
  client: string;
  /** Terminal session to attribute this connection's operations to, from `FRAMESHELL_SESSION`. Empty or absent = none. */
  session?: string | undefined;
  /**
   * Agent label to journal this connection's operations under (`FRAMESHELL_AGENT`);
   * null = not an agent, overriding the app's detection; absent = whatever the app detected.
   */
  agent?: string | null | undefined;
  /** Override only to test version negotiation. Defaults to {@link PROTOCOL_VERSION}. */
  protocolVersion?: number;
}

/** Per-call options of {@link DaemonConnection.request}. */
export interface RequestOptions {
  onProgress?: ((progress: Progress) => void) | undefined;
  /**
   * Sent as `params.idempotencyKey` (see `IdempotencyKeySchema`): only
   * mutating methods accept it. Reuse it when retrying the same change.
   */
  idempotencyKey?: string | undefined;
}

/** Open, handshaken connection to frameshelld. */
export interface DaemonConnection {
  /** Identity the daemon reported during the handshake. */
  readonly daemon: HandshakeResult;
  /**
   * Typed JSON-RPC call. Rejects with {@link RpcError} on a daemon error.
   * `onProgress` receives the daemon's `progress` notifications for this call.
   */
  request<M extends MethodName>(method: M, params: MethodParams<M>, options?: RequestOptions): Promise<MethodResult<M>>;
  /**
   * Listen to notification `event` on this connection. Events arrive only
   * after `events.subscribe`; `ui.command` only after `ui.publish`. Payloads
   * failing the registry schema are dropped. `progress` goes to the request's
   * `onProgress` instead. Returns the function that removes the listener.
   */
  on<E extends Exclude<NotificationName, "progress">>(event: E, listener: (params: EventParams<E>) => void): () => void;
  /** Resolves once the connection is closed, by either side. Never rejects. */
  readonly closed: Promise<void>;
  /** End the connection. Pending requests reject. */
  close(): void;
}

/**
 * Connect and perform the protocol handshake.
 *
 * Rejects with the raw socket error when nobody listens, or with code
 * `ECONNRESET` when the daemon drops the connection before answering the
 * handshake (it was shutting down); both satisfy {@link isDaemonUnavailable}.
 * Rejects with code `ENAMETOOLONG` or `ENOTSOCK` and an
 * actionable message when the endpoint path is unusable, or with {@link RpcError} code
 * `IncompatibleProtocol` when versions differ; the socket is closed in both cases.
 */
export async function connectToDaemon(socketPath: string, options: ConnectOptions): Promise<DaemonConnection> {
  const socket = await openSocket(socketPath);
  const pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void; onProgress?: ((progress: Progress) => void) | undefined }
  >();
  let nextId = 1;
  const listeners = new Map<string, Set<(params: never) => void>>();
  let markClosed!: () => void;
  const closed = new Promise<void>((resolve) => (markClosed = resolve));

  const failAll = (error: Error) => {
    for (const { reject } of pending.values()) reject(error);
    pending.clear();
  };

  readMessages(socket, (message) => {
    const note = message as { method?: unknown; params?: { requestId?: unknown; message?: unknown; fraction?: unknown } };
    if (note.method === "progress") {
      const { requestId, message: text, fraction } = note.params ?? {};
      const listener = typeof requestId === "number" ? pending.get(requestId)?.onProgress : undefined;
      if (listener && typeof text === "string") {
        listener(typeof fraction === "number" ? { message: text, fraction } : { message: text });
      }
      return;
    }
    if (typeof note.method === "string") {
      dispatchEvent(note.method, note.params);
      return;
    }
    const response = message as JsonRpcResponse;
    if (typeof response.id !== "number") return;
    const entry = pending.get(response.id);
    if (!entry) return;
    pending.delete(response.id);
    if (response.error) {
      entry.reject(new RpcError(response.error.code, response.error.message, response.error.data));
    } else {
      entry.resolve(response.result);
    }
  });
  const dispatchEvent = (method: string, params: unknown) => {
    const subscribers = listeners.get(method);
    if (!subscribers || subscribers.size === 0 || !Object.hasOwn(notifications, method)) return;
    const parsed = notifications[method as NotificationName].params.safeParse(params);
    if (!parsed.success) return;
    for (const listener of [...subscribers]) listener(parsed.data as never);
  };

  socket.on("close", () => {
    failAll(new Error("frameshelld closed the connection"));
    markClosed();
  });
  socket.on("error", (error) => failAll(error));

  const call = (method: string, params: unknown, onProgress?: (progress: Progress) => void): Promise<unknown> =>
    new Promise((resolve, reject) => {
      if (socket.destroyed) {
        reject(new Error("connection to frameshelld is closed"));
        return;
      }
      const id = nextId++;
      pending.set(id, { resolve, reject, onProgress });
      writeMessage(socket, { jsonrpc: "2.0", id, method, params });
    });

  let daemon: HandshakeResult;
  try {
    daemon = (await call("handshake", {
      protocolVersion: options.protocolVersion ?? PROTOCOL_VERSION,
      client: options.client,
      ...(options.session ? { session: options.session } : {}),
      ...(options.agent !== undefined ? { agent: options.agent } : {}),
    })) as HandshakeResult;
  } catch (error) {
    socket.destroy();
    if (error instanceof RpcError) throw error;
    // Accepted, then dropped unanswered: a daemon stopping on its idle timeout resets connections still in
    // its backlog. Same remedy as nobody listening: start a daemon and retry. Handshake is idempotent.
    throw Object.assign(new Error("frameshelld closed the connection during the handshake", { cause: error }), {
      code: "ECONNRESET",
    });
  }

  return {
    daemon,
    request: (method, params, options) => {
      const key = options?.idempotencyKey;
      return call(method, key === undefined ? params : { ...params, idempotencyKey: key }, options?.onProgress) as never;
    },
    on: (event, listener) => {
      let subscribers = listeners.get(event);
      if (!subscribers) listeners.set(event, (subscribers = new Set()));
      const entry = listener as (params: never) => void;
      subscribers.add(entry);
      return () => void subscribers.delete(entry);
    },
    closed,
    close: () => {
      socket.end();
    },
  };
}

/** True when a {@link connectToDaemon} error means "no daemon serving": start one and retry. */
export function isDaemonUnavailable(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ECONNREFUSED" || code === "ECONNRESET";
}

function openSocket(socketPath: string): Promise<Socket> {
  assertSocketPathFits(socketPath);
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    const onError = (error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOTSOCK") return reject(error);
      reject(
        Object.assign(
          new Error(`${socketPath} exists and is not a socket. Remove it or set FRAMESHELL_SOCKET to another path.`, {
            cause: error,
          }),
          { code: "ENOTSOCK" },
        ),
      );
    };
    socket.once("connect", () => {
      socket.off("error", onError);
      resolve(socket);
    });
    socket.once("error", onError);
  });
}
