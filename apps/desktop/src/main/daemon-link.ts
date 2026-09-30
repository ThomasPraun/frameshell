import { randomUUID } from "node:crypto";
import { connectOrStartDaemon } from "@frameshell/cli";
import {
  type DaemonConnection,
  EVENT_NAMES,
  type EventName,
  type EventParams,
  type MethodName,
  type MethodParams,
  type MethodResult,
  type MethodSpec,
  RpcError,
  methods,
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

/** Callbacks of one {@link DaemonLink.subscribe} call. */
export interface EventHandlers<E extends EventName> {
  /** One event of the subscribed project. */
  onEvent(params: EventParams<E>): void;
  /**
   * The connection was lost and re-established: events in between were
   * missed, so re-read whatever state the events track.
   */
  onResync?(): void;
}

/** Handle of a live {@link DaemonLink.subscribe}. */
export interface LinkSubscription {
  /** Project root the subscription is scoped to. */
  readonly dir: string;
  /** Stop delivering. Idempotent. */
  unsubscribe(): Promise<void>;
}

interface Subscriber {
  event: EventName;
  cwd: string;
  dir: string;
  handlers: EventHandlers<EventName>;
}

/** First reconnect delay; doubles per failed attempt up to {@link MAX_RETRY_MS}. */
const FIRST_RETRY_MS = 50;
const MAX_RETRY_MS = 2_000;

/**
 * The app's long-lived daemon client. Connects lazily, auto-starting
 * frameshelld like the CLI does, and reconnects (starting a new daemon if
 * needed) when the connection drops. Daemon errors ({@link RpcError}) pass
 * through untouched; a transport failure is retried once on a fresh connection.
 *
 * Event subscriptions survive reconnects: while any exists, a lost
 * connection is re-established at once, every subscription is renewed and
 * `onResync` tells listeners they may have missed events.
 */
export class DaemonLink {
  #connection: Promise<DaemonConnection> | undefined;
  readonly #subscribers = new Set<Subscriber>();
  #closed = false;
  #retryTimer: NodeJS.Timeout | undefined;

  constructor(private readonly options: DaemonLinkOptions) {}

  /**
   * Typed request; see the method registry in `@frameshell/protocol`. A
   * mutating method carries a fresh idempotency key, the same on the retry:
   * when the first attempt was applied but its reply lost, the daemon answers
   * the retry with that result instead of applying the change twice.
   */
  async request<M extends MethodName>(method: M, params: MethodParams<M>): Promise<MethodResult<M>> {
    const spec: MethodSpec = methods[method];
    const options = spec.mutating ? { idempotencyKey: randomUUID() } : {};
    try {
      return await (await this.#connect()).request(method, params, options);
    } catch (error) {
      if (error instanceof RpcError) throw error;
      this.#drop();
      return (await this.#connect()).request(method, params, options);
    }
  }

  /**
   * Deliver `event` of the project enclosing `cwd` to `handlers` until
   * unsubscribed. Rejects like {@link DaemonLink.request} (e.g.
   * `ProjectNotFound`); nothing is delivered then.
   */
  async subscribe<E extends EventName>(event: E, cwd: string, handlers: EventHandlers<E>): Promise<LinkSubscription> {
    const { dir } = await this.request("events.subscribe", { cwd, events: [event] });
    const subscriber: Subscriber = { event, cwd, dir, handlers: handlers as unknown as EventHandlers<EventName> };
    this.#subscribers.add(subscriber);
    return {
      dir,
      unsubscribe: async () => {
        if (!this.#subscribers.delete(subscriber)) return;
        // The daemon holds one subscription per connection and project: keep it while others need it.
        const shared = [...this.#subscribers].some((other) => other.event === event && other.dir === dir);
        if (shared || this.#closed) return;
        await this.request("events.unsubscribe", { cwd: dir, events: [event] }).catch(() => undefined);
      },
    };
  }

  /** Close the connection and stop reconnecting. The daemon keeps running until its idle timeout. */
  async close(): Promise<void> {
    this.#closed = true;
    clearTimeout(this.#retryTimer);
    this.#subscribers.clear();
    const connection = this.#connection;
    this.#connection = undefined;
    if (connection) (await connection.catch(() => undefined))?.close();
  }

  #connect(): Promise<DaemonConnection> {
    if (!this.#connection) {
      const connection = connectOrStartDaemon(this.options);
      this.#connection = connection;
      // A failed connect must not be cached: the next request tries again.
      connection.then(
        (conn) => this.#attach(connection, conn),
        () => {
          if (this.#connection === connection) this.#connection = undefined;
        },
      );
    }
    return this.#connection;
  }

  /** Route events to subscribers and watch for loss of this connection. */
  #attach(connection: Promise<DaemonConnection>, conn: DaemonConnection): void {
    for (const event of EVENT_NAMES) {
      conn.on(event, (params) => {
        for (const subscriber of [...this.#subscribers]) {
          if (subscriber.event === event && subscriber.dir === params.project) subscriber.handlers.onEvent(params);
        }
      });
    }
    // Subscriptions die with their connection, whoever closed it.
    void conn.closed.then(() => {
      if (this.#connection === connection) this.#connection = undefined;
      this.#resubscribe(FIRST_RETRY_MS);
    });
  }

  /** Reconnect and renew every subscription, retrying with backoff while the daemon cannot be reached. */
  #resubscribe(delay: number): void {
    if (this.#closed || this.#subscribers.size === 0) return;
    clearTimeout(this.#retryTimer);
    this.#retryTimer = setTimeout(() => {
      void this.#renew().then(
        () => {
          for (const subscriber of [...this.#subscribers]) subscriber.handlers.onResync?.();
        },
        () => this.#resubscribe(Math.min(delay * 2, MAX_RETRY_MS)),
      );
    }, delay);
  }

  async #renew(): Promise<void> {
    const conn = await this.#connect();
    const seen = new Set<string>();
    for (const { event, cwd, dir } of this.#subscribers) {
      const key = `${event}\0${dir}`;
      if (seen.has(key)) continue;
      seen.add(key);
      try {
        await conn.request("events.subscribe", { cwd, events: [event] });
      } catch (error) {
        // Project gone (moved, deleted): nothing to follow, but keep the others.
        if (!(error instanceof RpcError)) throw error;
      }
    }
  }

  #drop(): void {
    const connection = this.#connection;
    this.#connection = undefined;
    void connection?.then((conn) => conn.close()).catch(() => undefined);
  }
}
