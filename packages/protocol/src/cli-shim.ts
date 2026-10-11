/**
 * What a `frameshell` shim runs: the desktop app writes one on every start
 * (`<userData>/bin`), and `frameshell doctor` reads the one on PATH back.
 */
export interface CliShimTarget {
  /** Executable that runs JS: the Electron binary (as Node via `ELECTRON_RUN_AS_NODE`) or node. */
  runtime: string;
  /** Absolute path of the CLI's JS entry. */
  cliEntry: string;
}

/** File name of the shim: `frameshell.cmd` on Windows, `frameshell` elsewhere. */
export function cliShimName(platform: NodeJS.Platform): string {
  return platform === "win32" ? "frameshell.cmd" : "frameshell";
}

/**
 * Text of a shim running `target`. `ELECTRON_RUN_AS_NODE` is set only inside
 * the shim, never in the calling shell. {@link parseCliShim} reads it back.
 */
export function cliShimScript(target: CliShimTarget, platform: NodeJS.Platform): string {
  if (platform === "win32") {
    return ["@echo off", "setlocal", "set ELECTRON_RUN_AS_NODE=1", `"${target.runtime}" "${target.cliEntry}" %*`, ""].join("\r\n");
  }
  return `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ${shQuote(target.runtime)} ${shQuote(target.cliEntry)} "$@"\n`;
}

const POSIX_SHIM = /^ELECTRON_RUN_AS_NODE=1 exec ('(?:[^']|'\\'')*') ('(?:[^']|'\\'')*') "\$@"$/m;
const WINDOWS_SHIM = /^"([^"]*)" "([^"]*)" %\*\r?$/m;

/** The target of a shim {@link cliShimScript} wrote, either platform's form; null for any other file. */
export function parseCliShim(text: string): CliShimTarget | null {
  const posix = POSIX_SHIM.exec(text);
  if (posix) return { runtime: shUnquote(posix[1]!), cliEntry: shUnquote(posix[2]!) };
  if (!/^set ELECTRON_RUN_AS_NODE=1\r?$/m.test(text)) return null;
  const windows = WINDOWS_SHIM.exec(text);
  return windows ? { runtime: windows[1]!, cliEntry: windows[2]! } : null;
}

function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function shUnquote(quoted: string): string {
  return quoted.slice(1, -1).replace(/'\\''/g, "'");
}
