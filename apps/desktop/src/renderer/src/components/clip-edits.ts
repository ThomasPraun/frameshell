import type { OperationResult } from "@frameshell/protocol";
import type { TimelineEdit } from "../../../shared/api.js";
import { SELECTION_TIMELINE } from "../selection.js";

let queue: Promise<unknown> = Promise.resolve();

/**
 * Send one clip settings edit (inspector field, preview handle) as a `ui`
 * operation on the timeline the selection names. Edits go one after another
 * in the order made, so a fast second change never lands before the first.
 * Rejects with the daemon's message; nothing changed then.
 */
export function sendClipEdit(edit: TimelineEdit): Promise<OperationResult> {
  const sent = queue.then(() => window.frameshell.timeline.edit(SELECTION_TIMELINE, [edit]));
  queue = sent.catch(() => undefined);
  return sent;
}
