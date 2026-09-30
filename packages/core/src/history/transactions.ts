import { createHash, randomBytes } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { AuthorSchema, ErrorCode, RpcError, TxIdSchema } from "@frameshell/protocol";
import { z } from "zod";
import { readJsonIfExists, writeJsonAtomic } from "../fs-util.js";
import type { TxRef } from "../timeline/service.js";

/** Ten seconds: an agent's burst of CLI calls for one intent fits; a pause to think starts a new transaction. */
export const DEFAULT_TX_IDLE_GAP_MS = 10_000;

/** A timeline an open transaction changed, so `tx.abort` knows what to revert. */
export interface TouchedTimeline {
  root: string;
  timeline: string;
}

/** An explicit transaction as persisted by a {@link TransactionStore}. */
export interface StoredTransaction {
  author: string;
  tx: { id: string; label: string };
  operations: number;
  touched: TouchedTimeline[];
  /** ISO 8601 time of `begin`; absent in files written before it was recorded. */
  openedAt?: string | undefined;
}

/**
 * Durable home of open explicit transactions (SPEC §6.2), so they survive a
 * daemon restart. `save` receives every open one and replaces what was stored.
 */
export interface TransactionStore {
  load(): Promise<StoredTransaction[]>;
  save(open: StoredTransaction[]): Promise<void>;
}

/** Options for {@link TransactionTracker}. */
export interface TransactionTrackerOptions {
  /** Automatic grouping ends after this long without an operation from the session. */
  idleGapMs?: number | undefined;
  /** Clock in ms. Default `Date.now`. */
  now?: () => number;
  /** Where explicit transactions persist. Default: memory only. */
  store?: TransactionStore | undefined;
}

interface Open {
  tx: TxRef;
  explicit: boolean;
  lastAt: number;
  operations: number;
  touched: Map<string, TouchedTimeline>;
  /** Explicit only: ISO time of `begin`; null when the store did not record it. */
  openedAt: string | null;
}

/**
 * Which transaction each operation joins (SPEC §6.2), per author.
 * `cli:<session>` operations group automatically until an idle gap (daemon
 * memory only). `tx.begin` opens an explicit one that lasts until commit or
 * abort and is kept in the {@link TransactionStore}, so a restarted daemon
 * resumes it with its label, operation count and touched timelines. Other
 * authors (`ui`, `cli` without session, `file`, `plugin:<name>`) get one
 * transaction per operation unless they begin one explicitly (`cli` cannot:
 * without a session, each CLI call is a new connection).
 */
export class TransactionTracker {
  readonly #idleGapMs: number;
  readonly #now: () => number;
  readonly #store: TransactionStore | undefined;
  readonly #open = new Map<string, Open>();
  /** Saves run one at a time, each writing the state current when it starts. */
  #saving: Promise<void> = Promise.resolve();

  constructor(options: TransactionTrackerOptions = {}) {
    this.#idleGapMs = options.idleGapMs ?? DEFAULT_TX_IDLE_GAP_MS;
    this.#now = options.now ?? Date.now;
    this.#store = options.store;
  }

