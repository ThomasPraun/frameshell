import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sweepStaleTempDirs } from "../../../scripts/stale-temp-dirs.mjs";

/** Prefix of the run root; a root older than a day is from a killed run and swept at the next start. */
const ROOT_PREFIX = "fse-";
const VARS = ["TMPDIR", "TEMP", "TMP"] as const;

/**
 * Playwright global setup: point TMPDIR (TEMP/TMP on Windows) at one run root that workers, the launched app and
 * its daemon inherit, so every sandbox and app temp dir lands in it; the returned teardown removes it. The short
 * name keeps the sandboxes' unix socket paths under 104 bytes.
 */
export default async function setup(): Promise<() => Promise<void>> {
  // On the real tmpdir, before TMPDIR moves: a parallel run's young root is untouched.
  await sweepStaleTempDirs(tmpdir(), ROOT_PREFIX, Date.now());
  const saved = VARS.map((name) => [name, process.env[name]] as const);
  const root = mkdtempSync(join(tmpdir(), ROOT_PREFIX));
  for (const name of VARS) process.env[name] = root;
  return async () => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined);
  };
}
