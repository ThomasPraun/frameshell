import type { DaemonConnection, JobInfo } from "@frameshell/protocol";

/** Help text of the `job` commands, in `frameshell --help`. */
export const JOB_USAGE = `  job list [--active]          Background jobs of the project with state and progress; a queued one shows its place
                               in line (#1 = next) and, for a clip render, whether it waits as background.
                               --active: only queued and running ones
  job cancel <id>              Cancel a generated-clip render (a clip job): a queued one is dropped, a running one
                               stops. The clip stays failed until its inputs change or an export renders it again
`;

/** Flags each `job` command takes besides the global ones. */
export const JOB_FLAGS: Record<string, readonly string[]> = {
  "job list": ["active"],
  "job cancel": [],
};

/** A parsed `job` command. */
export type JobInvocation = { kind: "job.list"; active: boolean } | { kind: "job.cancel"; job: string };

/** Parse `job <sub> …`; null when the shape is wrong. */
export function parseJob(rest: string[], options: { active?: boolean | undefined }): JobInvocation | null {
  const [sub, ...args] = rest;
  if (sub === "list" && args.length === 0) return { kind: "job.list", active: options.active === true };
  if (sub === "cancel" && args.length === 1) return { kind: "job.cancel", job: args[0]! };
  return null;
}

/** One line per job: what it is, where it stands, its id. */
export function formatJob(job: JobInfo): string {
  const what = `${job.kind} ${job.asset}`;
  switch (job.state) {
    case "running":
      return `${what}: ${job.step ?? "starting"} ${Math.round(job.progress * 100)}% (${job.id})`;
    case "done":
      return `${what}: done${job.cached ? " (cached, nothing re-encoded)" : ""} (${job.id})`;
    case "failed":
      return `${what}: failed: ${job.error ?? "unknown error"} (${job.id})`;
    case "queued":
      return `${what}: queued${job.position === null ? "" : ` #${job.position}`}${job.priority === "background" ? " (background)" : ""} (${job.id})`;
    default:
      return `${what}: ${job.state} (${job.id})`;
  }
}

/** Run a parsed `job` command; human output unless `json`. */
export async function executeJob(conn: DaemonConnection, inv: JobInvocation, cwd: string, json: boolean): Promise<string> {
  const print = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
  if (inv.kind === "job.list") {
    const result = await conn.request("job.list", { cwd, active: inv.active });
    if (json) return print(result);
    return result.jobs.length === 0 ? "No jobs.\n" : `${result.jobs.map(formatJob).join("\n")}\n`;
  }
  const result = await conn.request("job.cancel", { cwd, job: inv.job });
  if (json) return print(result);
  return result.job.state === "running" ? `Stopping ${formatJob(result.job)}\n` : `Canceled ${formatJob(result.job)}\n`;
}
