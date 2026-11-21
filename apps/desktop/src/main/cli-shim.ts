import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type CliShimTarget, cliShimName, cliShimScript } from "@frameshell/protocol";

/**
 * Write a `frameshell` command into `binDir` and return its path. Terminals
 * prepend `binDir` to PATH, so agents get the CLI matching this app without a
 * global install or a system Node. Overwrites: app updates move the runtime.
 * The format is shared with `frameshell doctor`, which reads it back.
 *
 * On Windows the command is `frameshell.cmd` (PowerShell, cmd), plus an
 * extensionless `sh` twin for the Git Bash that agents such as Claude Code run
 * their commands in, which never finds a `.cmd` by its bare name (#743). The
 * twin names the same runtime with `/` separators, which Git Bash runs.
 */
export async function writeCliShim(binDir: string, target: CliShimTarget, platform = process.platform): Promise<string> {
  await mkdir(binDir, { recursive: true });
  const file = join(binDir, cliShimName(platform));
  await writeFile(file, cliShimScript(target, platform));
  if (platform !== "win32") await chmod(file, 0o755);
  else await writeFile(join(binDir, cliShimName("linux")), gitBashShim(target));
  return file;
}

/** The `sh` shim Git Bash runs on Windows: {@link cliShimScript}'s POSIX form with `/` in the Windows paths. */
export function gitBashShim(target: CliShimTarget): string {
  const slashes = (path: string) => path.replace(/\\/g, "/");
  return cliShimScript({ runtime: slashes(target.runtime), cliEntry: slashes(target.cliEntry) }, "linux");
}
