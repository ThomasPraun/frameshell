// How the plugin store runs npm (#204): under a system Node, or inside the packaged app, which ships npm and has no
// Node of its own: the daemon there is the app's executable run as Node (ELECTRON_RUN_AS_NODE).
import { createHash } from "node:crypto";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const NPM_CLI = ["npm", "bin", "npm-cli.js"];

/**
 * Where npm's entry script may be for a runtime whose executable is in
 * `bin`, in lookup order: npm installed with a system Node (Windows, then
 * Unix layout), then the npm the app ships in its resources (`extraResources`
 * in `apps/desktop/electron-builder.yml`; macOS `Contents/Resources`,
 * Windows and Linux `resources`).
 */
export function npmCliCandidates(bin: string): string[] {
  return [
    join(bin, "node_modules", ...NPM_CLI),
    join(bin, "..", "lib", "node_modules", ...NPM_CLI),
    join(bin, "..", "Resources", ...NPM_CLI),
    join(bin, "resources", ...NPM_CLI),
  ];
}

/** Content of a `node` command that runs `runtime` (the app's executable) as Node. */
export function nodeShimScript(runtime: string, platform: NodeJS.Platform): string {
  if (platform === "win32") return ["@echo off", "set ELECTRON_RUN_AS_NODE=1", `"${runtime}" %*`, ""].join("\r\n");
  return `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec '${runtime.replace(/'/g, `'\\''`)}' "$@"\n`;
}

/**
 * Environment for npm run by `runtime` when that is the app's executable:
 * `ELECTRON_RUN_AS_NODE` set, and a `node` command first on `PATH` (written
 * once per runtime under the temp dir), since lifecycle scripts of
 * dependencies call `node` and the machine may have none.
 */
export async function electronNpmEnv(runtime: string, env: NodeJS.ProcessEnv, platform = process.platform): Promise<NodeJS.ProcessEnv> {
  const dir = join(tmpdir(), `frameshell-node-${createHash("sha256").update(runtime).digest("hex").slice(0, 12)}`);
  await mkdir(dir, { recursive: true });
  const shim = join(dir, platform === "win32" ? "node.cmd" : "node");
  await writeFile(shim, nodeShimScript(runtime, platform));
  if (platform !== "win32") await chmod(shim, 0o755);
  // Windows keeps the variable as `Path`; writing `PATH` beside it would leave two.
  const key = Object.keys(env).find((name) => name.toUpperCase() === "PATH") ?? "PATH";
  const separator = platform === "win32" ? ";" : ":";
  return { ...env, ELECTRON_RUN_AS_NODE: "1", [key]: env[key] ? `${dir}${separator}${env[key]}` : dir };
}
