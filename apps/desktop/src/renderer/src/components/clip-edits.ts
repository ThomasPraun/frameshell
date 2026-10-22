import type { OperationResult } from "@frameshell/protocol";
import type { EditOptions, TimelineEdit } from "../../../shared/api.js";
import { SELECTION_TIMELINE } from "../selection.js";

let queue: Promise<unknown> = Promise.resolve();

/**
 * Send one settings edit (inspector field, preview handle, subtitle style) as a `ui`
 * operation on the timeline the selection names. Edits go one after another
 * in the order made, so a fast second change never lands before the first.
 * `options.label` names its history entry. Rejects with the daemon's message; nothing changed then.
 */
export function sendClipEdit(edit: TimelineEdit, options?: EditOptions): Promise<OperationResult> {
  const sent = queue.then(() => window.frameshell.timeline.edit(SELECTION_TIMELINE, [edit], options));
  queue = sent.catch(() => undefined);
  return sent;
}
