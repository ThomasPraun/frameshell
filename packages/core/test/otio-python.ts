import { execFileSync } from "node:child_process";

/**
 * Runs `script` in the first Python interpreter that can run it with `path` as `sys.argv[1]`, and parses what it prints
 * as JSON. Shared by the opt-in reader tests of the OTIO export (`otio-real.test.ts`) and of the Premiere XML export
 * (`premiere-real.test.ts`). `FRAMESHELL_TEST_PYTHON` picks the interpreter first; throws with what each one said, and
 * with `install`, the pip line that makes one work.
 */
export function readWithPython<T>(script: string, path: string, install: string): T {
  const candidates = [process.env["FRAMESHELL_TEST_PYTHON"], "python3", "python", "py -3"].filter((candidate): candidate is string => Boolean(candidate));
  const failures: string[] = [];
  for (const candidate of candidates) {
    const [command, ...prefix] = candidate.split(" ");
    try {
      return JSON.parse(execFileSync(command!, [...prefix, "-I", "-c", script, path], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })) as T;
    } catch (error) {
      failures.push(`${candidate}: ${(error as Error).message.split("\n").slice(-2).join(" ").trim()}`);
    }
  }
  throw new Error(`no Python can read the file (${install}):\n${failures.join("\n")}`);
}
