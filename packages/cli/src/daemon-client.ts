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
}

/**
 * Connect to frameshelld, spawning it detached when nobody listens (SPEC §3.3).
 * Concurrent callers may each spawn one; the loser exits and all connect to the winner.
 *
 * Rejects with the daemon's own stderr when the spawned daemon exits with an
 * error before listening, instead of waiting out the start timeout.
 */
export async function connectOrStartDaemon(options: ConnectOrStartOptions): Promise<DaemonConnection> {
  const { socketPath, client, session, agent } = options;
  try {
    return await connectToDaemon(socketPath, { client, session, agent });
  } catch (error) {
    if (!isDaemonUnavailable(error)) throw error;
  }

  const startTimeoutMs = options.startTimeoutMs ?? 10_000;
  const daemon = spawnDaemon(options.env);
  try {
    const deadline = Date.now() + startTimeoutMs;
    let delayMs = 20;
    for (;;) {
      const failure = await Promise.race([daemon.failure, sleep(delayMs)]);
      if (failure) throw failure;
      try {
        return await connectToDaemon(socketPath, { client, session, agent });
      } catch (error) {
        if (!isDaemonUnavailable(error)) throw error;
        if (Date.now() > deadline) {
          const output = daemon.stderr();
          throw new Error(
            `frameshelld did not start listening on ${socketPath} within ${startTimeoutMs} ms` +
              (output ? `:\n${output}` : ""),
            { cause: error },
          );
        }
        delayMs = Math.min(delayMs * 2, 250);
      }
    }
  } finally {
    daemon.release();
  }
}

interface SpawnedDaemon {
  /** Resolves only when the daemon dies with an error before we let go of it. Exit 0 = lost the start race: not a failure. */
  readonly failure: Promise<Error>;
  /** Daemon stderr captured so far, trimmed. */
  stderr(): string;
  /** Detach: stop reading stderr so this process can exit while the daemon lives on. */
  release(): void;
}

function spawnDaemon(env: NodeJS.ProcessEnv): SpawnedDaemon {
  const entry = fileURLToPath(import.meta.resolve("@frameshell/core/frameshelld"));
  // Detached so the daemon outlives this CLI; stderr piped only until it listens, to relay startup errors.
  const child = spawn(process.execPath, [entry], {
    detached: true,
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true,
    env,
  });
  child.unref();
  let output = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => (output += chunk));

  const failure = new Promise<Error>((resolve) => {
    child.once("error", (error) => resolve(new Error(`Could not start frameshelld: ${error.message}`, { cause: error })));
    // "close", not "exit": fires after stderr is fully read.
    child.once("close", (code, signal) => {
      if (code === 0) return;
      const reason = signal ? `killed by ${signal}` : `exit code ${code}`;
      resolve(new Error(`frameshelld failed to start (${reason})${output.trim() ? `:\n${output.trim()}` : ""}`));
    });
  });

  return {
    failure,
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
