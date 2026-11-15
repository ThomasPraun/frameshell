// Tables of the colour grades (ADR 0031) the preview's program draws with: the same `gradeChainTable` export writes
// for `lut3d`, LUT files read through the project window.
import type { TimelineView } from "@frameshell/protocol";
import {
  type CubeLut,
  type GradeStage,
  type GradeTable,
  type NormalizedGrade,
  gradeChainKey,
  gradeChainLuts,
  gradeChainOf,
  gradeChainTable,
  parseCube,
} from "@frameshell/schema/grade";
import { useEffect, useMemo, useState } from "react";
import { flattenView } from "./program.js";

const EMPTY: ReadonlyMap<string, GradeTable> = new Map();

/** Tables kept across revisions: a slider drag makes a new one per value, the timeline uses a few. */
const KEPT_TABLES = 32;
const tables = new Map<string, GradeTable>();

/** A LUT file as read: parsed, or why it could not be. */
type LutRead = { lut: CubeLut } | { error: string };

/**
 * The distinct grade chains (`gradeChainOf`: a clip's own grade, then its nested hosts') of the pictures on the video
 * tracks of `view` flattened with the timelines it nests, by `gradeChainKey`: the chains export makes tables of.
 */
export function gradeChains(view: TimelineView, nested?: ReadonlyMap<string, TimelineView>): Map<string, NormalizedGrade[]> {
  const chains = new Map<string, NormalizedGrade[]>();
  for (const track of flattenView(view, nested).tracks) {
    if (track.kind !== "video") continue;
    for (const clip of track.clips) {
      const chain = gradeChainOf(clip);
      if (chain) chains.set(gradeChainKey(chain), chain);
    }
  }
  return chains;
}

/** The table of the grade chain with `key`, from the cache or made now from its `stages` (LUTs already parsed). */
export function tableOf(key: string, stages: readonly GradeStage[]): GradeTable {
  const known = tables.get(key);
  if (known) return known;
  const table = gradeChainTable(stages);
  tables.set(key, table);
  while (tables.size > KEPT_TABLES) tables.delete(tables.keys().next().value!);
  return table;
}

/**
 * Tables of the grade chains `view` and the timelines it nests draw with, by `gradeChainKey`. LUT files are read once
 * and again when they change on disk; a chain with a LUT not read yet or that cannot be used has no table: drawn
 * ungraded, with a console warning (export refuses it with the reason).
 */
export function useGradeTables(view: TimelineView | null, nested: ReadonlyMap<string, TimelineView>): ReadonlyMap<string, GradeTable> {
  const chains = useMemo(() => (view ? gradeChains(view, nested) : new Map<string, NormalizedGrade[]>()), [view, nested]);
  const paths = useMemo(() => [...new Set([...chains.values()].flatMap(gradeChainLuts))].sort(), [chains]);
  const [luts, setLuts] = useState<ReadonlyMap<string, LutRead>>(new Map());
  const [changed, setChanged] = useState(0);

  useEffect(() => {
    if (paths.length === 0) return;
    const watched = new Set(paths);
    return window.frameshell.files.onChanged((changes) => {
      if (changes.some((path) => watched.has(path))) setChanged((n) => n + 1);
    });
  }, [paths]);

  useEffect(() => {
    if (paths.length === 0) return;
    let disposed = false;
    void (async () => {
      const read = new Map<string, LutRead>();
      for (const path of paths) {
        try {
          read.set(path, { lut: parseCube(await window.frameshell.files.read(path)) });
        } catch (error) {
          read.set(path, { error: (error as Error).message });
        }
      }
      if (disposed) return;
      for (const [path, entry] of read) if ("error" in entry) console.warn(`Grade LUT ${path} cannot be used: ${entry.error}`);
      // Changed LUT content: tables made from the old one are stale.
      tables.clear();
      setLuts(read);
    })();
    return () => {
      disposed = true;
    };
  }, [paths, changed]);

  return useMemo(() => {
    if (chains.size === 0) return EMPTY;
    const ready = new Map<string, GradeTable>();
    for (const [key, chain] of chains) {
      const stages = chain.map((grade): GradeStage | null => {
        if (grade.lut === null || grade.lutMix <= 0) return { grade, lut: null };
        const read = luts.get(grade.lut);
        return read && "lut" in read ? { grade, lut: read.lut } : null;
      });
      if (stages.every((stage): stage is GradeStage => stage !== null)) ready.set(key, tableOf(key, stages));
    }
    return ready;
  }, [chains, luts]);
}
