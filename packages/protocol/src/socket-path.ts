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

function sanitize(name: string): string {
  return name.replace(/[^A-Za-z0-9_.-]/g, "_") || "user";
}
