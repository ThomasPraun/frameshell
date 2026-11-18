import { readdirSync, statSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";

/** Run roots older than this are from a killed run and removed; younger ones may belong to a parallel run. */
export const STALE_TEMP_MS = 24 * 60 * 60 * 1000;

/**
 * Remove the entries of `dir` whose name starts with `prefix` and that were last modified more than `staleMs`
 * before `now`. Shared by the vitest and Playwright global setups, which each sweep what a killed run left behind.
 * @param {string} dir
 * @param {string} prefix
 * @param {number} now epoch milliseconds
 * @param {number} [staleMs]
 * @returns {Promise<string[]>} names swept (a removal that fails is not reported)
 */
export async function sweepStaleTempDirs(dir, prefix, now, staleMs = STALE_TEMP_MS) {
  let names;
  try {
    names = readdirSync(dir).filter((name) => name.startsWith(prefix));
  } catch {
    return [];
  }
  const stale = names.filter((name) => !modifiedSince(join(dir, name), now - staleMs));
  await Promise.all(
    stale.map((name) => rm(join(dir, name), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined)),
  );
  return stale;
}

/** An entry that cannot be read counts as not modified, so it is swept (`rm` with `force` ignores a missing one). */
function modifiedSince(path, since) {
  try {
    return statSync(path).mtimeMs >= since;
  } catch {
    return false;
  }
}
