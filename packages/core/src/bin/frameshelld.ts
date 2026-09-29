#!/usr/bin/env node
// frameshelld entry. Usually spawned detached by the CLI or app, not by hand.
// Env: FRAMESHELL_SOCKET (endpoint), FRAMESHELL_IDLE_TIMEOUT_MS (ms, "Infinity" disables).
import { resolveSocketPath } from "@frameshell/protocol";
import { DEFAULT_IDLE_TIMEOUT_MS, startDaemon } from "../daemon.js";

const socketPath = resolveSocketPath();
const idleEnv = process.env["FRAMESHELL_IDLE_TIMEOUT_MS"];
const idleTimeoutMs = idleEnv ? Number(idleEnv) : DEFAULT_IDLE_TIMEOUT_MS;

try {
  const daemon = await startDaemon({ socketPath, idleTimeoutMs });
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => void daemon.close());
  await daemon.closed;
  process.exit(0);
} catch (error) {
  // Lost a start race to another client: that daemon serves everyone.
  if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") process.exit(0);
  console.error(`frameshelld: ${(error as Error).message}`);
  process.exit(1);
}
