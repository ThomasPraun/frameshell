import { describe, expect, it } from "vitest";
import { type JobContext, JobQueue } from "../src/jobs/queue.js";

/** A run the test finishes by hand. */
function deferred() {
  let finish!: () => void;
  let fail!: (error: Error) => void;
  const done = new Promise<void>((resolve, reject) => {
    finish = resolve;
    fail = reject;
  });
  let context!: JobContext;
  let started = false;
  const run = async (ctx: JobContext) => {
    context = ctx;
    started = true;
    await done;
  };
  return { run, finish, fail, ctx: () => context, started: () => started };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("JobQueue", () => {
  it("runs a job to done and reports its progress while it runs", async () => {
    const queue = new JobQueue({ concurrency: 1 });
    const job = deferred();
    const { id } = queue.enqueue({ kind: "ingest", project: "/p", asset: "assets/a.mp4", run: job.run });
    await settle();
    job.ctx().update({ step: "proxy", progress: 0.5 });
    expect(queue.get(id)).toMatchObject({ state: "running", step: "proxy", progress: 0.5, startedAt: expect.any(String) });
    job.finish();
    await queue.drained();
    expect(queue.get(id)).toMatchObject({ state: "done", progress: 1, error: null, finishedAt: expect.any(String) });
  });

  it("never runs more than `concurrency` jobs at once and keeps FIFO order", async () => {
    const queue = new JobQueue({ concurrency: 1 });
    const first = deferred();
    const second = deferred();
    const a = queue.enqueue({ kind: "ingest", project: "/p", asset: "assets/a.mp4", run: first.run });
    const b = queue.enqueue({ kind: "ingest", project: "/p", asset: "assets/b.mp4", run: second.run });
    await settle();
    expect([queue.get(a.id)?.state, queue.get(b.id)?.state]).toEqual(["running", "queued"]);
    expect(second.started()).toBe(false);
    first.finish();
    await settle();
    expect(queue.get(b.id)?.state).toBe("running");
    second.finish();
    await queue.drained();
  });

  it("returns the pending job instead of queueing the same asset twice", async () => {
    const queue = new JobQueue({ concurrency: 1 });
    const job = deferred();
    const first = queue.enqueue({ kind: "ingest", project: "/p", asset: "assets/a.mp4", run: job.run });
    const again = queue.enqueue({ kind: "ingest", project: "/p", asset: "assets/a.mp4", run: job.run });
    expect(again.id).toBe(first.id);
    expect(queue.list({ project: "/p" })).toHaveLength(1);
    job.finish();
    await queue.drained();
    const later = queue.enqueue({ kind: "ingest", project: "/p", asset: "assets/a.mp4", run: async () => {} });
    expect(later.id).not.toBe(first.id);
    await queue.drained();
  });

  it("records a failure with its message and keeps going", async () => {
    const queue = new JobQueue({ concurrency: 1 });
    const failing = queue.enqueue({
      kind: "ingest",
      project: "/p",
      asset: "assets/bad.txt",
      run: async () => {
        throw new Error("not a media file");
      },
    });
    const next = queue.enqueue({ kind: "ingest", project: "/p", asset: "assets/ok.mp4", run: async () => {} });
    await queue.drained();
    expect(queue.get(failing.id)).toMatchObject({ state: "failed", error: "not a media file" });
    expect(queue.get(next.id)?.state).toBe("done");
  });

  it("lists jobs per project and tells when it is busy", async () => {
    const busy: boolean[] = [];
    const queue = new JobQueue({ concurrency: 2, onBusyChange: (value) => busy.push(value) });
    const job = deferred();
    queue.enqueue({ kind: "ingest", project: "/p", asset: "assets/a.mp4", run: job.run });
    queue.enqueue({ kind: "ingest", project: "/q", asset: "assets/a.mp4", run: async () => {} });
    expect(queue.busy).toBe(true);
    expect(queue.list({ project: "/p" }).map((j) => j.asset)).toEqual(["assets/a.mp4"]);
    expect(queue.list()).toHaveLength(2);
    job.finish();
    await queue.drained();
    expect(queue.busy).toBe(false);
    expect(busy).toEqual([true, false]);
  });

  it("aborts running jobs on close and cancels queued ones", async () => {
    const queue = new JobQueue({ concurrency: 1 });
    let aborted = false;
    const running = queue.enqueue({
      kind: "ingest",
      project: "/p",
      asset: "assets/a.mp4",
      run: (ctx) =>
        new Promise((_resolve, reject) => {
          ctx.signal.addEventListener("abort", () => {
            aborted = true;
            reject(new Error("killed"));
          });
        }),
    });
    const queued = queue.enqueue({ kind: "ingest", project: "/p", asset: "assets/b.mp4", run: async () => {} });
    await settle();
    await queue.close();
    expect(aborted).toBe(true);
    expect(queue.get(running.id)?.state).toBe("canceled");
    expect(queue.get(queued.id)?.state).toBe("canceled");
  });

  it("tells watchers every state change, with a snapshot and whether the state moved", async () => {
    const queue = new JobQueue({ concurrency: 1, progressIntervalMs: 0 });
    const seen: [string, string, string | null, number, boolean][] = [];
    queue.watch(({ job, stateChanged }) => seen.push([job.id, job.state, job.step, job.progress, stateChanged]));
    const job = deferred();
    const { id } = queue.enqueue({ kind: "ingest", project: "/p", asset: "assets/a.mp4", run: job.run });
    const failing = queue.enqueue({
      kind: "ingest",
      project: "/p",
      asset: "assets/b.mp4",
      run: async () => {
        throw new Error("broken");
      },
    });
    await settle();
    job.ctx().update({ step: "proxy", progress: 0.25 });
    job.ctx().update({ progress: 0.5 });
    job.finish();
    await queue.drained();
    expect(seen).toEqual([
      [id, "queued", null, 0, true],
      [id, "running", null, 0, true],
      [failing.id, "queued", null, 0, true],
      [id, "running", "proxy", 0.25, false],
      [id, "running", "proxy", 0.5, false],
      [id, "done", null, 1, true],
      [failing.id, "running", null, 0, true],
      [failing.id, "failed", null, 0, true],
    ]);
  });

  it("rate-limits progress-only updates per job but never step or state changes", async () => {
    const queue = new JobQueue({ concurrency: 1, progressIntervalMs: 60_000 });
    const seen: string[] = [];
    queue.watch(({ job }) => seen.push(`${job.state} ${job.step ?? "-"} ${job.progress}`));
    const job = deferred();
    queue.enqueue({ kind: "render", project: "/p", asset: "timelines/main.json", output: "/out.mp4", run: job.run });
    await settle();
    job.ctx().update({ step: "video", progress: 0.1 });
    job.ctx().update({ progress: 0.2 });
    job.ctx().update({ progress: 0.3 });
    job.ctx().update({ step: "mux", progress: 0.8 });
    job.finish();
    await queue.drained();
    expect(seen).toEqual(["queued - 0", "running - 0", "running video 0.1", "running mux 0.8", "done - 1"]);
  });

  it("stops telling a watcher once it unwatches", async () => {
    const queue = new JobQueue({ concurrency: 1 });
    const seen: string[] = [];
    const unwatch = queue.watch(({ job }) => seen.push(job.state));
    unwatch();
    queue.enqueue({ kind: "ingest", project: "/p", asset: "assets/a.mp4", run: async () => {} });
    await queue.drained();
    expect(seen).toEqual([]);
  });
});
