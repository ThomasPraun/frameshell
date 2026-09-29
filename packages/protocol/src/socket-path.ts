import { tmpdir, userInfo } from "node:os";
import { posix } from "node:path";

/**
 * Local endpoint of the per-user daemon (SPEC §3.1).
 *
 * - `FRAMESHELL_SOCKET` wins: the app sets it in each pty, tests use it for isolation.
 * - Windows: named pipe `\\.\pipe\frameshelld-<user>`. Pipes vanish with their process, so never stale.
 * - Unix: `<XDG_RUNTIME_DIR or tmpdir>/frameshelld-<uid>.sock`. Kept short: sun_path caps near 104 bytes.
 */
export function resolveSocketPath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const override = env["FRAMESHELL_SOCKET"];
  if (override) return override;
  if (platform === "win32") {
    return `\\\\.\\pipe\\frameshelld-${sanitize(userInfo().username)}`;
  }
  const base = env["XDG_RUNTIME_DIR"] || tmpdir();
  return posix.join(base, `frameshelld-${userInfo().uid}.sock`);
}

/** Usable `sun_path` bytes (buffer size minus the NUL). */
const MAX_SOCKET_PATH_BYTES: Partial<Record<NodeJS.Platform, number>> = { linux: 107, android: 107 };
const DEFAULT_MAX_SOCKET_PATH_BYTES = 103; // macOS and the BSDs.

/**
 * Throw when a unix socket path exceeds the OS limit (error `code` `ENAMETOOLONG`).
 *
 * The kernel may truncate over-long paths instead of failing: the daemon then
 * binds a different file than clients look for, or stale-socket cleanup stats
 * the untruncated path and fails with a misleading `ENOENT`. Pipe names on
 * Windows are exempt.
 */
export function assertSocketPathFits(socketPath: string, platform: NodeJS.Platform = process.platform): void {
  if (platform === "win32") return;
  const max = MAX_SOCKET_PATH_BYTES[platform] ?? DEFAULT_MAX_SOCKET_PATH_BYTES;
  const bytes = Buffer.byteLength(socketPath);
  if (bytes <= max) return;
  throw Object.assign(
    new Error(
      `Socket path is too long (${bytes} bytes, this OS allows ${max}): ${socketPath}. ` +
        "Set FRAMESHELL_SOCKET (or XDG_RUNTIME_DIR) to a shorter path.",
    ),
    { code: "ENAMETOOLONG" },
  );
}

function sanitize(name: string): string {
  return name.replace(/[^A-Za-z0-9_.-]/g, "_") || "user";
}
