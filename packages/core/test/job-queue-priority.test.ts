import { describe, expect, it } from "vitest";
import { type JobContext, JobQueue } from "../src/jobs/queue.js";

/** A run the test finishes by hand. */
function deferred() {
  let finish!: () => void;
  const done = new Promise<void>((resolve) => (finish = resolve));
  const run = async (_ctx: JobContext) => done;
  return { run, finish };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A queue of one slot whose first job is held running, so everything queued after it waits. */
async function held(options: { starvationLimit?: number } = {}) {
  const queue = new JobQueue({ concurrency: 1, ...options });
  const started: string[] = [];
  const gate = deferred();
  queue.enqueue({ kind: "clip", project: "/p", asset: "gate", run: gate.run });
  await settle();
  const add = (asset: string, priority?: "interactive" | "background") =>
    queue.enqueue({
      kind: "clip",
      project: "/p",
      asset,
      ...(priority ? { priority } : {}),
      run: async () => void started.push(asset),
    });
  return { queue, started, add, release: () => gate.finish() };
}

describe("JobQueue priorities", () => {
  it("starts interactive jobs before background ones, each kind in the order queued", async () => {
    const { queue, started, add, release } = await held();
    add("bg1", "background");
    add("bg2", "background");
    add("fg1");
    add("fg2", "interactive");
    release();
    await queue.drained();
    expect(started).toEqual(["fg1", "fg2", "bg1", "bg2"]);
  });

  it("lets a waiting background job start after `starvationLimit` interactive ones in a row", async () => {
    const { queue, started, add, release } = await held({ starvationLimit: 2 });
    add("bg1", "background");
    add("bg2", "background");
    for (const name of ["fg1", "fg2", "fg3", "fg4", "fg5"]) add(name);
    release();
    await queue.drained();
    expect(started).toEqual(["fg1", "fg2", "bg1", "fg3", "fg4", "bg2", "fg5"]);
  });

  it("does not starve a background job while interactive ones keep arriving", async () => {
    const queue = new JobQueue({ concurrency: 1, starvationLimit: 3 });
    const started: string[] = [];
    const gate = deferred();
    queue.enqueue({ kind: "clip", project: "/p", asset: "gate", run: gate.run });
    await settle();
    queue.enqueue({ kind: "clip", project: "/p", asset: "final", priority: "background", run: async () => void started.push("final") });
    // Each interactive job queues the next one, as a preview that keeps asking would.
    const chain = (n: number): void => {
      queue.enqueue({
        kind: "clip",
        project: "/p",
        asset: `fg${n}`,
        run: async () => {
          started.push(`fg${n}`);
          if (n < 20) chain(n + 1);
        },
      });
    };
    chain(1);
    gate.finish();
    await queue.drained();
    expect(started.indexOf("final")).toBe(3);
    expect(started).toHaveLength(21);
  });

  it("reports a queued job's priority and its place in the start order, null once it runs", async () => {
    const { queue, add, release } = await held();
    const bg = add("bg", "background");
    const fg = add("fg");
    expect(bg).toMatchObject({ priority: "background", position: 1 });
    expect(fg).toMatchObject({ priority: "interactive", position: 1 });
    expect(queue.get(bg.id)).toMatchObject({ position: 2 });
    expect(queue.list({ active: true }).map((job) => [job.asset, job.position])).toEqual([
      ["gate", null],
      ["bg", 2],
      ["fg", 1],
    ]);
    release();
    await queue.drained();
    expect(queue.get(bg.id)).toMatchObject({ state: "done", position: null });
  });

  it("promotes a queued background job to interactive, also when it is queued again as interactive", async () => {
    const { queue, started, add, release } = await held();
    const first = add("bg1", "background");
    const second = add("bg2", "background");
    add("fg");
    const seen: number[] = [];
    queue.watch(({ job }) => {
      if (job.id === second.id) seen.push(job.position ?? 0);
    });
    expect(add("bg2").id).toBe(second.id);
    expect(queue.get(second.id)).toMatchObject({ priority: "interactive", position: 1 });
    expect(seen).toEqual([1]);
    expect(queue.promote(second.id)).toBe(false);
    expect(queue.promote("j_nope")).toBe(false);
    // A background request for a job already waiting never demotes it.
    add("bg2", "background");
    expect(queue.get(second.id)?.priority).toBe("interactive");
    expect(queue.get(first.id)?.priority).toBe("background");
    release();
    await queue.drained();
    expect(started).toEqual(["bg2", "fg", "bg1"]);
  });

  it("cancels a queued job at once, closing the gap in the order", async () => {
    const { queue, started, add, release } = await held();
    const a = add("a");
    const b = add("b");
    const c = add("c");
    const events: string[] = [];
    queue.watch(({ job }) => events.push(`${job.asset} ${job.state}`));
    expect(queue.cancel(b.id)).toMatchObject({ state: "canceled", position: null, finishedAt: expect.any(String) });
    expect(events).toEqual(["b canceled"]);
    expect(queue.get(c.id)).toMatchObject({ position: 2 });
    expect(queue.get(a.id)).toMatchObject({ position: 1 });
    release();
    await queue.drained();
    expect(started).toEqual(["a", "c"]);
  });

  it("cancels a running job through its signal and ends it canceled", async () => {
    const queue = new JobQueue({ concurrency: 1 });
    let signal!: AbortSignal;
    const { id } = queue.enqueue({
      kind: "clip",
      project: "/p",
      asset: "long",
      run: (ctx) =>
        new Promise<void>((_, reject) => {
          signal = ctx.signal;
          ctx.signal.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    });
    await settle();
    expect(queue.cancel(id)).toMatchObject({ state: "running" });
    await queue.drained();
    expect(signal.aborted).toBe(true);
    expect(queue.get(id)).toMatchObject({ state: "canceled", error: null });
  });

  it("leaves a finished job alone on cancel, answers undefined for an unknown one, and goes idle when the last waiter is canceled", async () => {
    const queue = new JobQueue({ concurrency: 1 });
    const { id } = queue.enqueue({ kind: "clip", project: "/p", asset: "a", run: async () => {} });
    await queue.drained();
    expect(queue.cancel(id)).toMatchObject({ state: "done" });
    expect(queue.cancel("j_nope")).toBeUndefined();

    const busy: boolean[] = [];
    const other = new JobQueue({ concurrency: 1, onBusyChange: (value) => busy.push(value) });
    const gate = deferred();
    other.enqueue({ kind: "clip", project: "/p", asset: "gate", run: gate.run });
    await settle();
    const waiting = other.enqueue({ kind: "clip", project: "/p", asset: "w", run: async () => {} });
    other.cancel(waiting.id);
    gate.finish();
    await other.drained();
    expect(busy).toEqual([true, false]);
  });
});
