import { ErrorCode, RpcError } from "@frameshell/protocol";

/** Ten minutes: far longer than any client's retry after a lost reply. */
export const DEFAULT_IDEMPOTENCY_TTL_MS = 10 * 60_000;
/** Keys remembered at once, all authors; the oldest go first. */
export const DEFAULT_IDEMPOTENCY_CAPACITY = 1_000;

/** Options for {@link IdempotencyCache}. */
export interface IdempotencyCacheOptions {
  /** A key is forgotten this long after its request started. */
  ttlMs?: number;
  /** Most keys kept; past it the oldest is forgotten. */
  capacity?: number;
  /** Clock in ms. Default `Date.now`. */
  now?: () => number;
}

interface Entry {
  /** Method and params the key was first used with, to refuse reuse for another change. */
  fingerprint: string;
  at: number;
  result: Promise<unknown>;
}

/**
 * Recent idempotency keys of mutating requests, per author (SPEC §6.2
 * `ui`, `cli:<session>`…), so a client retrying after a lost reply gets the
 * first request's result instead of applying the change twice.
 *
 * A replay arriving while the first request still runs waits for it. Only
 * successes are remembered: a failed request changed nothing, so its key is
 * forgotten and a retry runs again. Memory only: a daemon restart forgets
 * every key (a reply lost to a daemon crash is not replayable).
 */
export class IdempotencyCache {
  readonly #ttlMs: number;
  readonly #capacity: number;
  readonly #now: () => number;
  /** Insertion order = age, oldest first. */
  readonly #entries = new Map<string, Entry>();

  constructor(options: IdempotencyCacheOptions = {}) {
    this.#ttlMs = options.ttlMs ?? DEFAULT_IDEMPOTENCY_TTL_MS;
    this.#capacity = options.capacity ?? DEFAULT_IDEMPOTENCY_CAPACITY;
    this.#now = options.now ?? Date.now;
  }

  /**
   * Run `work` once per `author` and `key`: a repeat returns the first
   * result. Throws {@link RpcError} `InvalidParams` when `key` was used for
   * another method or other params.
   */
  run<T>(author: string, key: string, method: string, params: unknown, work: () => Promise<T>): Promise<T> {
    this.#expire();
    const id = `${author}\0${key}`;
    const fingerprint = `${method}\0${stableJson(params)}`;
    const known = this.#entries.get(id);
    if (known) {
      if (known.fingerprint !== fingerprint) {
        throw new RpcError(
          ErrorCode.InvalidParams,
          `idempotencyKey ${key} was already used for another request; send a new key per change.`,
          { issues: [{ path: ["idempotencyKey"], message: "already used for another request" }] },
        );
      }
      return known.result as Promise<T>;
    }
    const result = work();
    const entry: Entry = { fingerprint, at: this.#now(), result };
    this.#entries.set(id, entry);
    result.catch(() => {
      if (this.#entries.get(id) === entry) this.#entries.delete(id);
    });
    while (this.#entries.size > this.#capacity) this.#entries.delete(this.#entries.keys().next().value!);
    return result;
  }

  #expire(): void {
    const oldest = this.#now() - this.#ttlMs;
    for (const [id, entry] of this.#entries) {
      if (entry.at > oldest) break;
      this.#entries.delete(id);
    }
  }
}

/** JSON with object keys sorted, so equal params compare equal whatever their key order. */
function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) =>
    inner && typeof inner === "object" && !Array.isArray(inner)
      ? Object.fromEntries(Object.entries(inner).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : inner,
  );
}
