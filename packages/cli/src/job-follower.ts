import type { DaemonConnection, JobInfo } from "@frameshell/protocol";

/** Jobs of one project followed through `job.progress` events. */
export interface JobFollower {
  /**
   * Resolve with the final snapshot of every job in `ids` once none is queued
   * or running. `onChange` sees each snapshot as it arrives, oldest first,
   * including those received before this call. A job `job.list` no longer
   * has was pruned, so it finished long ago; it is left out of the result.
   * Rejects when the connection closes first.
   */
  wait(ids: readonly string[], onChange?: (job: JobInfo) => void): Promise<Map<string, JobInfo>>;
}

const active = (job: JobInfo) => job.state === "queued" || job.state === "running";

/**
 * Subscribe to `job.progress` of the project enclosing `cwd`. Call it before
 * the request that queues the jobs, so no change is missed; the subscription
 * ends with the connection. Rejects like `events.subscribe` (ProjectNotFound).
 */
export async function followJobs(conn: DaemonConnection, cwd: string): Promise<JobFollower> {
  const history: JobInfo[] = [];
  let listener: ((job: JobInfo) => void) | undefined;
  await conn.request("events.subscribe", { cwd, events: ["job.progress"] });
  conn.on("job.progress", ({ job }) => (listener ? listener(job) : history.push(job)));

  return {
    wait: (ids, onChange) =>
      new Promise((resolve, reject) => {
        const wanted = new Set(ids);
        const latest = new Map<string, JobInfo>();
        let snapshotTaken = false;
        const settleIfDone = () => {
          if (snapshotTaken && [...latest.values()].every((job) => !active(job))) resolve(latest);
        };
        const take = (job: JobInfo) => {
          if (!wanted.has(job.id)) return;
          latest.set(job.id, job);
          onChange?.(job);
          settleIfDone();
        };
        for (const job of history.splice(0)) take(job);
        listener = take;
        // Covers jobs that changed before the subscription (a reused queued job); newer than any event read so far.
        conn.request("job.list", { cwd }).then(({ jobs }) => {
          for (const job of jobs) {
            if (!wanted.has(job.id)) continue;
            const seen = latest.get(job.id);
            if (!seen || seen.state !== job.state || seen.step !== job.step || seen.progress !== job.progress) take(job);
          }
          snapshotTaken = true;
          settleIfDone();
        }, reject);
        void conn.closed.then(() => reject(new Error("frameshelld closed the connection before the jobs finished")));
      }),
  };
}
