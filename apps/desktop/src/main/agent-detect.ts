// Which agent CLI runs in a terminal (SPEC §6.2): the terminal's foreground command; matching is in @frameshell/protocol.
import { execFile } from "node:child_process";

/**
 * Command line of the foreground process group of the terminal whose shell
 * is `shellPid`, via `ps` (what a process set as its title, as Node CLIs do,
 * shows there). Null when the shell itself is in the foreground, on Windows
 * (no foreground process groups) or when `ps` fails.
 */
export async function foregroundCommand(shellPid: number): Promise<string[] | null> {
  if (process.platform === "win32") return null;
  const group = Number((await ps(["-o", "tpgid=", "-p", String(shellPid)]))?.trim());
  if (!Number.isInteger(group) || group <= 0 || group === shellPid) return null;
  const line = (await ps(["-ww", "-o", "args=", "-p", String(group)]))?.trim();
  return line ? line.split(/\s+/) : null;
}

function ps(args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("ps", args, { encoding: "utf8", timeout: 2000, env: { ...process.env, LC_ALL: "C" } }, (error, stdout) =>
      resolve(error ? null : stdout),
    );
  });
}
