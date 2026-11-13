import { type BatchEntry, ErrorCode, RpcError } from "@frameshell/protocol";

/**
 * The rows `specs` name, in the batch file's order. A spec is a row id or `first..last` (both ends included, in the
 * file's order; ids never hold `.`). Throws InvalidOperation naming the row the file lacks (ADR 0040 decision 8).
 */
export function chooseRows(ids: readonly string[], specs: readonly string[] | undefined): string[] {
  if (specs === undefined) return [...ids];
  const chosen = new Set<string>();
  const position = (id: string, spec: string): number => {
    const at = ids.indexOf(id);
    if (at >= 0) return at;
    throw new RpcError(ErrorCode.InvalidOperation, `Row ${id}${spec === id ? "" : ` (in \`${spec}\`)`}: the batch file has no such row. Rows: ${ids.join(", ")}.`, {
      op: "batch.render",
      row: id,
      reason: "unknown row",
      field: "rows",
      valid: [...ids],
    });
  };
  for (const spec of specs) {
    const [first, last, ...more] = spec.split("..");
    if (last === undefined) {
      chosen.add(ids[position(spec, spec)]!);
      continue;
    }
    if (more.length > 0 || first === "" || last === "") {
      throw new RpcError(ErrorCode.InvalidParams, `Bad row range \`${spec}\`: write \`first..last\` with two row ids, e.g. \`es..fr\`.`, { field: "rows", spec });
    }
    const from = position(first!, spec);
    const to = position(last, spec);
    if (from > to) {
      throw new RpcError(ErrorCode.InvalidOperation, `Row range \`${spec}\`: ${last} comes before ${first} in the batch file. Write \`${last}..${first}\`.`, {
        op: "batch.render",
        reason: "range order",
        field: "rows",
        spec,
      });
    }
    ids.slice(from, to + 1).forEach((id) => chosen.add(id));
  }
  return ids.filter((id) => chosen.has(id));
}

/** True when `row` has no entry yet or an entry that is not `done`: what `failed` re-runs. */
export function notDone(entries: readonly BatchEntry[], row: string): boolean {
  const own = entries.filter((entry) => entry.row === row);
  return own.length === 0 || own.some((entry) => entry.status !== "done");
}

/**
 * A manifest entry a stopped daemon left unfinished, as a `canceled` one: nothing renders it any more, and a
 * manifest must not say `running` for a render no job runs. Other entries come back unchanged.
 */
export function settled(entry: BatchEntry): BatchEntry {
  if (entry.status !== "queued" && entry.status !== "running" && entry.status !== "planned") return entry;
  return { ...entry, status: "canceled", error: "The daemon stopped before this render ended.", finishedAt: null, duration: null };
}
