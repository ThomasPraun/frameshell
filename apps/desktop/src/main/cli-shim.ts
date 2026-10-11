import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type CliShimTarget, cliShimName, cliShimScript } from "@frameshell/protocol";

/**
 * Write a `frameshell` command into `binDir` and return its path. Terminals
 * prepend `binDir` to PATH, so agents get the CLI matching this app without a
 * global install or a system Node. Overwrites: app updates move the runtime.
 * The format is shared with `frameshell doctor`, which reads it back.
 */
export async function writeCliShim(binDir: string, target: CliShimTarget, platform = process.platform): Promise<string> {
  await mkdir(binDir, { recursive: true });
  const file = join(binDir, cliShimName(platform));
  await writeFile(file, cliShimScript(target, platform));
  if (platform !== "win32") await chmod(file, 0o755);
  return file;
}
