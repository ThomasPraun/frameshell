#!/usr/bin/env node
// frameshelld entry. Usually spawned detached by the CLI or app, not by hand.
// Env: FRAMESHELL_SOCKET (endpoint), FRAMESHELL_IDLE_TIMEOUT_MS (ms, "Infinity" disables).
// Startup errors go to stderr: the spawning CLI relays them to the user.
import { resolveSocketPath } from "@frameshell/protocol";
import { DEFAULT_IDLE_TIMEOUT_MS, startDaemon } from "../daemon.js";

// The spawning CLI closes its end of the stderr pipe once connected; later writes must not crash us.
process.stderr.on("error", () => {});

try {
  const socketPath = resolveSocketPath();
  const idleTimeoutMs = parseIdleTimeout(process.env["FRAMESHELL_IDLE_TIMEOUT_MS"]);
  const daemon = await startDaemon({ socketPath, idleTimeoutMs });
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => void daemon.close());
  await daemon.closed;
  process.exit(0);
} catch (error) {
  // Lost a start race to another client: that daemon serves everyone.
  if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") process.exit(0);
  console.error(`frameshelld: ${(error as Error).message}`);
  // exitCode, not exit(): lets the stderr pipe flush (async on macOS).
  process.exitCode = 1;
}

/** Unset = default. NaN or negative would silently disable the timeout and leak a daemon, so fail instead. */
function parseIdleTimeout(raw: string | undefined): number {
  if (raw === undefined || raw === "") return DEFAULT_IDLE_TIMEOUT_MS;
  const ms = Number(raw);
  if (Number.isNaN(ms) || ms < 0) {
    throw new Error(`FRAMESHELL_IDLE_TIMEOUT_MS must be milliseconds >= 0 or "Infinity", got "${raw}"`);
  }
  return ms;
}
