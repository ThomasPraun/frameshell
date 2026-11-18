import { lstat, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { AdapterGcContext, AdapterGcEntry } from "@frameshell/plugin-api";
import { STATE_DIR } from "./deps.js";
import { FINALS_FILE, FinalTimes } from "./finals.js";

/** A listing folder: `<.blend content hash, 16 hex>-<path hash, 8 hex>` (see `listingPath` in `deps.ts`). */
const LISTING_DIR = /^[0-9a-f]{16}-[0-9a-f]{8}$/;
/** `range/<inMs>-<endMs>ms.json` (before slice 6 `<endMs>ms.json`, still recognised so it goes) and `version/<major.minor[.patch]>.json`, the key markers `adapter.ts` writes. */
const RANGE_FILE = /^(?:\d+-)?\d+ms\.json$/;
const VERSION_FILE = /^\d+(?:\.\d+){1,2}\.json$/;

/**
 * Deletes the files the adapter keeps in {@link STATE_DIR} that no current clip names as an input (ADR 0035 slice 5):
 * listing folders of saved .blend versions, range markers of lengths no clip has, version markers of other Blenders.
 * `finals.json` is not deleted but pruned of the .blend files no clip names as an input (its `last` rate stays), and is
 * reported as one entry with the bytes it shrank by. Entries are recognised by name alone; anything else there (unknown
 * names, symlinks) stays, and so does whatever was modified at or after `keepNewerThan`, so a listing a key check writes
 * during `gc` survives. Returns what went (or, with `dryRun`, what would), sorted by path.
 */
export async function sweepState(context: AdapterGcContext): Promise<AdapterGcEntry[]> {
  const { projectDir, inputs } = context;
  const base = join(projectDir, ...STATE_DIR.split("/"));
  const removed: AdapterGcEntry[] = [];
  const drop = async (rel: string, folder: boolean): Promise<void> => {
    const found = await measure(join(projectDir, ...rel.split("/")), folder);
    if (!found || found.newest >= context.keepNewerThan) return;
    if (!context.dryRun) {
      const gone = await rm(join(projectDir, ...rel.split("/")), { recursive: folder, force: true }).then(
        () => true,
        () => false,
      );
      if (!gone) return;
    }
    removed.push({ path: folder ? `${rel}/` : rel, bytes: found.bytes });
  };
  for (const name of await names(base)) {
    const dir = `${STATE_DIR}/${name}`;
    if (LISTING_DIR.test(name) && !inputs.has(`${dir}/deps.json`) && !inputs.has(`${dir}/outside.json`)) await drop(dir, true);
  }
  for (const [folder, pattern] of [["range", RANGE_FILE], ["version", VERSION_FILE]] as const) {
    for (const name of await names(join(base, folder))) {
      const rel = `${STATE_DIR}/${folder}/${name}`;
      if (pattern.test(name) && !inputs.has(rel)) await drop(rel, false);
    }
  }
  const pruned = await new FinalTimes(projectDir).prune(inputs, { dryRun: context.dryRun, keepNewerThan: context.keepNewerThan }).catch(() => null);
  if (pruned) removed.push({ path: FINALS_FILE, bytes: pruned.bytes });
  return removed.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

async function names(dir: string): Promise<string[]> {
  return readdir(dir).catch(() => []);
}

/** Bytes and newest mtime of a plain file, or of a real folder and everything in it; null for a symlink or the wrong kind. */
async function measure(path: string, folder: boolean): Promise<{ bytes: number; newest: number } | null> {
  const info = await lstat(path).catch(() => null);
  if (!info || info.isSymbolicLink() || (folder ? !info.isDirectory() : !info.isFile())) return null;
  let found = { bytes: info.isFile() ? info.size : 0, newest: info.mtimeMs };
  if (info.isDirectory()) {
    for (const name of await names(path)) {
      const inner = await lstat(join(path, name)).catch(() => null);
      if (!inner || inner.isSymbolicLink()) continue;
      const child = inner.isDirectory() ? await measure(join(path, name), true) : { bytes: inner.size, newest: inner.mtimeMs };
      if (child) found = { bytes: found.bytes + child.bytes, newest: Math.max(found.newest, child.newest) };
    }
  }
  return found;
}
