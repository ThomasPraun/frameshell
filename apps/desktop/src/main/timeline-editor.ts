import {
  ErrorCode,
  type HistoryResult,
  type MethodName,
  type MethodParams,
  type MethodResult,
  type OperationResult,
  type RevertConflict,
  type RpcError,
} from "@frameshell/protocol";
import { type RevertOutcome, TIMELINE_EDIT_OPS, type TimelineEdit } from "../shared/api.js";

/** A typed daemon request, e.g. {@link DaemonLink.request} bound to the app's link. */
export type DaemonRequest = <M extends MethodName>(method: M, params: MethodParams<M>) => Promise<MethodResult<M>>;

/** SPEC §6.2 author of every operation the app's connection sends. */
const UI_AUTHOR = "ui";

/**
 * Seconds without an operation after which the daemon commits a batch's
 * transaction itself: a crash mid-batch must not leave it absorbing later
 * `ui` edits. Far above one edit's round trip, even with energy snapping.
 */
export const BATCH_AUTO_COMMIT_S = 15;

/** History label verbs of the ops a batch holds. */
const BATCH_VERBS: Record<(typeof TIMELINE_EDIT_OPS)[number], string> = {
  "clip.add": "Insert",
  "clip.set": "Edit",
  "clip.move": "Move",
  "clip.trim": "Trim",
  "clip.split": "Split",
  "clip.remove": "Delete",
  cut: "Ripple delete",
};

/**
 * The timeline panel's edits and undo/redo, as daemon operations on the
 * app's connection (author `ui`). Nothing is buffered: each edit is one
 * operation, saved and journaled by the daemon before the call resolves.
 *
 * A command touching several clips is one `ui` transaction, so it is one
 * undo step. Calls run one at a time across every window: the daemon keeps
 * one open transaction per author, and `ui` is every window's.
 *
 * Undo and redo are `revert`s of the journal (SPEC §6.2), so they survive
 * restarts and see edits from every app window, and never touch operations
 * of other authors (the agent's).
 *
 * A `ui` transaction this editor did not close (an app that crashed
 * mid-batch, a commit lost with the connection) would absorb every later
 * `ui` operation, single edits and undos too, and each would push back its
 * auto-commit. So the first call after start, and after any lost commit,
 * commits whatever `ui` transaction is open before doing its work.
 */
export class TimelineEditor {
  #queue: Promise<unknown> = Promise.resolve();
  /** A `ui` transaction may be open that this editor did not open or failed to commit. */
  #orphanPossible = true;

  constructor(private readonly request: DaemonRequest) {}

