import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

/** Isolated endpoint per test: named pipe on Windows, short unix socket path elsewhere. */
export function uniqueSocketPath(): string {
  const id = randomUUID().slice(0, 8);
  return process.platform === "win32"
    ? `\\\\.\\pipe\\frameshell-test-${id}`
    : join(realpathSync(tmpdir()), `fs-test-${id}.sock`);
}

/** Fresh empty directory; realpath so macOS /var vs /private/var never differs. */
export function tempDir(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "frameshell-test-")));
}
