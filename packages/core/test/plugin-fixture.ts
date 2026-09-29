import { execFileSync } from "node:child_process";
import { cpSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tempDir } from "./helpers.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/hello-plugin/", import.meta.url));

/** Local git repo holding a copy of the hello-plugin fixture. */
export interface GitPlugin {
  /** Install spec: `git+file://…`. No network involved. */
  spec: string;
  /** Commit the repo's HEAD points at. */
  sha: string;
  dir: string;
}

/**
 * Commit the hello-plugin fixture to a fresh local git repo.
 * `manifest` is shallow-merged into `frameshell-plugin.json` to build broken variants.
 */
export function gitPluginFixture(manifest: Record<string, unknown> = {}): GitPlugin {
  const dir = join(tempDir(), "hello-plugin");
  cpSync(FIXTURE, dir, { recursive: true });
  const manifestPath = join(dir, "frameshell-plugin.json");
  const merged = { ...JSON.parse(readFileSync(manifestPath, "utf8")), ...manifest };
  writeFileSync(manifestPath, `${JSON.stringify(merged, null, 2)}\n`);
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args], {
      cwd: dir,
      encoding: "utf8",
    }).trim();
  git("init", "-q");
  git("add", "-A");
  git("commit", "-q", "-m", "fixture");
  return { spec: `git+${pathToFileURL(dir).href}`, sha: git("rev-parse", "HEAD"), dir };
}
