import { type DaemonLaunch, type DaemonLauncher, type SpawnedDaemon, spawnDetachedDaemon } from "@frameshell/cli";

// Why a helper process (#112): on Windows a spawned child inherits every inheritable handle of its parent. Electron's
// main process leaves its stdio handles inheritable, so a daemon spawned from it holds the pipes of whoever reads the
// app's output (Playwright, a terminal) until it idles out. A utility process marks its stdio non-inheritable, gets
// only the handles Chromium hands it, and runs with stdio "ignore": a daemon it spawns holds none of the app's pipes.
// Electron-free on purpose: `index.ts` binds it to `utilityProcess`, tests to an in-memory channel.

/** Main process to helper. */
export type ToSpawner = { kind: "start"; launch: DaemonLaunch } | { kind: "release" };

/** Helper to main process. `error: null` = the daemon exited 0 before release. */
export type FromSpawner = { kind: "stderr"; text: string } | { kind: "exited"; error: string | null };

/** The helper's end of the channel; shape of Electron's `process.parentPort`. */
export interface SpawnerPort {
  on(event: "message", listener: (event: { data: ToSpawner }) => void): unknown;
  postMessage(message: FromSpawner): void;
}

/** Main process view of one helper; the subset of Electron's `UtilityProcess` used. */
export interface SpawnerProcess {
  on(event: "message", listener: (message: FromSpawner) => void): unknown;
  on(event: "exit", listener: (code: number) => void): unknown;
  postMessage(message: ToSpawner): void;
}

/**
 * Helper side: on `start`, spawn the detached daemon and relay its stderr and early exit; on `release`, let go of it
 * and call `exit`, leaving the daemon running.
 */
export function serveDaemonSpawner(
  port: SpawnerPort,
  exit: () => void,
  spawn: typeof spawnDetachedDaemon = spawnDetachedDaemon,
): void {
  let daemon: SpawnedDaemon | undefined;
  port.on("message", ({ data }) => {
    if (data.kind === "release") {
      daemon?.release();
      exit();
      return;
    }
    if (daemon) return;
    const spawned = spawn(data.launch, { onStderr: (text) => port.postMessage({ kind: "stderr", text }) });
    daemon = spawned;
    void spawned.exited.then((outcome) =>
      port.postMessage({ kind: "exited", error: outcome === "clean-exit" ? null : outcome.message }),
    );
  });
}

/**
 * Main side: a {@link DaemonLauncher} that starts each daemon from a fresh helper made by `fork`, so the daemon never
 * inherits this process's handles. A helper that dies before release counts as a failed daemon start.
 */
export function helperDaemonLauncher(fork: () => SpawnerProcess): DaemonLauncher {
  return (launch) => {
    let helper: SpawnerProcess | undefined;
    let output = "";
    let released = false;
    let settle!: (outcome: Error | "clean-exit") => void;
    const exited = new Promise<Error | "clean-exit">((resolve) => (settle = resolve));
    const handle: SpawnedDaemon = {
      exited,
      stderr: () => output.trim(),
      release: () => {
        if (released) return;
        released = true;
        try {
          helper?.postMessage({ kind: "release" });
        } catch {
          // Helper already gone: nothing to let go of.
        }
      },
    };
    try {
      helper = fork();
    } catch (error) {
      settle(new Error(`Could not start the frameshelld launcher: ${(error as Error).message}`, { cause: error }));
      return handle;
    }
    helper.on("message", (message) => {
      if (released) return;
      if (message.kind === "stderr") output += message.text;
      else settle(message.error === null ? "clean-exit" : new Error(message.error));
    });
    helper.on("exit", (code) => {
      if (released) return;
      const tail = output.trim();
      settle(new Error(`frameshelld launcher exited (code ${code}) before the daemon listened${tail ? `:\n${tail}` : ""}`));
    });
    helper.postMessage({ kind: "start", launch });
    return handle;
  };
}
