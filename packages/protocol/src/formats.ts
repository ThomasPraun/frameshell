import type { FormatChange } from "./methods.js";

/** CLI command running `undo` of a `format.add`/`format.remove` (ADR 0027), e.g. `frameshell format remove 9x16`. */
export function formatUndoCommand(undo: FormatChange["undo"]): string {
  const { method, params } = undo;
  return method === "format.remove"
    ? `frameshell format remove ${String(params["id"])}`
    : `frameshell format add ${String(params["id"])} --size ${String(params["width"])}x${String(params["height"])} --index ${String(params["index"])}`;
}
