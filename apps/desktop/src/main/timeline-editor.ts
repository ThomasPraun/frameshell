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
import { CREATED_CLIP, EDIT_BURST_GAP_MAX_MS, EDIT_OPTION_MAX_LENGTH, type EditOptions, type RevertOutcome, TIMELINE_EDIT_OPS, type TimelineEdit } from "../shared/api.js";

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

/**
 * A gesture burst's transaction stays open this long after its latest edit,
 * ms: key repeat and quick presses fit, a pause starts a new history entry.
 */
export const BURST_GAP_MS = 1_500;

/** History label verbs of the ops an edit transaction holds. */
const BATCH_VERBS: Record<(typeof TIMELINE_EDIT_OPS)[number], string> = {
  "clip.add": "Insert",
  "clip.set": "Edit",
  "clip.key": "Edit",
  "transition.set": "Add",
  "transition.remove": "Remove",
  "clip.move": "Move",
  "clip.trim": "Trim",
  "clip.split": "Split",
  "clip.remove": "Delete",
  cut: "Ripple delete",
  "track.add": "Add",
  "track.set": "Change",
  "track.remove": "Delete",
  "shot.set": "Change",
  "multicam.angle": "Change",
  "multicam.offset": "Sync",
  "multicam.reframe": "Reframe",
  "multicam.paint": "Paint",
};

/** What the ops of an edit call change, for its label; mixed calls name clips. */
function editNoun(edits: readonly TimelineEdit[]): string {
  const prefixes: [string, string][] = [
    ["track.", "track"],
    ["shot.", "shot"],
    ["transition.", "transition"],
    ["multicam.", "angle"],
  ];
  if (edits.every((edit) => edit.op === "clip.key")) return "keyframe";
  return prefixes.find(([prefix]) => edits.every((edit) => edit.op.startsWith(prefix)))?.[1] ?? "clip";
}

/** Options of {@link TimelineEditor}. */
export interface TimelineEditorOptions {
  /** Override of {@link BURST_GAP_MS} (tests). */
  burstGapMs?: number;
}

/** The gesture burst whose transaction is open between calls. */
interface Burst {
  key: string;
  /** How long the transaction stays open after the latest edit, ms. */
  gap: number;
  cwd: string;
  timeline: string;
  timer: NodeJS.Timeout | undefined;
}

/**
 * The timeline panel's edits and undo/redo, as daemon operations on the
 * app's connection (author `ui`). Nothing is buffered: each edit is one
 * operation, saved and journaled by the daemon before the call resolves.
 *
 * Every call is one labelled `ui` transaction (`Move clip`, `Split 3
 * clips`), so it is one undo step and `history` reads well for the agent.
 * Calls of one gesture burst ({@link EditOptions.burst}) share one: the
 * transaction stays open up to {@link BURST_GAP_MS} after each, and closes
 * before anything else runs (another edit, undo, redo, revert,
 * {@link TimelineEditor.alone} work). Calls run one at a time across every
 * window: the daemon keeps one open transaction per author, and `ui` is
 * every window's.
 *
 * Undo and redo are `revert`s of the journal (SPEC §6.2), so they survive
 * restarts and see edits from every app window, and never touch operations
 * of other authors (the agent's).
 *
 * A `ui` transaction this editor did not close (an app that crashed
 * mid-batch or mid-burst, a commit lost with the connection) would absorb
 * every later `ui` operation, single edits and undos too, and each would
 * push back its auto-commit. So the first call after start, and after any
 * lost commit, commits whatever `ui` transaction is open before doing its work.
 */
export class TimelineEditor {
  #queue: Promise<unknown> = Promise.resolve();
  /** A `ui` transaction may be open that this editor did not open or failed to commit. */
  #orphanPossible = true;
  #burst: Burst | null = null;
  readonly #burstGapMs: number;

  constructor(
    private readonly request: DaemonRequest,
    options: TimelineEditorOptions = {},
  ) {
    this.#burstGapMs = options.burstGapMs ?? BURST_GAP_MS;
  }

