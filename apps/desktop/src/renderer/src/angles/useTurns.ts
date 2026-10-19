import { useEffect, useMemo, useState } from "react";
import { SELECTION_TIMELINE } from "../selection.js";
import { type SpeakingTurn, sameTurns } from "./model.js";

/** Turns of one group as last measured. */
export interface GroupTurns {
  turns: readonly SpeakingTurn[];
  /** The daemon's message when measuring failed; the turns are then empty. */
  error: string | null;
}

const NONE: GroupTurns = { turns: [], error: null };

interface Entry extends GroupTurns {
  key: string;
}

/**
 * Speaking turns (`multicam.turns`) of each group in `wanted` (group id to the key of what they depend on,
 * see `turnsKey`), measured again whenever a key changes. Shots do not change turns, so editing the program
 * never measures. A group with no result yet, or a failed one, has no turns. With `keepStale` the turns of
 * the previous key stay until the new ones arrive (a lane that redraws with the old marks, not empty ones).
 */
export function useGroupsTurns(wanted: ReadonlyMap<string, string>, keepStale = false): ReadonlyMap<string, GroupTurns> {
  const [found, setFound] = useState<ReadonlyMap<string, Entry>>(new Map());
  const signature = JSON.stringify([...wanted]);
  useEffect(() => {
    let disposed = false;
    for (const [group, key] of JSON.parse(signature) as [string, string][]) {
      window.frameshell.multicam.turns(SELECTION_TIMELINE, group).then(
        (result) => {
          if (disposed) return;
          setFound((current) => {
            const before = current.get(group);
            if (before && before.key === key && before.error === null && sameTurns(before.turns, result.turns)) return current;
            return new Map(current).set(group, { key, turns: result.turns, error: null });
          });
        },
        (error: Error) => {
          if (!disposed) setFound((current) => new Map(current).set(group, { key, turns: [], error: error.message }));
        },
      );
    }
    return () => {
      disposed = true;
    };
  }, [signature]);
  return useMemo(() => {
    const shown = new Map<string, GroupTurns>();
    for (const [group, key] of wanted) {
      const entry = found.get(group);
      shown.set(group, entry && (keepStale || entry.key === key) ? { turns: entry.turns, error: entry.error } : NONE);
    }
    return shown;
    // `wanted` is a new Map on every render; its content is `signature`.
  }, [found, signature, keepStale]);
}

/** {@link useGroupsTurns} for one group; none while `group` or `key` is null. */
export function useTurns(group: string | null, key: string | null): GroupTurns {
  const wanted = useMemo(() => (group !== null && key !== null ? new Map([[group, key]]) : new Map<string, string>()), [group, key]);
  return useGroupsTurns(wanted).get(group ?? "") ?? NONE;
}
