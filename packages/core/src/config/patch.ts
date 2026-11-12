import { isDeepStrictEqual } from "node:util";
import type { ConfigPatchEntry } from "@frameshell/protocol";
import { contentHash } from "../history/hash.js";

/**
 * Keyed state of a project-config document (ADR 0036): entity key (`format:<id>`) to its JSON value. A key
 * that is absent has no entry; patches write it as null.
 */
export type ConfigState = Readonly<Record<string, unknown>>;

/** How one config document compares and writes key values. */
export interface ConfigRules {
  /** Whether two values of a key are the same change (absent = undefined). Patches and conflicts skip the rest. */
  same(a: unknown, b: unknown): boolean;
  /** `state` with each key set to its value; null removes it. */
  apply(state: ConfigState, changes: readonly { key: string; value: unknown }[]): ConfigState;
}

/** Rules of a document whose keys are independent leaves: deep equality, set or delete. */
export const PLAIN_RULES: ConfigRules = {
  same: (a, b) => isDeepStrictEqual(a ?? null, b ?? null),
  apply(state, changes) {
    const next: Record<string, unknown> = { ...state };
    for (const { key, value } of changes) {
      if (value === null || value === undefined) delete next[key];
      else next[key] = value;
    }
    return next;
  },
};

/** Every key whose value differs between `before` and `after` by `rules`, sorted by key. */
export function diffConfig(before: ConfigState, after: ConfigState, rules: ConfigRules = PLAIN_RULES): ConfigPatchEntry[] {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  return keys.filter((key) => !rules.same(before[key], after[key])).map((key) => ({ key, before: before[key] ?? null, after: after[key] ?? null }));
}

/** `state` with each key of `patch` set to its `side` value. */
export function applyConfigPatch(state: ConfigState, patch: readonly ConfigPatchEntry[], side: "before" | "after", rules: ConfigRules = PLAIN_RULES): ConfigState {
  return rules.apply(
    state,
    patch.map((entry) => ({ key: entry.key, value: entry[side] })),
  );
}

/** Hash of a keyed state, chained by the config journal like a timeline's content hash. */
export function configHash(state: ConfigState): string {
  return contentHash(state);
}
