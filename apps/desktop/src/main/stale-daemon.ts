// A daemon left running by the previous app version (#193): the new app would keep talking to the old code, and the
// old daemon never idles out while the new app is connected. Checked once, at the first start of a new version.
import { readFile } from "node:fs/promises";
import { type DaemonConnection, ErrorCode, RpcError, connectToDaemon, isDaemonUnavailable } from "@frameshell/protocol";
import type { JobInfo } from "@frameshell/protocol";
import { writeTextAtomic } from "@frameshell/core/fs-util";

/**
 * Record `version` as the last one started; true when it differs from the
 * one recorded before, or none was (an app from before this check).
 */
export async function versionChanged(file: string, version: string): Promise<boolean> {
  const previous = await readFile(file, "utf8").then((text) => text.trim(), () => null);
  if (previous === version) return false;
  await writeTextAtomic(file, `${version}\n`).catch(() => undefined);
  return true;
}

/**
 * A daemon may be stopped for the new version when nobody but the caller is
 * connected and no job is queued or running: it would exit on its idle timer
 * anyway (SPEC §3.1), and its jobs are not lost.
 */
export function stoppable(clients: number, jobs: readonly Pick<JobInfo, "state">[]): boolean {
  return clients <= 1 && jobs.every((job) => job.state !== "queued" && job.state !== "running");
}

/**
 * Pid of the daemon refusing the handshake with `IncompatibleProtocol`.
 * Read from the message, which says `frameshelld <version> (pid <n>)`: see
 * `checkProtocolVersion` in `packages/core/src/daemon.ts`.
 */
export function mismatchPid(error: unknown): number | null {
  if (!(error instanceof RpcError) || error.code !== ErrorCode.IncompatibleProtocol) return null;
  const match = /\(pid (\d+)\)/.exec(error.message);
  return match ? Number(match[1]) : null;
}

/** Outcome of {@link stopStaleDaemon}. */
export type StaleDaemonOutcome = "none" | "stopped" | "kept";

/** Longest the app's startup waits on {@link stopStaleDaemon}, connect included: the window opens after it. */
export const STALE_DAEMON_BUDGET_MS = 2000;

/**
 * Stop the daemon at `socketPath` when it is {@link stoppable}, or speaks
 * another protocol (the app cannot use it at all), and wait for it to exit;
 * the app's link then starts a daemon of this version. A busy daemon is
 * kept: it exits on its idle timer once its clients and jobs are done.
 * Waits for other clients to leave, as the old app may still be quitting.
 *
 * Settles within `timeoutMs` whatever the daemon does (a slow or silent one
 * is `kept`): the caller awaits it before its own link connects, so the link
 * never reaches the old daemon before this decided, and a late answer kills nothing.
 */
export async function stopStaleDaemon(options: {
  socketPath: string;
  client: string;
  /** Directory for `status` (any; e.g. the home dir). */
  cwd: string;
  kill?: (pid: number) => void;
  timeoutMs?: number;
}): Promise<StaleDaemonOutcome> {
  const { timeoutMs = STALE_DAEMON_BUDGET_MS } = options;
  const run: Run = { deadline: Date.now() + timeoutMs, abandoned: false, connection: null };
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<StaleDaemonOutcome>((resolve) => (timer = setTimeout(() => resolve("kept"), timeoutMs)));
  try {
    return await Promise.race([check(options, run).catch((): StaleDaemonOutcome => "kept"), timeout]);
  } finally {
    clearTimeout(timer);
    run.abandoned = true;
    // Pending requests reject, ending the check; a connection still opening is closed when it lands.
    run.connection?.close();
  }
}

/** State of one {@link stopStaleDaemon} call; `abandoned` once it settled, so a late step does nothing. */
interface Run {
  deadline: number;
  abandoned: boolean;
  connection: DaemonConnection | null;
}

async function check(
  { socketPath, client, cwd, kill = (pid) => process.kill(pid, "SIGTERM") }: { socketPath: string; client: string; cwd: string; kill?: (pid: number) => void },
  run: Run,
): Promise<StaleDaemonOutcome> {
  let connection: DaemonConnection;
  try {
    connection = await connectToDaemon(socketPath, { client });
  } catch (error) {
    if (isDaemonUnavailable(error)) return "none";
    const pid = mismatchPid(error);
    if (pid === null || run.abandoned) return "kept";
    return (await stopPid(pid, kill, run)) ? "stopped" : "kept";
  }
  if (run.abandoned) {
    connection.close();
    return "kept";
  }
  run.connection = connection;
  const pid = await idlePid(connection, cwd, run.deadline)
    .catch(() => null)
    .finally(() => connection.close());
  if (pid === null || run.abandoned) return "kept";
  return (await stopPid(pid, kill, run)) ? "stopped" : "kept";
}

/** The daemon's pid once it is {@link stoppable}; null when it has jobs, or other clients stay past `deadline`. */
async function idlePid(connection: DaemonConnection, cwd: string, deadline: number): Promise<number | null> {
  for (;;) {
    const status = await connection.request("status", { cwd });
    const jobs: Pick<JobInfo, "state">[] = [];
    for (const project of status.openProjects) {
      jobs.push(...(await connection.request("status", { cwd: project.dir })).jobs);
    }
    if (stoppable(status.daemon.clients, jobs)) return status.daemon.pid;
    if (Date.now() > deadline || jobs.some((job) => job.state === "queued" || job.state === "running")) return null;
    await sleep(250);
  }
}

async function stopPid(pid: number, kill: (pid: number) => void, run: Run): Promise<boolean> {
  try {
    kill(pid);
  } catch {
    return false;
  }
  while (Date.now() < run.deadline && !run.abandoned) {
    if (!alive(pid)) return true;
    await sleep(100);
  }
  return !alive(pid);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
