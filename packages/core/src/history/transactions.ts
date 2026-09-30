import { randomBytes } from "node:crypto";
import { ErrorCode, RpcError } from "@frameshell/protocol";
import type { TxRef } from "../timeline/service.js";

/** Ten seconds: an agent's burst of CLI calls for one intent fits; a pause to think starts a new transaction. */
export const DEFAULT_TX_IDLE_GAP_MS = 10_000;

/** A timeline an open transaction changed, so `tx.abort` knows what to revert. */
export interface TouchedTimeline {
  root: string;
  timeline: string;
}

/** Options for {@link TransactionTracker}. */
export interface TransactionTrackerOptions {
  /** Automatic grouping ends after this long without an operation from the session. */
  idleGapMs?: number | undefined;
  /** Clock in ms. Default `Date.now`. */
  now?: () => number;
}

interface Open {
  tx: TxRef;
  explicit: boolean;
  lastAt: number;
  operations: number;
  touched: Map<string, TouchedTimeline>;
}

/**
 * Which transaction each operation joins (SPEC §6.2), per author, in daemon
 * memory. `cli:<session>` operations group automatically until an idle gap;
 * `tx.begin` opens an explicit one that lasts until commit or abort. Other
 * authors (`ui`, `cli` without session, `file`, `plugin:<name>`) get one
 * transaction per operation unless they begin one explicitly (`cli` cannot:
 * without a session, each CLI call is a new connection).
 */
export class TransactionTracker {
  readonly #idleGapMs: number;
  readonly #now: () => number;
  readonly #open = new Map<string, Open>();

  constructor(options: TransactionTrackerOptions = {}) {
    this.#idleGapMs = options.idleGapMs ?? DEFAULT_TX_IDLE_GAP_MS;
    this.#now = options.now ?? Date.now;
  }

  /**
   * Transaction for `author`'s next operation. Call {@link TransactionTracker.applied}
   * once it succeeds. `standalone` (reverts) never joins an automatic group
   * and ends the current one; it still joins an explicit transaction.
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
    if (grouping) this.#open.set(author, { tx, explicit: false, lastAt: now, operations: 0, touched: new Map() });
    else this.#open.delete(author);
    return tx;
  }

  /** Record a successful operation of `tx` on `where`. */
  applied(author: string, tx: TxRef, where: TouchedTimeline): void {
    const open = this.#open.get(author);
    if (open?.tx.id !== tx.id) return;
    open.operations++;
    open.lastAt = this.#now();
    open.touched.set(`${where.root}\0${where.timeline}`, where);
  }

  /** Open an explicit transaction. Throws TransactionState without a session or when one is open. */
  begin(author: string, label: string): TxRef {
    if (author === "cli") {
      throw new RpcError(
        ErrorCode.TransactionState,
        "Transactions need a terminal session: run in a Frameshell app terminal, or set one, e.g. `export FRAMESHELL_SESSION=agent`.",
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
    this.#open.set(author, { tx, explicit: true, lastAt: this.#now(), operations: 0, touched: new Map() });
    return tx;
  }

  /** Close `author`'s explicit transaction and return what it did. Throws TransactionState when none is open. */
  end(author: string): ExplicitTransaction {
    const open = this.#explicit(author);
    this.#open.delete(author);
    return summary(open);
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
}

/** An explicit transaction and what it did so far. */
export interface ExplicitTransaction {
  tx: { id: string; label: string };
  /** Successful operations, every timeline. */
  operations: number;
  touched: TouchedTimeline[];
}

function summary(open: Open): ExplicitTransaction {
  return { tx: { id: open.tx.id, label: open.tx.label ?? "" }, operations: open.operations, touched: [...open.touched.values()] };
}

function newTxId(): string {
  return `tx_${randomBytes(4).toString("hex")}`;
}
