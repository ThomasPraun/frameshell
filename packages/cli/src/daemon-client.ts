import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { type DaemonConnection, connectToDaemon, isDaemonUnavailable } from "@frameshell/protocol";

/** Options for {@link connectOrStartDaemon}. */
export interface ConnectOrStartOptions {
  socketPath: string;
  /** Handshake client id. */
  client: string;
  /** Environment for a spawned daemon; carries FRAMESHELL_SOCKET and idle timeout. */
  env: NodeJS.ProcessEnv;
  /** Give up waiting for a freshly spawned daemon after this long. */
  startTimeoutMs?: number;
}

/**
 * Connect to frameshelld, spawning it detached when nobody listens (SPEC §3.3).
 * Concurrent callers may each spawn one; the loser exits and all connect to the winner.
 */
export async function connectOrStartDaemon(options: ConnectOrStartOptions): Promise<DaemonConnection> {
  const { socketPath, client } = options;
  try {
    return await connectToDaemon(socketPath, { client });
  } catch (error) {
    if (!isDaemonUnavailable(error)) throw error;
  }

  spawnDaemon(options.env);
  const deadline = Date.now() + (options.startTimeoutMs ?? 10_000);
  let delayMs = 20;
  for (;;) {
    await new Promise((r) => setTimeout(r, delayMs));
    try {
      return await connectToDaemon(socketPath, { client });
    } catch (error) {
      if (!isDaemonUnavailable(error)) throw error;
      if (Date.now() > deadline) {
        throw new Error(`frameshelld did not start listening on ${socketPath} within ${options.startTimeoutMs ?? 10_000} ms`, {
          cause: error,
        });
      }
      delayMs = Math.min(delayMs * 2, 250);
    }
  }
}

function spawnDaemon(env: NodeJS.ProcessEnv): void {
  const entry = fileURLToPath(import.meta.resolve("@frameshell/core/frameshelld"));
  // Detached + ignored stdio: the daemon must outlive this CLI process.
  const child = spawn(process.execPath, [entry], { detached: true, stdio: "ignore", windowsHide: true, env });
  child.unref();
}
