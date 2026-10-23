import type { PersonInfo } from "@frameshell/protocol";
import { useEffect, useState } from "react";

/** Seconds a person speaks and is on screen in the main timeline; null when `people.ranges` could not tell. */
export interface PersonTotals {
  speaks: number | null;
  onscreen: number | null;
}

/**
 * Each person's seconds speaking and on screen in the main timeline (the `total` of `people.ranges`), read again
 * when the timeline `revision`, the transcripts (`sources`, by identity) or someone's links change. A slower answer
 * to an older change never replaces a newer one.
 */
export function usePersonTotals(people: readonly PersonInfo[], revision: number | null, sources: unknown): ReadonlyMap<string, PersonTotals> {
  const [totals, setTotals] = useState<ReadonlyMap<string, PersonTotals>>(new Map());
  const links = JSON.stringify(people.map((person) => [person.id, person.speakers, person.angles, person.faces]));
  useEffect(() => {
    if (revision === null) return;
    let live = true;
    const total = (person: string, kind: "speaks" | "onscreen") =>
      window.frameshell.people.ranges(person, kind).then(
        (result) => result.total,
        () => null,
      );
    void Promise.all(
      people.map(async (person) => [person.id, { speaks: await total(person.id, "speaks"), onscreen: await total(person.id, "onscreen") }] as const),
    ).then((entries) => {
      if (live) setTotals(new Map(entries));
    });
    return () => {
      live = false;
    };
    // `links` stands for `people`: a new array with the same links reads nothing new.
  }, [links, revision, sources]);
  return totals;
}
