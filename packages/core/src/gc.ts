import { lstat, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { GcEntry } from "@frameshell/protocol";

/**
 * Temp entries younger than this are never swept, even with no job running:
 * atomic writes outside jobs (energy envelopes) and a just-finished job's
 * cleanup may still own them.
 */
export const TEMP_MIN_AGE_MS = 60 * 60_000;

/**
 * How a sweep sees one directory entry: derived output of cache `key`, a temp
 * file of an interrupted write, or `null` for anything it does not recognize,
 * which is always kept.
 */
export type GcClass = { kind: Exclude<GcEntry["kind"], "temp">; key: string } | { kind: "temp"; key: null } | null;

/** Inputs of {@link sweep}. */
export interface SweepOptions {
  /** Project root. */
  root: string;
  /** Project-relative, `/`-separated directory to sweep (not recursive). */
  dir: string;
  classify(name: string, isDirectory: boolean): GcClass;
  /** True keeps every entry of `key`. */
  keep(key: string): boolean;
  /** Sweep temp entries older than {@link TEMP_MIN_AGE_MS}. False while a job that may own them runs. */
  temps: boolean;
  /** Only list. */
  dryRun: boolean;
  /** Keyed entries modified at or after this time (ms since epoch) are kept. Default: no floor. */
  keepNewerThan?: number;
  /**
   * Claim `key` for the deletion of one of its entries: resolves to a release
   * function, or null when the key is in use (the entry is then kept).
   */
  claim?(key: string): Promise<(() => void) | null>;
  /** Clock for the age checks. Default `Date.now`. */
  now?: () => number;
}

/**
 * Delete (or, with `dryRun`, list) the entries of one cache directory that
 * no current key needs. Symlinks and entries {@link SweepOptions.classify}
 * does not recognize are never touched. An entry that cannot be deleted
 * (Windows: open elsewhere) is left and not reported. Sorted by path.
 */
export async function sweep(options: SweepOptions): Promise<GcEntry[]> {
  const { root, dir, classify, keep, temps, dryRun } = options;
  const now = (options.now ?? Date.now)();
  const abs = join(root, ...dir.split("/"));
  const entries = await readdir(abs, { withFileTypes: true }).catch(() => []);
  const removed: GcEntry[] = [];
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const isDirectory = entry.isDirectory();
    if (!isDirectory && !entry.isFile()) continue;
    const found = classify(entry.name, isDirectory);
    if (!found) continue;
    const path = join(abs, entry.name);
    const info = await lstat(path).catch(() => null);
    if (!info) continue;
    if (found.key === null) {
      if (!temps || now - info.mtimeMs < TEMP_MIN_AGE_MS) continue;
    } else if (keep(found.key) || (options.keepNewerThan !== undefined && info.mtimeMs >= options.keepNewerThan)) {
      continue;
    }
    const release = found.key !== null && options.claim ? await options.claim(found.key) : () => {};
    if (!release) continue;
    try {
      const bytes = await sizeOf(path);
      if (!dryRun) {
        const gone = await rm(path, { recursive: isDirectory, force: true }).then(
          () => true,
          () => false,
        );
        if (!gone) continue;
      }
      removed.push({ path: `${dir}/${entry.name}${isDirectory ? "/" : ""}`, kind: found.kind, bytes });
    } finally {
      release();
    }
  }
  return removed;
}

/** Bytes of a file, or of every file under a directory; symlinks count as nothing. */
async function sizeOf(path: string): Promise<number> {
  const info = await lstat(path).catch(() => null);
  if (!info || info.isSymbolicLink()) return 0;
  if (!info.isDirectory()) return info.size;
  let total = 0;
  for (const name of await readdir(path).catch(() => [] as string[])) total += await sizeOf(join(path, name));
  return total;
}
