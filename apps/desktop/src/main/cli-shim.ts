import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** What the shim runs. */
export interface CliShimTarget {
  /** Executable that runs JS: the Electron binary (as Node via `ELECTRON_RUN_AS_NODE`) or node. */
  runtime: string;
  /** Absolute path of the CLI's JS entry. */
  cliEntry: string;
}

/**
 * Write a `frameshell` command into `binDir` and return its path. Terminals
 * prepend `binDir` to PATH, so agents get the CLI matching this app without a
 * global install or a system Node. `ELECTRON_RUN_AS_NODE` is set only inside
 * the shim, never in the shell. Overwrites: app updates move the runtime.
 */
export async function writeCliShim(binDir: string, target: CliShimTarget, platform = process.platform): Promise<string> {
  await mkdir(binDir, { recursive: true });
  if (platform === "win32") {
    const file = join(binDir, "frameshell.cmd");
    const script = [
      "@echo off",
      "setlocal",
      "set ELECTRON_RUN_AS_NODE=1",
      `"${target.runtime}" "${target.cliEntry}" %*`,
      "",
    ].join("\r\n");
    await writeFile(file, script);
    return file;
  }
  const file = join(binDir, "frameshell");
  const script = `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ${shQuote(target.runtime)} ${shQuote(target.cliEntry)} "$@"\n`;
  await writeFile(file, script);
  await chmod(file, 0o755);
  return file;
}

function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