  /**
   * Apply `edits` to `timeline` of the project enclosing `cwd`, in order,
   * as one transaction labelled `options.label`, else like `Move clip` or
   * `Split 3 clips`, and resolve with the last result. With
   * `options.burst`, the transaction stays open for the next call of the
   * same burst. The first edit the daemon refuses stops the rest and the
   * call rejects with the daemon's message. Outside a burst a call is all
   * or nothing: what applied before the refusal is undone (`tx.abort`), so
   * a group move never lands half done; when that undo itself conflicts (an
   * agent changed the same clips meanwhile), what applied stays as one
   * step. In a burst, earlier calls stay and the refusal ends the burst, but
   * what this call applied is reverted first, so a refused call changes nothing.
   * An edit whose `clip` is {@link CREATED_CLIP} right after a `clip.split`
   * acts on the clip that split created; anywhere else it is a plain clip id. Rejects ops outside
   * {@link TIMELINE_EDIT_OPS} and malformed options before sending
   * anything: the renderer is not trusted to pick any method.
   */
  apply(cwd: string, timeline: string, edits: readonly TimelineEdit[], options: EditOptions = {}): Promise<OperationResult> {
    const ops = edits.map((edit) => (edit as { op: unknown }).op);
    const foreign = ops.find((op) => !(TIMELINE_EDIT_OPS as readonly unknown[]).includes(op));
    if (edits.length === 0 || foreign !== undefined) {
      const sent = edits.length === 0 ? "an empty batch" : String(foreign);
      return Promise.reject(new Error(`The timeline panel cannot send ${sent}; it sends ${TIMELINE_EDIT_OPS.join(", ")}.`));
    }
    const { label, burst, burstGap } = (options ?? {}) as { label?: unknown; burst?: unknown; burstGap?: unknown };
    if (burstGap !== undefined && (!Number.isInteger(burstGap) || (burstGap as number) < 1 || (burstGap as number) > EDIT_BURST_GAP_MAX_MS)) {
      return Promise.reject(new Error(`An edit burstGap must be a whole number of ms from 1 to ${EDIT_BURST_GAP_MAX_MS}.`));
    }
    const gap = (burstGap as number | undefined) ?? this.#burstGapMs;
    for (const [name, value] of [
      ["label", label],
      ["burst", burst],
    ] as const) {
      if (value !== undefined && (typeof value !== "string" || value.length === 0 || value.length > EDIT_OPTION_MAX_LENGTH)) {
        return Promise.reject(new Error(`An edit ${name} must be text of 1 to ${EDIT_OPTION_MAX_LENGTH} characters.`));
      }
    }
    return this.#serial(async () => {
      const open = this.#burst;
      if (burst !== undefined && open?.key === burst && open.cwd === cwd && open.timeline === timeline) {
        clearTimeout(open.timer);
        open.gap = gap;
        return this.#sendBurst(cwd, timeline, edits, open, false);
      }
      await this.#endBurst();
      await this.#commitOrphan();
      await this.#begin((label as string | undefined) ?? editLabel(edits), burstGap === undefined ? BATCH_AUTO_COMMIT_S : BATCH_AUTO_COMMIT_S + gap / 1000);
      if (burst === undefined) {
        const applied: OperationResult[] = [];
        try {
          await this.#sendAll(cwd, timeline, edits, applied);
        } catch (error) {
          await (applied.length > 0 ? this.#abort() : this.#commit());
          throw error;
        }
        // A lost commit is retried before the next call.
        await this.#commit();
        return applied.at(-1)!;
      }
      const begun: Burst = { key: burst as string, gap, cwd, timeline, timer: undefined };
      this.#burst = begun;
      return this.#sendBurst(cwd, timeline, edits, begun, true);
    });
  }

  /** Revert the latest `ui` transaction not yet undone; null when there is none. */
  undo(cwd: string, timeline: string): Promise<OperationResult | null> {
    return this.#serial(async () => {
      await this.#endBurst();
      await this.#commitOrphan();
      const target = uiUndoStacks(await this.request("history", { cwd, timeline })).undo.at(-1);
      return target ? this.request("revert", { cwd, timeline, target }) : null;
    });
  }

  /** Revert the latest undo, re-applying what it undid; null when there is none. */
  redo(cwd: string, timeline: string): Promise<OperationResult | null> {
    return this.#serial(async () => {
      await this.#endBurst();
      await this.#commitOrphan();
      const target = uiUndoStacks(await this.request("history", { cwd, timeline })).redo.at(-1);
      return target ? this.request("revert", { cwd, timeline, target }) : null;
    });
  }

  /**
   * Revert `target` (a tx or op id of any author) from the History panel,
   * after any open burst closes, so the revert is a step of its own.
   * RevertConflict naming later operations becomes a `conflict` outcome;
   * other errors (unknown id, file changed outside the journal) reject.
   */
  revert(cwd: string, timeline: string, target: string): Promise<RevertOutcome> {
    return this.#serial(async () => {
      await this.#endBurst();
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
    });
  }

  /**
   * Run other `ui` work that the daemon journals (a `file.write` of a
   * timeline from the app's editor) in turn with the edits, once any open
   * burst closed: it must not join the burst's transaction.
   */
  alone<T>(work: () => Promise<T>): Promise<T> {
    return this.#serial(async () => {
      await this.#endBurst();
      return work();
    });
  }

  /** Close an open burst's transaction now, e.g. before quitting. */
  settle(): Promise<void> {
    return this.#serial(() => this.#endBurst());
  }

  /**
   * Send a burst's `edits` in order; success re-arms its gap timer. A refusal ends the burst after undoing this
   * call's applied edits: a fresh burst aborts its transaction, a running one reverts them (newest first).
   */
  async #sendBurst(cwd: string, timeline: string, edits: readonly TimelineEdit[], burst: Burst, fresh: boolean): Promise<OperationResult> {
    const applied: OperationResult[] = [];
    try {
      await this.#sendAll(cwd, timeline, edits, applied);
    } catch (error) {
      if (applied.length > 0 && fresh) {
        clearTimeout(burst.timer);
        if (this.#burst === burst) this.#burst = null;
        await this.#abort();
      } else {
        for (const result of applied.reverse()) {
          try {
            await this.request("revert", { cwd, timeline, target: result.operation.id });
          } catch {
            // Changed since by someone else: what applied stays.
            break;
          }
        }
        await this.#endBurst();
      }
      throw error;
    }
    if (this.#burst === burst) {
      burst.timer = setTimeout(() => {
        void this.#serial(async () => {
          if (this.#burst === burst) await this.#endBurst();
        }).catch(() => undefined);
      }, burst.gap);
      burst.timer.unref?.();
    }
    return applied.at(-1)!;
  }

  /** Send `edits` in order, pushing each result onto `applied` so a caller can undo them when a later one is refused. */
  async #sendAll(cwd: string, timeline: string, edits: readonly TimelineEdit[], applied: OperationResult[]): Promise<void> {
    for (const [index, edit] of edits.entries()) {
      let sent: TimelineEdit = edit;
      // Only right after a split: elsewhere `$created` is a valid clip id a timeline file may use.
      if (index > 0 && edits[index - 1]!.op === "clip.split" && (edit.args as { clip?: unknown }).clip === CREATED_CLIP) {
        const created = applied.at(-1)?.changes.added[0];
        if (!created) throw new Error("The split before it did not report a new clip for it to act on.");
        sent = { ...edit, args: { ...edit.args, clip: created } } as TimelineEdit;
      }
      applied.push(await this.#send(cwd, timeline, sent));
    }
  }

  #send(cwd: string, timeline: string, edit: TimelineEdit): Promise<OperationResult> {
    // One call per op keeps each typed against its own params.
    const params = { ...edit.args, cwd, timeline };
    return this.request(edit.op, params as MethodParams<typeof edit.op>) as Promise<OperationResult>;
  }

  /** Commit the open burst's transaction, if any. */
  async #endBurst(): Promise<void> {
    const burst = this.#burst;
    if (!burst) return;
    clearTimeout(burst.timer);
    this.#burst = null;
    await this.#commit();
  }

  /**
   * Commit this editor's transaction. None open (another app process
   * committed it) is fine; a lost commit is retried before the next call.
   */
  async #commit(): Promise<void> {
    try {
      await this.request("tx.commit", {});
    } catch (error) {
      if ((error as RpcError | undefined)?.code !== ErrorCode.TransactionState) this.#orphanPossible = true;
    }
  }

  /**
   * Undo and close this editor's transaction. A conflict (someone changed
   * the same clips since) leaves it open: commit it, keeping what applied.
   * Other failures leave it to the next call's orphan commit.
   */
  async #abort(): Promise<void> {
    try {
      await this.request("tx.abort", {});
    } catch (error) {
      if ((error as RpcError | undefined)?.code === ErrorCode.RevertConflict) await this.#commit();
      else if ((error as RpcError | undefined)?.code !== ErrorCode.TransactionState) this.#orphanPossible = true;
    }
  }

  /**
   * Open the call's transaction. A `ui` transaction still open here was
   * opened by another app process since {@link TimelineEditor.#commitOrphan}
   * ran: commit it rather than fail the edit.
   */
  async #begin(label: string, autoCommitAfter: number): Promise<void> {
    const begin = () => this.request("tx.begin", { label, autoCommitAfter });
    try {
      await begin();
    } catch (error) {
      if ((error as RpcError | undefined)?.code !== ErrorCode.TransactionState) throw error;
      await this.request("tx.commit", {});
      await begin();
    }
  }

  /**
   * Commit a `ui` transaction left open outside this editor's calls, if
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

/**
 * Default history label of an edit call: `Move clip`, `Split 3 clips`,
 * `Edit 3 clips` when ops differ, `Ripple trim clip` for a rippled trim,
 * `Change shot`, `Sync angle`, `Paint turns`.
 */
export function editLabel(edits: readonly TimelineEdit[]): string {
  if (edits.every((edit) => edit.op === "multicam.paint")) return "Paint turns";
  const verbs = edits.map((edit) => (edit.op === "clip.trim" && edit.args.ripple === true ? "Ripple trim" : BATCH_VERBS[edit.op]));
  const verb = verbs.every((candidate) => candidate === verbs[0]) ? verbs[0]! : "Edit";
  const noun = editNoun(edits);
  return edits.length === 1 ? `${verb} ${noun}` : `${verb} ${edits.length} ${noun}s`;
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
 * edit. An aborted transaction (its last operation reverts the transaction
 * itself: a refused call) changed nothing and is skipped. Other authors'
 * operations are skipped: their conflicts surface when the daemon refuses
 * the revert.
 */
function uiUndoStacks(history: HistoryResult): { undo: string[]; redo: string[] } {
  const undo: string[] = [];
  let redo: string[] = [];
  for (const tx of history.transactions) {
    if (tx.author !== UI_AUTHOR) continue;
    const closing = tx.operations.at(-1);
    if (closing?.op === "revert" && closing.args["target"] === tx.tx) continue;
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
