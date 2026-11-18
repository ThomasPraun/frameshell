import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestProject } from "vitest/node";
import { mediaTools } from "./packages/core/test/media-tools.js";

declare module "vitest" {
  export interface ProvidedContext {
    /** File where `vitest.temp-dir.ts` lists each test file's temp dir, one path per line. */
    tempDirRegistry: string;
  }
}

/** Prefix of the per-test-file temp dir `vitest.temp-dir.ts` makes and removes. */
export const FILE_TEMP_PREFIX = "fsv-";
/** Dirs older than this are from a killed run and removed; younger ones may belong to a parallel run. */
const STALE_MS = 24 * 60 * 60 * 1000;
/** Names of temp dirs tests and the product make; any that escape a test file's dir show up in the warning. */
const LEAK_PATTERN = /^(frameshell-|fs-|fsv-)/;

/**
 * Install the managed ffmpeg once before any worker starts, so parallel media tests never race a download. Sweep
 * per-file temp dirs a killed run left behind. Teardown removes this run's per-file dirs again (a daemon a test
 * left running may have written after the file ended) and warns about temp dirs that appeared during the run.
 */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  await mediaTools();
  const system = tmpdir();
  const started = Date.now();
  const stale = readdirSync(system).filter((name) => name.startsWith(FILE_TEMP_PREFIX) && !modifiedSince(join(system, name), started - STALE_MS));
  await Promise.all(stale.map((name) => remove(join(system, name))));
  const registry = join(system, `${FILE_TEMP_PREFIX}run-${process.pid}.txt`);
  writeFileSync(registry, "");
  project.provide("tempDirRegistry", registry);
  const before = new Set(readdirSync(system));
  return async () => {
    const dirs = readFileSync(registry, "utf8").split("\n").filter(Boolean);
    await Promise.all([...dirs, registry].map(remove));
    const escaped = readdirSync(system).filter((name) => LEAK_PATTERN.test(name) && !before.has(name) && modifiedSince(join(system, name), started));
    if (escaped.length === 0) return;
    console.warn(
      `[temp dirs] ${escaped.length} dir(s) appeared in ${system} during the run and are still there ` +
        `(maybe another process's): ${escaped.slice(0, 5).join(", ")}${escaped.length > 5 ? ", ..." : ""}`,
    );
  };
}

function remove(path: string): Promise<void> {
  return rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined);
}

function modifiedSince(path: string, since: number): boolean {
  try {
    return statSync(path).mtimeMs >= since;
  } catch {
    return false;
  }
}
