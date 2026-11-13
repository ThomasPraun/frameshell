#!/usr/bin/env node
// frameshelld entry. Usually spawned detached by the CLI or app, not by hand.
// Env: FRAMESHELL_SOCKET (endpoint), FRAMESHELL_IDLE_TIMEOUT_MS (ms, "Infinity" disables),
// FRAMESHELL_TX_IDLE_MS (ms of session inactivity that ends an automatic transaction).
// FRAMESHELL_SEGMENT_STAND_IN=1 (e2e only): photo segmentation answers with squares instead of downloading MobileSAM.
// FRAMESHELL_SHOOT_STAND_IN=1 (e2e only): takes recorded in the app are heard as their scene's words, no speech model.
// FRAMESHELL_SPEECH_STAND_IN=1 (tests only): a free built-in speech provider `stand-in` that says each word as a tone;
// `paid` adds `stand-in-paid`, the same voice at 0.01 USD a word, for the app's cost dialog.
// FRAMESHELL_MATTE_STAND_IN=1 (tests only): subject mattes take what is brighter than mid-gray, no model download.
// Startup errors go to stderr: the spawning CLI relays them to the user.
import { resolveSocketPath } from "@frameshell/protocol";
import { DEFAULT_IDLE_TIMEOUT_MS, startDaemon } from "../daemon.js";
import { standInSegmentEngine } from "../segment/stand-in.js";
import { paidStandInSpeechProvider, standInSpeechProvider } from "../voiceover/stand-in.js";
import { DEFAULT_TX_IDLE_GAP_MS } from "../history/transactions.js";

// The spawning CLI closes its end of the stderr pipe once connected; later writes must not crash us.
process.stderr.on("error", () => {});

try {
  const socketPath = resolveSocketPath();
  const idleTimeoutMs = parseMs("FRAMESHELL_IDLE_TIMEOUT_MS", DEFAULT_IDLE_TIMEOUT_MS);
  const txIdleGapMs = parseMs("FRAMESHELL_TX_IDLE_MS", DEFAULT_TX_IDLE_GAP_MS);
  const segmentEngine = process.env["FRAMESHELL_SEGMENT_STAND_IN"] === "1" ? standInSegmentEngine() : undefined;
  const shootStandIn = process.env["FRAMESHELL_SHOOT_STAND_IN"] === "1";
  const speechStandIn = process.env["FRAMESHELL_SPEECH_STAND_IN"];
  const speechProviders = speechStandIn === "paid" ? [standInSpeechProvider(), paidStandInSpeechProvider()] : speechStandIn === "1" ? [standInSpeechProvider()] : [];
  const matteStandIn = process.env["FRAMESHELL_MATTE_STAND_IN"] === "1";
  const daemon = await startDaemon({
    socketPath,
    idleTimeoutMs,
    txIdleGapMs,
    ...(segmentEngine ? { segmentEngine } : {}),
    ...(shootStandIn ? { shootStandIn } : {}),
    ...(matteStandIn ? { matteStandIn } : {}),
    speechProviders,
  });
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

/** Unset = default. NaN or negative would silently misbehave (a leaked daemon, no grouping), so fail instead. */
function parseMs(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const ms = Number(raw);
  if (Number.isNaN(ms) || ms < 0) {
    throw new Error(`${name} must be milliseconds >= 0 or "Infinity", got "${raw}"`);
  }
  return ms;
}
