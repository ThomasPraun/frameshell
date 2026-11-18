import { appendFileSync, mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, inject } from "vitest";

// Each test file gets its own temp dir as TMPDIR (TEMP/TMP on Windows), removed after the file. Every `tmpdir()`
// in tests, product code under test and spawned daemons lands inside it, so no test needs its own cleanup.
// One short level only: tests put unix sockets under temp dirs and sun_path caps at 104 bytes on macOS.
const VARS = ["TMPDIR", "TEMP", "TMP"] as const;
const saved = VARS.map((name) => [name, process.env[name]] as const);
// Twin of FILE_TEMP_PREFIX in vitest.global-setup.ts (importing it would load core into every file).
const dir = mkdtempSync(join(tmpdir(), "fsv-"));
for (const name of VARS) process.env[name] = dir;
// A daemon a test left running may write here after the file ends: the global teardown sweeps listed dirs again.
appendFileSync(inject("tempDirRegistry"), `${dir}\n`);

afterAll(async () => {
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  // Windows keeps files of exiting processes locked a while: the global teardown retries.
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined);
});
