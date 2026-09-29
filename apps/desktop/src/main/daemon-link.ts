import { connectOrStartDaemon } from "@frameshell/cli";
import {
  type DaemonConnection,
  type MethodName,
  type MethodParams,
  type MethodResult,
  RpcError,
} from "@frameshell/protocol";

/** Options for {@link DaemonLink}. */
export interface DaemonLinkOptions {
  socketPath: string;
  /** Handshake client id, e.g. `desktop/0.1.0`. */
  client: string;
  /**
   * Environment for a daemon this link spawns. From Electron it must carry
   * `ELECTRON_RUN_AS_NODE=1`: the spawn reuses `process.execPath`, the Electron binary.
   */
  env: NodeJS.ProcessEnv;
}

/**
 * The app's long-lived daemon client. Connects lazily, auto-starting
 * frameshelld like the CLI does, and reconnects (starting a new daemon if
 * needed) when the connection drops. Daemon errors ({@link RpcError}) pass
 * through untouched; a transport failure is retried once on a fresh connection.
 */
export class DaemonLink {
  #connection: Promise<DaemonConnection> | undefined;

  constructor(private readonly options: DaemonLinkOptions) {}

  /** Typed request; see the method registry in `@frameshell/protocol`. */
  async request<M extends MethodName>(method: M, params: MethodParams<M>): Promise<MethodResult<M>> {
    try {
      return await (await this.#connect()).request(method, params);
    } catch (error) {
      if (error instanceof RpcError) throw error;
      this.#drop();
      return (await this.#connect()).request(method, params);
    }
  }

  /** Close the connection. The daemon keeps running until its idle timeout. */
  async close(): Promise<void> {
    const connection = this.#connection;
    this.#connection = undefined;
    if (connection) (await connection.catch(() => undefined))?.close();
  }

  #connect(): Promise<DaemonConnection> {
    this.#connection ??= connectOrStartDaemon(this.options);
    // A failed connect must not be cached: the next request tries again.
    this.#connection.catch(() => this.#drop());
    return this.#connection;
  }

  #drop(): void {
    const connection = this.#connection;
    this.#connection = undefined;
    void connection?.then((conn) => conn.close()).catch(() => undefined);
  }
}
