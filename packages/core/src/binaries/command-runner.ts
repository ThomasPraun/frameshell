import { spawn } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";

/**
 * Runs one machine command (a probe like `nvidia-smi -L`, or an installed
 * executable's start check by absolute path) to completion. Rejects with the
 * output tail when it exits non-zero, or with `code: "ENOENT"` when the
 * command is not installed.
 */
export type CommandRunner = (command: string, args: readonly string[], options: { cwd: string }) => Promise<void>;

/** Output lines kept for error messages. */
const TAIL_LINES = 30;

/** {@link CommandRunner} spawning the command from PATH or its absolute path; no shell. */
export const runCommand: CommandRunner = (command, args, { cwd }) =>
  new Promise((resolve, reject) => {
    const file = isAbsolute(command) ? command : findOnPath(command);
    if (!file) {
      reject(Object.assign(new Error(`${command} not found on PATH`), { code: "ENOENT" }));
      return;
    }
    const child = spawn(file, [...args], { cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const tail: string[] = [];
    const collect = (chunk: Buffer) => {
      tail.push(...chunk.toString("utf8").split(/\r?\n/).filter(Boolean));
      tail.splice(0, Math.max(0, tail.length - TAIL_LINES));
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) return resolve();
      const reason = signal ? `was killed by ${signal}` : `exited with code ${code}`;
      reject(new Error(`\`${command} ${args.join(" ")}\` ${reason}:\n${tail.join("\n")}`));
    });
  });

/**
 * First executable file named `command` (`command.exe` first on Windows) in the folders of `env`'s PATH, or null.
 * `windows` picks the PATH separator and the `.exe` name, so a test can ask as another platform would.
 */
export function findOnPath(command: string, env: NodeJS.ProcessEnv = process.env, windows = process.platform === "win32"): string | null {
  // A copied Windows environment is case-sensitive and usually spells it `Path`.
  const dirs = (env["PATH"] ?? env["Path"] ?? "").split(windows ? ";" : ":").filter(Boolean);
  const names = windows ? [`${command}.exe`, command] : [command];
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = join(dir, name);
      try {
        if (!statSync(candidate).isFile()) continue;
        if (!windows) accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {
        // Next candidate.
      }
    }
  }
  return null;
}
