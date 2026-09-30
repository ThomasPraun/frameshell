import type { HistoryResult, MethodName, MethodParams, MethodResult, OperationResult } from "@frameshell/protocol";
import { TIMELINE_EDIT_OPS, type TimelineEdit } from "../shared/api.js";

/** A typed daemon request, e.g. {@link DaemonLink.request} bound to the app's link. */
export type DaemonRequest = <M extends MethodName>(method: M, params: MethodParams<M>) => Promise<MethodResult<M>>;

/** SPEC §6.2 author of every operation the app's connection sends. */
const UI_AUTHOR = "ui";

/**
 * The timeline panel's edits and undo/redo, as daemon operations on the
 * app's connection (author `ui`). Nothing is buffered: each call is one
 * operation, saved and journaled by the daemon before it resolves.
 *
 * Undo and redo are `revert`s of the journal (SPEC §6.2), so they survive
 * restarts and see edits from every app window, and never touch operations
 * of other authors (the agent's).
 */
export class TimelineEditor {
  constructor(private readonly request: DaemonRequest) {}

  /**
   * Apply `edit` to `timeline` of the project enclosing `cwd`. Rejects ops
   * outside {@link TIMELINE_EDIT_OPS} (the renderer is not trusted to pick
   * any method) and passes daemon errors through.
   */
  async apply(cwd: string, timeline: string, edit: TimelineEdit): Promise<OperationResult> {
    const op = (edit as { op: unknown }).op;
    if (!(TIMELINE_EDIT_OPS as readonly unknown[]).includes(op)) {
      throw new Error(`The timeline panel cannot send ${String(op)}; it sends ${TIMELINE_EDIT_OPS.join(", ")}.`);
    }
    // One call per op keeps each typed against its own params.
    const params = { ...edit.args, cwd, timeline };
    return this.request(edit.op, params as MethodParams<typeof edit.op>) as Promise<OperationResult>;
  }

  /** Revert the latest `ui` transaction not yet undone; null when there is none. */
  async undo(cwd: string, timeline: string): Promise<OperationResult | null> {
    const target = uiUndoStacks(await this.request("history", { cwd, timeline })).undo.at(-1);
    return target ? this.request("revert", { cwd, timeline, target }) : null;
  }

  /** Revert the latest undo, re-applying what it undid; null when there is none. */
  async redo(cwd: string, timeline: string): Promise<OperationResult | null> {
    const target = uiUndoStacks(await this.request("history", { cwd, timeline })).redo.at(-1);
    return target ? this.request("revert", { cwd, timeline, target }) : null;
  }
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