  /** Reopen the explicit transactions the store holds. Call once, before the first operation. */
  async restore(): Promise<void> {
    if (!this.#store) return;
    for (const stored of await this.#store.load()) {
      this.#open.set(stored.author, {
        tx: stored.tx,
        explicit: true,
        lastAt: this.#now(),
        operations: stored.operations,
        touched: new Map(stored.touched.map((where) => [touchKey(where), where])),
        openedAt: stored.openedAt ?? null,
      });
    }
  }

  /**
   * Transaction for `author`'s next operation. Call {@link TransactionTracker.touching}
   * before running it and {@link TransactionTracker.applied} once it succeeds.
   * `standalone` (reverts) never joins an automatic group and ends the current
   * one; it still joins an explicit transaction.
   */
  next(author: string, options: { standalone?: boolean } = {}): TxRef {
    const now = this.#now();
    const open = this.#open.get(author);
    if (open?.explicit) return open.tx;
    const grouping = author.startsWith("cli:") && !options.standalone;
    if (grouping && open && now - open.lastAt <= this.#idleGapMs) {
      open.lastAt = now;
      return open.tx;
    }
    const tx = { id: newTxId(), label: null };
    if (grouping) this.#open.set(author, { tx, explicit: false, lastAt: now, operations: 0, touched: new Map(), openedAt: null });
    else this.#open.delete(author);
    return tx;
  }

  /**
   * Record that `tx` is about to change `where`. Persisted before the change,
   * so a crash between write and bookkeeping never hides a timeline from `tx.abort`.
   */
  async touching(author: string, tx: TxRef, where: TouchedTimeline): Promise<void> {
    const open = this.#open.get(author);
    if (open?.tx.id !== tx.id || open.touched.has(touchKey(where))) return;
    open.touched.set(touchKey(where), where);
    if (open.explicit) await this.#persist();
  }

  /** Count a successful operation of `tx`. */
  async applied(author: string, tx: TxRef): Promise<void> {
    const open = this.#open.get(author);
    if (open?.tx.id !== tx.id) return;
    open.operations++;
    open.lastAt = this.#now();
    // The count is informational: a lost save must not fail an operation already applied.
    if (open.explicit) await this.#persist().catch(() => {});
  }

  /** Open an explicit transaction. Throws TransactionState without a session or when one is open. */
  async begin(author: string, label: string): Promise<TxRef> {
    if (author === "cli") {
      throw new RpcError(
        ErrorCode.TransactionState,
        "Transactions need a terminal session. The frameshell CLI sends one per shell; other clients must pass `session` " +
          "in the handshake, e.g. from `FRAMESHELL_SESSION=agent`.",
        { author, open: null, hint: "Set FRAMESHELL_SESSION." },
      );
    }
    const open = this.#open.get(author);
    if (open?.explicit) {
      throw new RpcError(
        ErrorCode.TransactionState,
        `Transaction ${open.tx.id} "${open.tx.label}" is already open for ${author}. Commit or abort it first.`,
        { author, open: { tx: open.tx.id, label: open.tx.label }, hint: "`frameshell tx commit` or `frameshell tx abort`." },
      );
    }
    const tx = { id: newTxId(), label };
    const now = this.#now();
    this.#open.set(author, { tx, explicit: true, lastAt: now, operations: 0, touched: new Map(), openedAt: new Date(now).toISOString() });
    try {
      await this.#persist();
    } catch (error) {
      // Not durable means not begun.
      this.#open.delete(author);
      throw error;
    }
    return tx;
  }

  /** Close `author`'s explicit transaction and return what it did. Throws TransactionState when none is open. */
  async end(author: string): Promise<ExplicitTransaction> {
    const open = this.#explicit(author);
    this.#open.delete(author);
    await this.#persist();
    return summary(open);
  }

  /** Every open explicit transaction with its author, oldest `begin` first (unrecorded times first). */
  list(): (ExplicitTransaction & { author: string })[] {
    return [...this.#open]
      .filter(([, open]) => open.explicit)
      .map(([author, open]) => ({ author, ...summary(open) }))
      .sort((a, b) => (a.openedAt ?? "").localeCompare(b.openedAt ?? ""));
  }

  /** `author`'s explicit transaction, left open; throws like {@link TransactionTracker.end}. */
  peek(author: string): ExplicitTransaction {
    return summary(this.#explicit(author));
  }

  #explicit(author: string): Open {
    const open = this.#open.get(author);
    if (open?.explicit) return open;
    throw new RpcError(ErrorCode.TransactionState, `No transaction is open for ${author}. Start one with \`frameshell tx begin "<label>"\`.`, {
      author,
      open: null,
      hint: '`frameshell tx begin "<label>"`.',
    });
  }

  #persist(): Promise<void> {
    const store = this.#store;
    if (!store) return Promise.resolve();
    const run = this.#saving.then(() =>
      store.save(
        this.list().map(({ openedAt, ...open }) => ({ ...open, ...(openedAt ? { openedAt } : {}) })),
      ),
    );
    this.#saving = run.catch(() => {});
    return run;
  }
}

/** An explicit transaction and what it did so far. */
export interface ExplicitTransaction {
  tx: { id: string; label: string };
  /** Successful operations, every timeline. */
  operations: number;
  touched: TouchedTimeline[];
  /** ISO 8601 time of `begin`; null when not recorded (opened by an older daemon). */
  openedAt: string | null;
}

const StoredFileSchema = z.object({
  version: z.literal(1),
  open: z.array(
    z.object({
      author: AuthorSchema,
      tx: z.object({ id: TxIdSchema, label: z.string() }),
      operations: z.int().nonnegative(),
      touched: z.array(z.object({ root: z.string(), timeline: z.string() })),
      openedAt: z.string().optional(),
    }),
  ),
});

/**
 * {@link TransactionStore} in one JSON file per daemon endpoint:
 * `<dataDir>/transactions/<hash of socket path>.json`, so daemons on other
 * sockets (tests, a second install) never share state. Removed when nothing
 * is open. A missing or unreadable file means no open transactions.
 */
export class FileTransactionStore implements TransactionStore {
  readonly path: string;

  constructor(dataDir: string, socketPath: string) {
    const key = createHash("sha256").update(socketPath).digest("hex").slice(0, 16);
    this.path = join(dataDir, "transactions", `${key}.json`);
  }

  async load(): Promise<StoredTransaction[]> {
    let value: unknown;
    try {
      value = await readJsonIfExists(this.path);
    } catch {
      return [];
    }
    const parsed = StoredFileSchema.safeParse(value);
    return parsed.success ? parsed.data.open : [];
  }

  async save(open: StoredTransaction[]): Promise<void> {
    if (open.length === 0) await rm(this.path, { force: true });
    else await writeJsonAtomic(this.path, { version: 1, open });
  }
}

function summary(open: Open): ExplicitTransaction {
  return {
    tx: { id: open.tx.id, label: open.tx.label ?? "" },
    operations: open.operations,
    touched: [...open.touched.values()],
    openedAt: open.openedAt,
  };
}

function touchKey(where: TouchedTimeline): string {
  return `${where.root}\0${where.timeline}`;
}

function newTxId(): string {
  return `tx_${randomBytes(4).toString("hex")}`;
}
