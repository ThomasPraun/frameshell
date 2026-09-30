// Encoded-picture read-ahead for the engine's decode pipelines (#105). Ranged reads go through the main process's
// `frameshell-media://` handler, which can answer late on a loaded machine. Started only when the decoder needs the
// next picture, that latency eats the few decoded frames kept ahead (0.4 s). Reads run ahead of the decoder instead.
import type { DecodeStep } from "./decode-plan.js";

/** One ranged read: samples `[start, end)` (clamped by the source) and the decode steps it serves. */
export interface ReadBlock {
  start: number;
  end: number;
  steps: DecodeStep[];
}

/**
 * Group a span's decode steps into reads of `size` samples. A read starts at
 * the first step outside the previous one; steps are in decode order, so
 * each read serves a contiguous run of them.
 */
export function* readBlocks(steps: Iterable<DecodeStep>, size: number): Generator<ReadBlock> {
  let block: ReadBlock | null = null;
  for (const step of steps) {
    if (!block || step.sample < block.start || step.sample >= block.end) {
      if (block) yield block;
      block = { start: step.sample, end: step.sample + size, steps: [] };
    }
    block.steps.push(step);
  }
  if (block) yield block;
}

/** How much {@link readAhead} keeps in flight or loaded, unconsumed. */
export interface ReadAheadOptions<J> {
  /** Cost of one job against `budget` (pictures it reads). */
  weight(job: J): number;
  /** Jobs start while the unconsumed ones weigh less than this; one always may. */
  budget: number;
}

/**
 * Yields `{ job, value: await load(job) }` for every job, in job order, and
 * starts loads ahead of the consumer within `options.budget`. A failed load
 * throws when its job is reached, never earlier; loads started for jobs never
 * reached are ignored. Returning the generator stops pulling `jobs` (its
 * `return` is called).
 */
export async function* readAhead<J, R>(
  jobs: Iterable<J> | AsyncIterable<J>,
  load: (job: J) => Promise<R>,
  options: ReadAheadOptions<J>,
): AsyncGenerator<{ job: J; value: R }> {
  const source: AsyncIterator<J> | Iterator<J> = Symbol.asyncIterator in jobs ? jobs[Symbol.asyncIterator]() : jobs[Symbol.iterator]();
  const queue: { job: J; value: Promise<R>; weight: number }[] = [];
  let queued = 0;
  let ended = false;
  let stopped = false;
  let failure: { error: unknown } | null = null;
  let filling: Promise<void> | null = null;

  const fill = async () => {
    // Yield first: `filling` is assigned before the `finally` below can clear it.
    await undefined;
    try {
      while (!stopped && !ended && (queue.length === 0 || queued < options.budget)) {
        const next = await source.next();
        if (stopped) return;
        if (next.done) {
          ended = true;
          return;
        }
        const job = next.value;
        const value = load(job);
        // Rejections surface when the job is consumed; unreached ones must not go unhandled.
        value.catch(() => undefined);
        const weight = options.weight(job);
        queue.push({ job, value, weight });
        queued += weight;
      }
    } catch (error) {
      failure = { error };
      ended = true;
    } finally {
      // Cleared as the loop exits, not a microtask later: a consumer resuming in between must be able to start the
      // next fill, or reads stop running ahead until the one after.
      filling = null;
    }
  };
  const kick = (): Promise<void> => (filling ??= fill());

  try {
    for (;;) {
      while (queue.length === 0) {
        if (ended) {
          // Set inside `fill`: TypeScript's narrowing cannot see that.
          const failed = failure as { error: unknown } | null;
          if (failed) throw failed.error;
          return;
        }
        await kick();
      }
      const head = queue[0]!;
      const value = await head.value;
      queue.shift();
      queued -= head.weight;
      void kick();
      yield { job: head.job, value };
    }
  } finally {
    stopped = true;
    void source.return?.(undefined);
  }
}
