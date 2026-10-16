// Files and folders the OS asks the app to open (#184): launch arguments, a second launch, macOS open-file.
import { isAbsolute, resolve } from "node:path";

/**
 * Paths to open from a launch command line, absolute against `cwd`. `argv`
 * is `process.argv` (or a second instance's); the first `skip` entries are
 * the executable and, unpackaged, the main script. Flags are skipped, and so
 * is `--project <dir>`, which opens the window it starts with.
 */
export function launchPaths(argv: readonly string[], skip: number, cwd: string): string[] {
  const paths: string[] = [];
  for (let i = skip; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    if (arg === "--project") {
      i++;
      continue;
    }
    if (arg === "" || arg.startsWith("-")) continue;
    paths.push(isAbsolute(arg) ? arg : resolve(cwd, arg));
  }
  return paths;
}

/**
 * Collect paths arriving one by one (Finder sends one `open-file` per file
 * of a multi-file open) and hand them over together once none came for
 * `quietMs`, so several videos make one project.
 */
export function pathBatcher(flush: (paths: string[]) => void, quietMs = 300): (path: string) => void {
  let pending: string[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  return (path) => {
    pending.push(path);
    clearTimeout(timer);
    timer = setTimeout(() => {
      const paths = pending;
      pending = [];
      flush(paths);
    }, quietMs);
  };
}
