import type { JobInfo, JobStep } from "@frameshell/protocol";

/** What a running job may report. */
export interface JobUpdate {
  step?: JobStep | null;
  /** Overall fraction, clamped to 0..1. */
  progress?: number;
  cached?: boolean;
}

/** Handed to a job's `run`. */
export interface JobContext {
  /** Aborted when the queue closes; kill child processes on it. */
  readonly signal: AbortSignal;
  update(update: JobUpdate): void;
}

/** A job to queue. */
export interface JobRequest {
  kind: JobInfo["kind"];
  /** Absolute project root. */
  project: string;
  /** Project-relative input (asset, or timeline file for renders). A queued or running job for the same kind, project, asset and output is reused. */
  asset: string;
  /** Absolute file a render writes; omit for ingest. */
  output?: string;
  /** Resolve = done, reject = failed with the error's message. */
  run: (ctx: JobContext) => Promise<void>;
}

/** Options for {@link JobQueue}. */
export interface JobQueueOptions {
  /** Jobs running at once. ffmpeg already uses every core, so keep it small. */
  concurrency?: number;
  /** Called when the queue goes from idle to busy (true) and back (false). The daemon stays up while busy. */
  onBusyChange?: (busy: boolean) => void;
  /** Finished jobs kept for `list`; oldest are dropped first. */
  keepFinished?: number;
}

interface Entry {
  info: JobInfo;
  request: JobRequest;
  abort: AbortController;
}

/**
 * In-daemon FIFO of background work (SPEC §3.1). Jobs belong to the daemon,
 * not to the client that queued them: a disconnect never stops one. State is
 * in memory; work lost to a daemon exit is found again from disk (ingest
 * re-queues assets without complete outputs when a project opens).
 */
export class JobQueue {
  readonly #entries = new Map<string, Entry>();
  readonly #waiting: Entry[] = [];
  readonly #running = new Set<Entry>();
  readonly #concurrency: number;
  readonly #keepFinished: number;
  readonly #onBusyChange: (busy: boolean) => void;
  readonly #drainWaiters: (() => void)[] = [];
  #nextId = 1;
  #busy = false;
  #closed = false;

  constructor(options: JobQueueOptions = {}) {
    this.#concurrency = Math.max(1, options.concurrency ?? 2);
    this.#keepFinished = options.keepFinished ?? 200;
    this.#onBusyChange = options.onBusyChange ?? (() => {});
  }

  /** True while any job is queued or running. */
  get busy(): boolean {
    return this.#busy;
  }

  /** Queue `request`, or return the queued or running job for the same asset. Snapshot, not live. */
  enqueue(request: JobRequest): JobInfo {
    for (const entry of [...this.#waiting, ...this.#running]) {
      const { info } = entry;
      const same =
        info.kind === request.kind &&
        info.project === request.project &&
        info.asset === request.asset &&
        info.output === (request.output ?? null);
      if (same) {
        return { ...info };
      }
    }
    const info: JobInfo = {
      id: `j_${this.#nextId++}`,
      kind: request.kind,
      project: request.project,
      asset: request.asset,
      output: request.output ?? null,
      state: "queued",
      step: null,
      progress: 0,
      cached: null,
      error: null,
      createdAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
    };
    const entry: Entry = { info, request, abort: new AbortController() };
    this.#entries.set(info.id, entry);
    if (this.#closed) {
      this.#finish(entry, "canceled", null);
      return { ...info };
    }
    this.#waiting.push(entry);
    this.#setBusy(true);
    this.#pump();
    return { ...info };
  }

  /** Snapshot of one job; undefined when unknown or already dropped. */
  get(id: string): JobInfo | undefined {
    const entry = this.#entries.get(id);
    return entry ? { ...entry.info } : undefined;
  }

  /** Snapshots, oldest first. */
  list(filter: { project?: string; active?: boolean } = {}): JobInfo[] {
    return [...this.#entries.values()]
      .map(({ info }) => info)
      .filter((info) => filter.project === undefined || info.project === filter.project)
      .filter((info) => !filter.active || info.state === "queued" || info.state === "running")
      .map((info) => ({ ...info }));
  }

  /** Resolves once nothing is queued or running. */
  drained(): Promise<void> {
    if (!this.#busy) return Promise.resolve();
    return new Promise((resolve) => this.#drainWaiters.push(resolve));
  }

  /** Cancel queued jobs, abort running ones and wait for them to settle. Later enqueues are canceled at once. */
  async close(): Promise<void> {
    this.#closed = true;
    for (const entry of this.#waiting.splice(0)) this.#finish(entry, "canceled", null);
    for (const entry of this.#running) entry.abort.abort();
    this.#pump();
    await this.drained();
  }

  #pump(): void {
    while (!this.#closed && this.#running.size < this.#concurrency && this.#waiting.length > 0) {
      const entry = this.#waiting.shift()!;
      this.#running.add(entry);
      void this.#run(entry);
    }
    if (this.#waiting.length === 0 && this.#running.size === 0) this.#setBusy(false);
  }

  async #run(entry: Entry): Promise<void> {
    const { info } = entry;
    info.state = "running";
    info.startedAt = new Date().toISOString();
    const ctx: JobContext = {
      signal: entry.abort.signal,
      update: (update) => {
        if (info.state !== "running") return;
        if (update.step !== undefined) info.step = update.step;
        if (update.progress !== undefined) info.progress = Math.min(1, Math.max(0, update.progress));
        if (update.cached !== undefined) info.cached = update.cached;
      },
    };
    try {
      await entry.request.run(ctx);
      if (entry.abort.signal.aborted) this.#finish(entry, "canceled", null);
      else this.#finish(entry, "done", null);
    } catch (error) {
      if (entry.abort.signal.aborted) this.#finish(entry, "canceled", null);
      else this.#finish(entry, "failed", (error as Error)?.message ?? String(error));
    } finally {
      this.#running.delete(entry);
      this.#pump();
    }
  }

  #finish(entry: Entry, state: "done" | "failed" | "canceled", error: string | null): void {
    const { info } = entry;
    info.state = state;
    info.step = null;
    info.error = error;
    if (state === "done") info.progress = 1;
    info.finishedAt = new Date().toISOString();
    this.#prune();
  }

  /** Drop the oldest finished jobs beyond the retention limit. */
  #prune(): void {
    const finished = [...this.#entries.values()].filter(
      ({ info }) => info.state !== "queued" && info.state !== "running",
    );
    for (const { info } of finished.slice(0, Math.max(0, finished.length - this.#keepFinished))) {
      this.#entries.delete(info.id);
    }
  }

  #setBusy(busy: boolean): void {
    if (busy === this.#busy) return;
    this.#busy = busy;
    this.#onBusyChange(busy);
    if (!busy) for (const resolve of this.#drainWaiters.splice(0)) resolve();
  }
}
