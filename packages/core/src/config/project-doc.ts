import type { FormatEntry } from "@frameshell/schema";
import type { ConfigRules, ConfigState } from "./patch.js";

/**
 * The `project` config document (ADR 0036): `formats` of `frameshell.json` as keyed state. Key `format:<id>`,
 * value the entry plus `index` (its position; 1 = right after the primary). The primary (index 0) equals
 * `resolution` and never changes, so it is never a key.
 */

/** Value of a `format:<id>` key. */
export interface FormatKeyValue extends FormatEntry {
  index: number;
}

/** Keyed state of a `formats` list as written (null or undefined: none, only the primary). */
export function formatState(formats: readonly FormatEntry[] | null | undefined): ConfigState {
  const state: Record<string, unknown> = {};
  (formats ?? []).forEach((format, index) => {
    if (index > 0) state[`format:${format.id}`] = { id: format.id, width: format.width, height: format.height, index };
  });
  return state;
}

/** The full list for keyed `state`: `primary` first, then the keyed formats by `index` (ties by id). */
export function formatsFromState(primary: FormatEntry, state: ConfigState): FormatEntry[] {
  return [{ ...primary }, ...ordered(state).map(({ id, width, height }) => ({ id, width, height }))];
}

/**
 * Rules of the `project` document. A format whose position moved because another was added or removed before it
 * did not change: only its id and size count. Setting a key inserts the format at its `index` (clamped), so a
 * revert of a removal puts it back where it was; positions are renumbered after each change.
 */
export const FORMAT_RULES: ConfigRules = {
  same(a, b) {
    const [x, y] = [a as FormatKeyValue | null | undefined, b as FormatKeyValue | null | undefined];
    if (!x || !y) return !x && !y;
    return x.id === y.id && x.width === y.width && x.height === y.height;
  },
  apply(state, changes) {
    const changed = new Set(changes.map((change) => change.key));
    const list = ordered(state).filter((format) => !changed.has(`format:${format.id}`));
    const inserted = changes
      .map((change) => change.value as FormatKeyValue | null | undefined)
      .filter((value): value is FormatKeyValue => value !== null && value !== undefined)
      .sort((a, b) => a.index - b.index);
    for (const format of inserted) list.splice(Math.min(Math.max(0, format.index - 1), list.length), 0, format);
    const next: Record<string, unknown> = {};
    list.forEach((format, position) => {
      next[`format:${format.id}`] = { id: format.id, width: format.width, height: format.height, index: position + 1 };
    });
    return next;
  },
};

function ordered(state: ConfigState): FormatKeyValue[] {
  return Object.entries(state)
    .filter(([key]) => key.startsWith("format:"))
    .map(([, value]) => value as FormatKeyValue)
    .sort((a, b) => a.index - b.index || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
