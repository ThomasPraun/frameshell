/**
 * Wire protocol version. Client and daemon must match exactly; bump on any
 * breaking change to a method, param, result or error code.
 */
export const PROTOCOL_VERSION = 1;

/** First request on every connection. Other methods fail until it succeeds. */
export interface HandshakeParams {
  protocolVersion: number;
  /** Free-form client id for logs and history attribution, e.g. `cli/0.1.0`. */
  client: string;
}

/** Daemon identity returned by a successful handshake. */
export interface HandshakeResult {
  protocolVersion: number;
  daemonVersion: string;
  pid: number;
}

/** `project.init`: scaffold a project (SPEC §5.1). Fails if `frameshell.json` already exists. */
export interface ProjectInitParams {
  /** Absolute project directory; created if missing. */
  dir: string;
  /** Display name; defaults to the directory name. */
  name?: string;
}

/** Summary of an open project. */
export interface ProjectSummary {
  /** Absolute directory holding `frameshell.json`. */
  dir: string;
  name: string;
  schemaVersion: number;
}

/** Result of `project.init`. */
export interface ProjectInitResult {
  project: ProjectSummary;
  /** Project-relative paths created, `/`-separated, directories end with `/`. */
  created: string[];
}

/** `status`: daemon state plus the project enclosing `cwd`, if any. */
export interface StatusParams {
  /** Absolute directory to resolve the project from; searched upwards. */
  cwd: string;
}

/** Result of `status`. */
export interface StatusResult {
  daemon: HandshakeResult & {
    uptimeMs: number;
    /** Connected clients, including the caller. */
    clients: number;
    socketPath: string;
  };
  /** Project enclosing `cwd`, opened by the daemon; `null` when none. */
  project: ProjectSummary | null;
  /** Every project the daemon holds open. */
  openProjects: ProjectSummary[];
}

/** Method name to params and result. Single source for client and daemon typing. */
export interface Methods {
  handshake: { params: HandshakeParams; result: HandshakeResult };
  status: { params: StatusParams; result: StatusResult };
  "project.init": { params: ProjectInitParams; result: ProjectInitResult };
}

/** Any method name the daemon serves. */
export type MethodName = keyof Methods;

/**
 * JSON-RPC error codes. -32768..-32000 reserved by JSON-RPC 2.0; app codes
 * use -32001 downwards. `data` shape noted per code.
 */
export const ErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  /** data: `{ clientProtocolVersion, daemonProtocolVersion, daemonVersion }` */
  IncompatibleProtocol: -32001,
  HandshakeRequired: -32002,
  /** data: `{ path }` of the existing `frameshell.json` */
  ProjectExists: -32003,
  /** data: `{ path, details }` */
  InvalidProjectFile: -32004,
} as const;

/** Error raised by the client when the daemon answers with a JSON-RPC error. */
export class RpcError extends Error {
  override readonly name = "RpcError";

  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}
