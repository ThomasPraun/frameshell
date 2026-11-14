// Tables of the colour grades (ADR 0031) the preview's program draws with: the same `gradeTable` export writes for
// `lut3d`, LUT files read through the project window.
import type { TimelineView } from "@frameshell/protocol";
import { type CubeLut, type GradeTable, type NormalizedGrade, gradeKey, gradeOf, gradeTable, parseCube } from "@frameshell/schema/grade";
import { useEffect, useMemo, useState } from "react";

const EMPTY: ReadonlyMap<string, GradeTable> = new Map();

/** Tables kept across revisions: a slider drag makes a new one per value, the timeline uses a few. */
const KEPT_TABLES = 32;
const tables = new Map<string, GradeTable>();

/** A LUT file as read: parsed, or why it could not be. */
type LutRead = { lut: CubeLut } | { error: string };

/** The distinct grades of the media clips on the video tracks of `views`, by `gradeKey`. */
export function gradesOf(views: readonly TimelineView[]): Map<string, NormalizedGrade> {
  const grades = new Map<string, NormalizedGrade>();
  for (const view of views) {
    for (const track of view.tracks) {
      if (track.kind !== "video") continue;
      for (const clip of track.clips) {
        const grade = gradeOf(clip);
        if (grade) grades.set(gradeKey(grade), grade);
      }
    }
  }
  return grades;
}

/** The table of `grade`, from the cache or made now (`lut` already parsed when it has one). */
export function tableOf(key: string, grade: NormalizedGrade, lut: CubeLut | null): GradeTable {
  const known = tables.get(key);
  if (known) return known;
  const table = gradeTable(grade, lut);
  tables.set(key, table);
  while (tables.size > KEPT_TABLES) tables.delete(tables.keys().next().value!);
  return table;
}

/**
 * Tables of the grades `view` and the timelines it nests draw with, by `gradeKey`. LUT files are read once and again
 * when they change on disk; a grade whose LUT is not read yet or cannot be used has no table: drawn ungraded, with a
 * console warning (export refuses it with the reason).
 */
export function useGradeTables(view: TimelineView | null, nested: ReadonlyMap<string, TimelineView>): ReadonlyMap<string, GradeTable> {
  const grades = useMemo(() => gradesOf(view ? [view, ...nested.values()] : []), [view, nested]);
  const paths = useMemo(() => [...new Set([...grades.values()].flatMap((grade) => (grade.lut !== null && grade.lutMix > 0 ? [grade.lut] : [])))].sort(), [grades]);
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
    if (grades.size === 0) return EMPTY;
    const ready = new Map<string, GradeTable>();
    for (const [key, grade] of grades) {
      const usesLut = grade.lut !== null && grade.lutMix > 0;
      const read = usesLut ? luts.get(grade.lut!) : undefined;
      if (usesLut && (!read || "error" in read)) continue;
      ready.set(key, tableOf(key, grade, read && "lut" in read ? read.lut : null));
    }
    return ready;
  }, [grades, luts]);
}
