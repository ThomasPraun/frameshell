import { describe, expect, it } from "vitest";
import type { DaemonConnection, JobInfo } from "@frameshell/protocol";
import { followJobs } from "../src/job-follower.js";

const job = (state: JobInfo["state"], step: JobInfo["step"] = null, progress?: number): JobInfo => ({
  id: "j_2",
  kind: "ingest",
  project: "/talk",
  asset: "assets/take 1.mp4",
  output: null,
  priority: "interactive",
  position: null,
  state,
  step,
  progress: progress ?? (state === "done" ? 1 : 0),
  cached: state === "done" ? true : null,
  error: null,
  warnings: [],
  createdAt: "2026-09-30T18:34:00.000Z",
  startedAt: null,
  finishedAt: null,
});

/**
 * Daemon stand-in: `job.list` answers with `listed`, after pushing `before` as `job.progress` events. The real
 * daemon does this when a job finishes between taking the list and writing its reply (a cached re-import).
 */
function connection(before: JobInfo[], listed: JobInfo[]): DaemonConnection {
  let listener: ((params: { project: string; job: JobInfo }) => void) | undefined;
  const fake = {
    request: async (method: string) => {
      if (method !== "job.list") return {};
      for (const change of before) listener?.({ project: "/talk", job: change });
      return { dir: "/talk", jobs: listed };
    },
    on: (_event: string, handler: typeof listener) => {
      listener = handler;
      return () => undefined;
    },
    closed: new Promise<void>(() => undefined),
    close: () => undefined,
  };
  return fake as unknown as DaemonConnection;
}

describe("followJobs", () => {
  it("settles on a job's final event even when a job.list reply sent after it still shows the job running", async () => {
    const conn = connection([job("running", "hash"), job("done")], [job("running", "hash")]);
    const follower = await followJobs(conn, "/talk");
    const settled = await Promise.race([
      follower.wait(["j_2"]),
      new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 1000)),
    ]);
    expect(settled).not.toBe("hung");
    expect((settled as Map<string, JobInfo>).get("j_2")).toMatchObject({ state: "done", cached: true });
  });

  it("takes the listed state of a job no event reported yet", async () => {
    const conn = connection([], [job("done")]);
    const follower = await followJobs(conn, "/talk");
    expect((await follower.wait(["j_2"])).get("j_2")).toMatchObject({ state: "done" });
  });

  it("does not step back to the previous step when a job.list reply older than the events shows it at the same progress", async () => {
    // The hash step ends at the progress where the probe step starts: only the step tells them apart.
    const conn = connection([job("running", "hash", 0.05), job("running", "probe", 0.05)], [job("running", "hash", 0.05)]);
    const follower = await followJobs(conn, "/talk");
    const steps: (string | null)[] = [];
    void follower.wait(["j_2"], (change) => steps.push(change.step));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(steps).toEqual(["hash", "probe"]);
  });
});
