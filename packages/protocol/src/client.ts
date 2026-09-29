import { createConnection, type Socket } from "node:net";
import { type JsonRpcResponse, readMessages, writeMessage } from "./framing.js";
import {
  type HandshakeResult,
  type MethodName,
  type MethodParams,
  type MethodResult,
  PROTOCOL_VERSION,
  RpcError,
} from "./methods.js";
import { assertSocketPathFits } from "./socket-path.js";

/** Options for {@link connectToDaemon}. */
export interface ConnectOptions {
  /** Client id sent in the handshake, e.g. `cli/0.1.0`. */
  client: string;
  /** Terminal session to attribute this connection's operations to, from `FRAMESHELL_SESSION`. Empty or absent = none. */
  session?: string | undefined;
  /** Override only to test version negotiation. Defaults to {@link PROTOCOL_VERSION}. */
  protocolVersion?: number;
}

/** Open, handshaken connection to frameshelld. */
export interface DaemonConnection {
  /** Identity the daemon reported during the handshake. */
  readonly daemon: HandshakeResult;
  /** Typed JSON-RPC call. Rejects with {@link RpcError} on a daemon error. */
  request<M extends MethodName>(method: M, params: MethodParams<M>): Promise<MethodResult<M>>;
  /** End the connection. Pending requests reject. */
  close(): void;
}

/**
 * Connect and perform the protocol handshake.
 *
 * Rejects with the raw socket error when nobody listens (see
 * {@link isDaemonUnavailable}), with code `ENAMETOOLONG` or `ENOTSOCK` and an
 * actionable message when the endpoint path is unusable, or with {@link RpcError} code
 * `IncompatibleProtocol` when versions differ; the socket is closed in both cases.
 */
export async function connectToDaemon(socketPath: string, options: ConnectOptions): Promise<DaemonConnection> {
  const socket = await openSocket(socketPath);
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  let nextId = 1;

  const failAll = (error: Error) => {
    for (const { reject } of pending.values()) reject(error);
    pending.clear();
  };

  readMessages(socket, (message) => {
    const response = message as JsonRpcResponse;
    if (typeof response.id !== "number") return; // Notifications: no subscribers yet.
    const entry = pending.get(response.id);
    if (!entry) return;
    pending.delete(response.id);
    if (response.error) {
      entry.reject(new RpcError(response.error.code, response.error.message, response.error.data));
    } else {
      entry.resolve(response.result);
    }
  });
  socket.on("close", () => failAll(new Error("frameshelld closed the connection")));
  socket.on("error", (error) => failAll(error));

  const call = (method: string, params: unknown): Promise<unknown> =>
    new Promise((resolve, reject) => {
      if (socket.destroyed) {
        reject(new Error("connection to frameshelld is closed"));
        return;
      }
      const id = nextId++;
      pending.set(id, { resolve, reject });
      writeMessage(socket, { jsonrpc: "2.0", id, method, params });
    });

  let daemon: HandshakeResult;
  try {
    daemon = (await call("handshake", {
      protocolVersion: options.protocolVersion ?? PROTOCOL_VERSION,
      client: options.client,
      ...(options.session ? { session: options.session } : {}),
    })) as HandshakeResult;
  } catch (error) {
    socket.destroy();
    throw error;
  }

  return {
    daemon,
    request: (method, params) => call(method, params) as never,
    close: () => {
      socket.end();
    },
  };
}

/** True when the error means "no daemon listening": start one and retry. */
export function isDaemonUnavailable(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ECONNREFUSED";
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
