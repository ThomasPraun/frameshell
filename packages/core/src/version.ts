// The version frameshelld reports (#739). Workspace packages stay at 0.0.0; a release stamps its version only into
// the desktop app's own package.json (`extraMetadata.version`), which sits three folders above this package inside
// the packaged app (`app.asar/node_modules/@frameshell/core`). The daemon reports that one when it runs from an app.
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** The desktop app's package name: only its package.json carries a release version. */
const APP_PACKAGE = "@frameshell/desktop";

/** Reads a package.json; null when it is missing or unreadable. */
export type ReadPackage = (path: string) => { name?: unknown; version?: unknown } | null;

/**
 * The version of the core package at `coreDir`: its own, or, when that is the workspace placeholder `0.0.0` and the
 * package sits inside a packaged desktop app, the app's stamped version.
 */
export function coreVersion(coreDir: string, read: ReadPackage = readPackage): string {
  const own = read(join(coreDir, "package.json"));
  const version = typeof own?.version === "string" ? own.version : "0.0.0";
  if (version !== "0.0.0") return version;
  const app = read(join(coreDir, "..", "..", "..", "package.json"));
  return app?.name === APP_PACKAGE && typeof app.version === "string" && app.version !== "" ? app.version : version;
}

function readPackage(path: string): { name?: unknown; version?: unknown } | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as { name?: unknown; version?: unknown };
  } catch {
    return null;
  }
}
