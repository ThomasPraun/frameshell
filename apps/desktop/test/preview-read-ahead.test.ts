import { describe, expect, it } from "vitest";
import type { DecodeStep } from "../src/renderer/src/preview/decode-plan.js";
import { readAhead, readBlocks } from "../src/renderer/src/preview/read-ahead.js";

// Seam under test: how far the engine reads encoded pictures ahead of its decoder (#105: a slow ranged read must not
// wait until the decoder needs its first picture).

/** A read the test settles by hand; `started` lists jobs in the order their reads began. */
function manualReads() {
  const started: string[] = [];
  const settle = new Map<string, { resolve(value: string): void; reject(error: Error): void }>();
  const load = (job: string) =>
    new Promise<string>((resolve, reject) => {
      started.push(job);
      settle.set(job, { resolve, reject });
    });
  return { started, settle, load };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("readBlocks", () => {
  const step = (sample: number, from = 0, to = 1): DecodeStep => ({ sample, key: false, from, to });

  it("groups steps into reads of `size` samples starting at the first step each needs", () => {
    const steps = [step(15), step(16), step(17), step(18), step(44), step(45), step(46)];
    expect([...readBlocks(steps, 30)].map((b) => [b.start, b.end, b.steps.map((s) => s.sample)])).toEqual([
      [15, 45, [15, 16, 17, 18, 44]],
      [45, 75, [45, 46]],
    ]);
  });

  it("starts a new read when the plan jumps outside the current one (speed skipping a GOP)", () => {
    const steps = [step(0), step(1), step(60), step(61)];
    expect([...readBlocks(steps, 30)].map((b) => b.start)).toEqual([0, 60]);
  });
});

describe("readAhead", () => {
  it("starts later reads while the consumer still waits for the first, up to the budget", async () => {
    const reads = manualReads();
    const out = readAhead(["a", "b", "c", "d"], reads.load, { weight: () => 30, budget: 60 });
    const first = out.next();
    await tick();
    // Budget 60 = two jobs of 30 in flight before anything is consumed.
    expect(reads.started).toEqual(["a", "b"]);
    reads.settle.get("a")!.resolve("A");
    expect(await first).toEqual({ done: false, value: { job: "a", value: "A" } });
    await tick();
    // Consuming `a` frees its budget: `c` starts while `b` is still in flight.
    expect(reads.started).toEqual(["a", "b", "c"]);
    reads.settle.get("b")!.resolve("B");
    reads.settle.get("c")!.resolve("C");
    expect((await out.next()).value).toEqual({ job: "b", value: "B" });
    expect((await out.next()).value).toEqual({ job: "c", value: "C" });
    await tick();
    reads.settle.get("d")!.resolve("D");
    expect((await out.next()).value).toEqual({ job: "d", value: "D" });
    expect((await out.next()).done).toBe(true);
  });

  it("throws a failed read only when its job is reached", async () => {
    const reads = manualReads();
    const out = readAhead(["a", "b"], reads.load, { weight: () => 1, budget: 10 });
    const first = out.next();
    await tick();
    reads.settle.get("b")!.reject(new Error("HTTP 500"));
    reads.settle.get("a")!.resolve("A");
    expect((await first).value).toEqual({ job: "a", value: "A" });
    await expect(out.next()).rejects.toThrow("HTTP 500");
  });

  it("always starts one job even when it outweighs the budget", async () => {
    const reads = manualReads();
    const out = readAhead(["a", "b"], reads.load, { weight: () => 100, budget: 10 });
    const first = out.next();
    await tick();
    expect(reads.started).toEqual(["a"]);
    reads.settle.get("a")!.resolve("A");
    expect((await first).value).toEqual({ job: "a", value: "A" });
  });

  it("stops pulling jobs once returned (a pipeline restart)", async () => {
    const reads = manualReads();
    let pulled = 0;
    let closed = false;
    async function* jobs() {
      try {
        for (;;) yield `j${pulled++}`;
      } finally {
        closed = true;
      }
    }
    const out = readAhead(jobs(), reads.load, { weight: () => 1, budget: 3 });
    const first = out.next();
    await tick();
    reads.settle.get("j0")!.resolve("x");
    await first;
    await out.return(undefined);
    await tick();
    const after = pulled;
    await tick();
    expect(pulled).toBe(after);
    expect(pulled).toBeLessThanOrEqual(5);
    expect(closed).toBe(true);
  });
});