  /**
   * Apply `edits` to `timeline` of the project enclosing `cwd`, in order,
   * and resolve with the last result. Several edits form one transaction
   * labelled like `Split 3 clips`; the first the daemon refuses stops the
   * rest, what applied stays (one undo step) and the call rejects with the
   * daemon's message. Rejects ops outside {@link TIMELINE_EDIT_OPS} before
   * sending anything: the renderer is not trusted to pick any method.
   */
  apply(cwd: string, timeline: string, edits: readonly TimelineEdit[]): Promise<OperationResult> {
    const ops = edits.map((edit) => (edit as { op: unknown }).op);
    const foreign = ops.find((op) => !(TIMELINE_EDIT_OPS as readonly unknown[]).includes(op));
    if (edits.length === 0 || foreign !== undefined) {
      const sent = edits.length === 0 ? "an empty batch" : String(foreign);
      return Promise.reject(new Error(`The timeline panel cannot send ${sent}; it sends ${TIMELINE_EDIT_OPS.join(", ")}.`));
    }
    return this.#serial(async () => {
      await this.#commitOrphan();
      if (edits.length === 1) return this.#send(cwd, timeline, edits[0]!);
      await this.#begin(batchLabel(edits));
      try {
        let last: OperationResult | undefined;
        for (const edit of edits) last = await this.#send(cwd, timeline, edit);
        return last!;
      } finally {
        // On failure too: what applied is one step. A lost commit is retried before the next call.
        await this.request("tx.commit", {}).catch(() => {
          this.#orphanPossible = true;
        });
      }
    });
  }

  /** Revert the latest `ui` transaction not yet undone; null when there is none. */
  undo(cwd: string, timeline: string): Promise<OperationResult | null> {
    return this.#serial(async () => {
      await this.#commitOrphan();
      const target = uiUndoStacks(await this.request("history", { cwd, timeline })).undo.at(-1);
      return target ? this.request("revert", { cwd, timeline, target }) : null;
    });
  }

  /** Revert the latest undo, re-applying what it undid; null when there is none. */
  redo(cwd: string, timeline: string): Promise<OperationResult | null> {
    return this.#serial(async () => {
      await this.#commitOrphan();
      const target = uiUndoStacks(await this.request("history", { cwd, timeline })).redo.at(-1);
      return target ? this.request("revert", { cwd, timeline, target }) : null;
    });
  }

  #send(cwd: string, timeline: string, edit: TimelineEdit): Promise<OperationResult> {
    // One call per op keeps each typed against its own params.
    const params = { ...edit.args, cwd, timeline };
    return this.request(edit.op, params as MethodParams<typeof edit.op>) as Promise<OperationResult>;
  }

  /**
   * Revert `target` (a tx or op id of any author) from the History panel.
   * RevertConflict naming later operations becomes a `conflict` outcome;
   * other errors (unknown id, file changed outside the journal) reject.
   */
  async revert(cwd: string, timeline: string, target: string): Promise<RevertOutcome> {
    try {
      return { status: "reverted", result: await this.request("revert", { cwd, timeline, target }) };
    } catch (error) {
      // Duck-typed: the link may rethrow the daemon's error from another copy of the protocol module.
      const rpc = error as Partial<RpcError>;
      const conflicts = rpc.code === ErrorCode.RevertConflict ? conflictsOf(rpc) : [];
      // None named: the file changed outside the journal. Nothing to revert first, so it stays an error.
      if (conflicts.length === 0) throw error;
      return { status: "conflict", message: rpc.message ?? "Revert refused", conflicts };
    }
  }

  /**
   * Open the batch's transaction. A `ui` transaction still open here was
   * opened by another app process since {@link TimelineEditor.#commitOrphan}
   * ran: commit it rather than fail the edit.
   */
  async #begin(label: string): Promise<void> {
    const begin = () => this.request("tx.begin", { label, autoCommitAfter: BATCH_AUTO_COMMIT_S });
    try {
      await begin();
    } catch (error) {
      if ((error as RpcError | undefined)?.code !== ErrorCode.TransactionState) throw error;
      await this.request("tx.commit", {});
      await begin();
    }
  }

  /**
   * Commit a `ui` transaction left open outside this editor's batches, if
   * {@link TimelineEditor.#orphanPossible}. None open is the usual answer.
   * Other errors propagate and keep the flag, so the next call retries.
   */
  async #commitOrphan(): Promise<void> {
    if (!this.#orphanPossible) return;
    try {
      await this.request("tx.commit", {});
    } catch (error) {
      if ((error as RpcError | undefined)?.code !== ErrorCode.TransactionState) throw error;
    }
    this.#orphanPossible = false;
  }

  #serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(work);
    this.#queue = run.catch(() => undefined);
    return run;
  }
}

/** History label of a batch: `Split 3 clips`, or `Edit 3 clips` when ops differ. */
function batchLabel(edits: readonly TimelineEdit[]): string {
  const [first] = edits;
  const verb = edits.every((edit) => edit.op === first!.op) ? BATCH_VERBS[first!.op] : "Edit";
  return `${verb} ${edits.length} clips`;
}

function conflictsOf(error: Partial<RpcError>): RevertConflict[] {
  const data = error.data as { conflicts?: RevertConflict[] } | undefined;
  return Array.isArray(data?.conflicts) ? data.conflicts : [];
}

/**
 * Undo and redo stacks of the `ui` author, replayed from a timeline's
 * history. Entries are transaction ids to `revert`, newest last.
 *
 * A `ui` edit pushes onto undo and clears redo. A `ui` revert of the top of
 * undo moves it to redo as the revert's own transaction (reverting that
 * re-applies the edit); a revert of the top of redo moves back to undo
 * likewise. Any other `ui` revert (e.g. from a History panel) counts as an
 * edit. Other authors' operations are skipped: their conflicts surface when
 * the daemon refuses the revert.
 */
function uiUndoStacks(history: HistoryResult): { undo: string[]; redo: string[] } {
  const undo: string[] = [];
  let redo: string[] = [];
  for (const tx of history.transactions) {
    if (tx.author !== UI_AUTHOR) continue;
    const [only, ...more] = tx.operations;
    const target = only?.op === "revert" && more.length === 0 ? only.args["target"] : undefined;
    if (target !== undefined && target === undo.at(-1)) {
      undo.pop();
      redo.push(tx.tx);
    } else if (target !== undefined && target === redo.at(-1)) {
      redo.pop();
      undo.push(tx.tx);
    } else {
      undo.push(tx.tx);
      redo = [];
    }
  }
  return { undo, redo };
}
