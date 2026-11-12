import { type ConfigDoc, type ConfigJournalEntry, ErrorCode, type RevertConflict, RpcError } from "@frameshell/protocol";
import { type ConfigRules, type ConfigState, PLAIN_RULES, applyConfigPatch, configHash } from "./patch.js";

/**
 * Pure revert over one config document's journal (ADR 0036), the keyed twin of `planRevert`
 * (`history/revert.ts`): the target's keys are restored newest first, a later foreign operation that left
 * another value on one of them conflicts, and a break in the hash chain is an edit outside the journal.
 */

/** Words naming config document `doc` in messages. */
export const CONFIG_DOC_NAMES: Record<ConfigDoc, string> = { project: "the formats of frameshell.json" };

/**
 * `current` with the target's operations undone. `entries` are `doc`'s journal lines, oldest first; `target` is
 * a tx or op id that is in them; `rules` compare and write `doc`'s keys. Throws RevertConflict (see the module
 * doc) or HistoryNotFound.
 */
export function planConfigRevert(
  current: ConfigState,
  entries: readonly ConfigJournalEntry[],
  target: string,
  doc: ConfigDoc,
  rules: ConfigRules = PLAIN_RULES,
): ConfigState {
  const inTarget = (entry: ConfigJournalEntry) => entry.id === target || entry.tx === target;
  const first = entries.findIndex(inTarget);
  if (first === -1) {
    throw new RpcError(ErrorCode.HistoryNotFound, `No operation of ${target} changed ${CONFIG_DOC_NAMES[doc]}.`, { target, doc });
  }
  const tail = entries.slice(first);
  const gap = configGap(current, tail);
  if (gap !== null) {
    throw new RpcError(
      ErrorCode.RevertConflict,
      `Cannot revert ${target}: ${CONFIG_DOC_NAMES[doc]} changed outside the journal ${gap}. The journal cannot undo an ` +
        "edit it did not record, and reverting would overwrite it. Change it forward instead (`frameshell format add|remove`).",
      { target, doc, conflicts: [], hint: "Change it forward; the journal cannot undo changes it did not record." },
    );
  }
  const keys = new Set(tail.filter(inTarget).flatMap((entry) => entry.patch.map((change) => change.key)));
  let state = current;
  let anchor = snapshot(state, keys);
  let segment: ConfigJournalEntry[] = [];
  const conflicts = new Map<string, { entry: ConfigJournalEntry; keys: Set<string> }>();
  let restored = current;
  for (let i = tail.length - 1; i >= 0; i--) {
    const entry = tail[i]!;
    const previous = applyConfigPatch(state, entry.patch, "before", rules);
    if (!inTarget(entry)) {
      segment.push(entry);
      state = previous;
      continue;
    }
    for (const key of keys) {
      if (rules.same(state[key], anchor.get(key))) continue;
      const blamed = segment.filter((other) => other.patch.some((change) => change.key === key));
      for (const other of blamed.length > 0 ? blamed : segment.slice(0, 1)) {
        const conflict = conflicts.get(other.id) ?? { entry: other, keys: new Set<string>() };
        conflict.keys.add(key);
        conflicts.set(other.id, conflict);
      }
    }
    if (conflicts.size === 0) restored = applyConfigPatch(restored, entry.patch, "before", rules);
    state = previous;
    anchor = snapshot(state, keys);
    segment = [];
  }
  if (conflicts.size > 0) {
    const ordered = [...conflicts.values()].sort((a, b) => tail.indexOf(a.entry) - tail.indexOf(b.entry));
    throw configConflictError(target, doc, ordered);
  }
  return restored;
}

/** Where `tail` fails to account for every change up to `current`, as a phrase; null when it does. */
function configGap(current: ConfigState, tail: readonly ConfigJournalEntry[]): string | null {
  for (let i = 1; i < tail.length; i++) {
    const [previous, entry] = [tail[i - 1]!, tail[i]!];
    if (entry.hashBefore !== previous.hash) return `between ${previous.id} and ${entry.id}`;
  }
  const last = tail.at(-1)!;
  return configHash(current) === last.hash ? null : `after ${last.id}`;
}

function snapshot(state: ConfigState, keys: Set<string>): Map<string, unknown> {
  return new Map([...keys].map((key) => [key, state[key]]));
}

/** `found` oldest first. */
function configConflictError(target: string, doc: ConfigDoc, found: { entry: ConfigJournalEntry; keys: Set<string> }[]): RpcError {
  const conflicts: RevertConflict[] = found.map(({ entry, keys }) => ({
    id: entry.id,
    op: entry.op,
    author: entry.author,
    tx: entry.tx,
    ids: [...keys].sort(),
  }));
  const lines = conflicts.map((c) => `  ${c.id} ${c.op} by ${c.author} (${c.tx}) changed ${c.ids.join(", ")}`);
  const newestFirst = [...conflicts].reverse().map((c) => c.id);
  return new RpcError(
    ErrorCode.RevertConflict,
    `Cannot revert ${target} in ${CONFIG_DOC_NAMES[doc]}: later operations changed the same keys:\n${lines.join("\n")}\n` +
      `Revert them first (newest first: ${newestFirst.join(", ")}), or change it forward instead.`,
    { target, doc, conflicts, hint: `Revert ${newestFirst.join(", ")} first, newest first.` },
  );
}
