import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { type DaemonConnection, connectToDaemon, isDaemonUnavailable } from "@frameshell/protocol";

/** Options for {@link connectOrStartDaemon}. */
export interface ConnectOrStartOptions {
  socketPath: string;
  /** Handshake client id. */
  client: string;
  /** Terminal session to attribute operations to; see `ConnectOptions.session`. */
  session?: string | undefined;
  /** Agent label to journal operations under; see `ConnectOptions.agent`. */
  agent?: string | null | undefined;
  /** Environment for a spawned daemon; carries FRAMESHELL_SOCKET and idle timeout. */
  env: NodeJS.ProcessEnv;
  /** Give up waiting for a freshly spawned daemon after this long. */
  startTimeoutMs?: number;
  /** Script run as frameshelld. Default: {@link defaultDaemonEntry}. */
  daemonEntry?: string;
  /**
   * Starts one daemon process. Default {@link spawnDetachedDaemon}, from this process. The desktop app passes one that
   * spawns from a helper process, so the daemon never holds the app's own stdio handles (Windows, #112).
   */
  launch?: DaemonLauncher;
}

/** What a {@link DaemonLauncher} starts: `execPath entry`, with `env`. */
export interface DaemonLaunch {
  /** Node-compatible executable. From Electron: the Electron binary, run as Node by `ELECTRON_RUN_AS_NODE=1` in `env`. */
  execPath: string;
  /** Script run as frameshelld. */
  entry: string;
  /** Daemon environment; carries FRAMESHELL_SOCKET and idle timeout. */
  env: NodeJS.ProcessEnv;
}

/** Starts one detached daemon process; see {@link ConnectOrStartOptions.launch}. */
export type DaemonLauncher = (launch: DaemonLaunch) => SpawnedDaemon;

/** A daemon process just started by a {@link DaemonLauncher}, watched until {@link SpawnedDaemon.release}. */
export interface SpawnedDaemon {
  /**
   * Settles only when the daemon dies before we let go of it: an Error when it failed (message carries its stderr),
   * `"clean-exit"` on exit 0 (lost a start race, or stopped idle). Never rejects.
   */
  readonly exited: Promise<Error | "clean-exit">;
  /** Daemon stderr captured so far, trimmed. */
  stderr(): string;
  /** Detach: stop watching so this process can exit while the daemon lives on. Idempotent. */
  release(): void;
}

/** Installed `@frameshell/core/frameshelld` script, resolved from this package. */
export function defaultDaemonEntry(): string {
  return fileURLToPath(import.meta.resolve("@frameshell/core/frameshelld"));
}

/** Daemons spawned per call at most: one that exits 0 unreached is replaced, a bounded number of times. */
const MAX_SPAWNS = 3;

/**
 * Connect to frameshelld, spawning it detached when nobody listens (SPEC §3.3).
 * Concurrent callers may each spawn one; the loser exits and all connect to the winner.
 *
 * A spawned daemon that exits cleanly while nobody listens (its idle timer
 * fired before this client reached it, or it lost a start race to a daemon
 * that has stopped since) is spawned again, up to {@link MAX_SPAWNS} daemons.
 *
 * Rejects with the daemon's own stderr when the spawned daemon exits with an
 * error before listening, instead of waiting out the start timeout.
 */
export async function connectOrStartDaemon(options: ConnectOrStartOptions): Promise<DaemonConnection> {
  const { socketPath, client, session, agent } = options;
  const connect = () => connectToDaemon(socketPath, { client, session, agent });
  try {
    return await connect();
  } catch (error) {
    if (!isDaemonUnavailable(error)) throw error;
  }

  const launch = options.launch ?? spawnDetachedDaemon;
  const entry = options.daemonEntry ?? defaultDaemonEntry();
  const startTimeoutMs = options.startTimeoutMs ?? 10_000;
  const deadline = Date.now() + startTimeoutMs;
  let lastError: unknown;
  for (let spawns = 0; spawns < MAX_SPAWNS; spawns++) {
    const daemon = launch({ execPath: process.execPath, entry, env: options.env });
    try {
      let delayMs = 20;
      for (;;) {
        // Wake on exit too: a daemon gone idle is replaced now, not after the next backoff.
        const outcome = await Promise.race([daemon.exited, sleep(delayMs)]);
        if (outcome instanceof Error) throw outcome;
        try {
          return await connect();
        } catch (error) {
          if (!isDaemonUnavailable(error)) throw error;
          lastError = error;
          if (outcome === "clean-exit") break;
          if (Date.now() > deadline) {
            const output = daemon.stderr();
            throw new Error(
              `frameshelld did not start listening on ${socketPath} within ${startTimeoutMs} ms` +
                (output ? `:\n${output}` : ""),
              { cause: error },
            );
          }
          // Capped well below short test idle timeouts (200 ms), so a ready daemon is reached before it stops.
          delayMs = Math.min(delayMs * 2, 100);
        }
      }
    } finally {
      daemon.release();
    }
  }
  throw new Error(
    `frameshelld exited before accepting a connection on ${socketPath}, ${MAX_SPAWNS} times in a row. ` +
      "Is FRAMESHELL_IDLE_TIMEOUT_MS near 0?",
    { cause: lastError },
  );
}

/**
 * Spawn frameshelld from this process, detached so it outlives it. stdin and stdout go nowhere; stderr is piped only
 * until {@link SpawnedDaemon.release}, to relay startup errors; `watch.onStderr` sees each chunk as it arrives.
 *
 * On Windows the child also inherits every inheritable handle of this process. Plain Node makes its own stdio
 * non-inheritable at startup; Electron's main process does not, so the app spawns through a helper process (#112).
 */
export function spawnDetachedDaemon(
  { execPath, entry, env }: DaemonLaunch,
  watch: { onStderr?(chunk: string): void } = {},
): SpawnedDaemon {
  const child = spawn(execPath, [entry], {
    detached: true,
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true,
    env,
  });
  child.unref();
  let output = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    output += chunk;
    watch.onStderr?.(chunk);
  });

  const exited = new Promise<Error | "clean-exit">((resolve) => {
    child.once("error", (error) => resolve(new Error(`Could not start frameshelld: ${error.message}`, { cause: error })));
    // "close", not "exit": fires after stderr is fully read.
    child.once("close", (code, signal) => {
      if (code === 0) return resolve("clean-exit");
      const reason = signal ? `killed by ${signal}` : `exit code ${code}`;
      resolve(new Error(`frameshelld failed to start (${reason})${output.trim() ? `:\n${output.trim()}` : ""}`));
    });
  });

  return {
    exited,
    stderr: () => output.trim(),
    release: () => {
      child.removeAllListeners();
      child.stderr.removeAllListeners("data");
      child.stderr.destroy();
    },
  };
}

function sleep(ms: number): Promise<undefined> {
  return new Promise((resolve) => setTimeout(() => resolve(undefined), ms));
}
