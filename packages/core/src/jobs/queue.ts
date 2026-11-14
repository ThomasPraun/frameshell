import type { JobInfo, JobPriority, JobStep } from "@frameshell/protocol";

/** What a running job may report. */
export interface JobUpdate {
  step?: JobStep | null;
  /** Overall fraction, clamped to 0..1. */
  progress?: number;
  cached?: boolean;
  /** A problem found on the way; appended to the job's `warnings` and reported to watchers. */
  warning?: string;
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
  /**
   * `interactive` (default) starts before every waiting `background` job; `background` still gets a slot
   * after {@link JobQueueOptions.starvationLimit} interactive starts in a row. A running job is never preempted.
   */
  priority?: JobPriority;
  /** Resolve = done, reject = failed with the error's message. */
  run: (ctx: JobContext) => Promise<void>;
}

/** One change of a job, as {@link JobQueue.watch} reports it. */
export interface JobChange {
  /** Snapshot after the change. */
  job: JobInfo;
  /** True when `state` moved (queued, running, done, failed, canceled); false for step, progress or cache news. */
  stateChanged: boolean;
}

/** Default {@link JobQueueOptions.progressIntervalMs}. */
const PROGRESS_INTERVAL_MS = 200;

/** Default {@link JobQueueOptions.starvationLimit}. */
const STARVATION_LIMIT = 4;

/** Options for {@link JobQueue}. */
export interface JobQueueOptions {
  /** Jobs running at once. ffmpeg already uses every core, so keep it small. */
  concurrency?: number;
  /** Called when the queue goes from idle to busy (true) and back (false). The daemon stays up while busy. */
  onBusyChange?: (busy: boolean) => void;
  /** Finished jobs kept for `list`; oldest are dropped first. */
  keepFinished?: number;
  /**
   * Minimum gap between two progress-only reports of one job to watchers.
   * Step and state changes always go out at once. Default 200 ms.
   */
  progressIntervalMs?: number;
  /**
   * Interactive jobs that may start in a row while a background job waits; the next start then goes to the
   * oldest background job, so finals still progress under a steady stream of short renders. Default 4.
   */
  starvationLimit?: number;
  /** Job id prefix; queues sharing one daemon need distinct ones. Default `j_`. */
  idPrefix?: string;
}

interface Entry {
  info: JobInfo;
  request: JobRequest;
  abort: AbortController;
  /** `Date.now()` of the last report to watchers. */
  reportedAt: number;
}

/**
 * In-daemon queue of background work (SPEC §3.1), FIFO within a priority. Jobs belong to the daemon,
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
  readonly #watchers = new Set<(change: JobChange) => void>();
  readonly #progressIntervalMs: number;
  readonly #idPrefix: string;
  readonly #starvationLimit: number;
  /** Interactive jobs started in a row while a background one waited. */
  #streak = 0;
  #nextId = 1;
  #busy = false;
  #closed = false;

  constructor(options: JobQueueOptions = {}) {
    this.#concurrency = Math.max(1, options.concurrency ?? 2);
    this.#keepFinished = options.keepFinished ?? 200;
    this.#onBusyChange = options.onBusyChange ?? (() => {});
    this.#progressIntervalMs = options.progressIntervalMs ?? PROGRESS_INTERVAL_MS;
    this.#idPrefix = options.idPrefix ?? "j_";
    this.#starvationLimit = Math.max(1, options.starvationLimit ?? STARVATION_LIMIT);
  }

  /**
   * Call `watcher` on every job change, synchronously and in order: queued,
   * running, step/progress/cache updates (progress-only ones rate-limited),
   * then done, failed or canceled. A throwing watcher never breaks the queue.
   * Returns the function that stops watching.
   */
  watch(watcher: (change: JobChange) => void): () => void {
    this.#watchers.add(watcher);
    return () => void this.#watchers.delete(watcher);
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
        if (request.priority !== "background") this.promote(info.id);
        return this.#snapshot(entry);
      }
    }
    const info: JobInfo = {
      id: `${this.#idPrefix}${this.#nextId++}`,
      kind: request.kind,
      project: request.project,
      asset: request.asset,
      output: request.output ?? null,
      priority: request.priority ?? "interactive",
      position: null,
      state: "queued",
      step: null,
      progress: 0,
      cached: null,
      error: null,
      warnings: [],
      createdAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
    };
    const entry: Entry = { info, request, abort: new AbortController(), reportedAt: 0 };
    this.#entries.set(info.id, entry);
    this.#report(entry, true);
    if (this.#closed) {
      this.#finish(entry, "canceled", null);
      return this.#snapshot(entry);
    }
    this.#waiting.push(entry);
    this.#setBusy(true);
    this.#pump();
    return this.#snapshot(entry);
  }

  /**
   * Make a queued background job interactive: it starts before the background jobs that wait, in the order it
   * was queued among the interactive ones. False when it is not queued or already interactive.
   */
  promote(id: string): boolean {
    const entry = this.#entries.get(id);
    if (!entry || entry.info.state !== "queued" || entry.info.priority === "interactive") return false;
    entry.info.priority = "interactive";
    this.#report(entry, false);
    return true;
  }

  /**
   * Cancel a job: a queued one is dropped at once, a running one is aborted through its signal and ends
   * `canceled` when its `run` settles. Snapshot (a finished job comes back unchanged), undefined when unknown.
   */
  cancel(id: string): JobInfo | undefined {
    const entry = this.#entries.get(id);
    if (!entry) return undefined;
    const index = this.#waiting.indexOf(entry);
    if (index >= 0) {
      this.#waiting.splice(index, 1);
      this.#finish(entry, "canceled", null);
      this.#pump();
    } else if (this.#running.has(entry)) {
      entry.abort.abort();
    }
    return this.#snapshot(entry);
  }

  /** Snapshot of one job; undefined when unknown or already dropped. */
  get(id: string): JobInfo | undefined {
    const entry = this.#entries.get(id);
    return entry ? this.#snapshot(entry) : undefined;
  }

  /** Snapshots, oldest first. */
  list(filter: { project?: string; active?: boolean } = {}): JobInfo[] {
    const order = this.#order();
    return [...this.#entries.values()]
      .filter(({ info }) => filter.project === undefined || info.project === filter.project)
      .filter(({ info }) => !filter.active || info.state === "queued" || info.state === "running")
      .map((entry) => this.#snapshot(entry, order));
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

  /** Index in `waiting` of the entry that starts next, given `streak` interactive starts in a row. */
  #nextIndex(waiting: readonly Entry[], streak: number): number {
    const interactive = waiting.findIndex((entry) => entry.info.priority === "interactive");
    const background = waiting.findIndex((entry) => entry.info.priority === "background");
    if (interactive < 0) return background;
    if (background < 0) return interactive;
    return streak >= this.#starvationLimit ? background : interactive;
  }

  /** The waiting entries in the order they will start. */
  #order(): Entry[] {
    const rest = [...this.#waiting];
    const order: Entry[] = [];
    let streak = this.#streak;
    while (rest.length > 0) {
      const entry = rest.splice(this.#nextIndex(rest, streak), 1)[0]!;
      streak = this.#streakAfter(entry, rest, streak);
      order.push(entry);
    }
    return order;
  }

  /** `streak` after `started` took a slot while `rest` still waits. */
  #streakAfter(started: Entry, rest: readonly Entry[], streak: number): number {
    if (started.info.priority === "background") return 0;
    return rest.some((entry) => entry.info.priority === "background") ? streak + 1 : streak;
  }

  /** A copy of the job's info; `position` is its place in the start order while queued, 1 = next. */
  #snapshot(entry: Entry, order?: readonly Entry[]): JobInfo {
    if (entry.info.state !== "queued") return { ...entry.info, position: null };
    const index = (order ?? this.#order()).indexOf(entry);
    return { ...entry.info, position: index >= 0 ? index + 1 : null };
  }

  #pump(): void {
    while (!this.#closed && this.#running.size < this.#concurrency && this.#waiting.length > 0) {
      const entry = this.#waiting.splice(this.#nextIndex(this.#waiting, this.#streak), 1)[0]!;
      this.#streak = this.#streakAfter(entry, this.#waiting, this.#streak);
      this.#running.add(entry);
      void this.#run(entry);
    }
    if (this.#waiting.length === 0 && this.#running.size === 0) this.#setBusy(false);
  }

  async #run(entry: Entry): Promise<void> {
    const { info } = entry;
    info.state = "running";
    info.startedAt = new Date().toISOString();
    this.#report(entry, true);
    const ctx: JobContext = {
      signal: entry.abort.signal,
      update: (update) => {
        if (info.state !== "running") return;
        const before = { step: info.step, progress: info.progress, cached: info.cached, warnings: info.warnings.length };
        if (update.step !== undefined) info.step = update.step;
        if (update.progress !== undefined) info.progress = Math.min(1, Math.max(0, update.progress));
        if (update.cached !== undefined) info.cached = update.cached;
        if (update.warning !== undefined) info.warnings = [...info.warnings, update.warning];
        if (info.step !== before.step || info.cached !== before.cached || info.warnings.length !== before.warnings) this.#report(entry, false);
        else if (info.progress !== before.progress && Date.now() - entry.reportedAt >= this.#progressIntervalMs) {
          this.#report(entry, false);
        }
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
    this.#report(entry, true);
    this.#prune();
  }

  #report(entry: Entry, stateChanged: boolean): void {
    entry.reportedAt = Date.now();
    const snapshot = this.#snapshot(entry);
    for (const watcher of [...this.#watchers]) {
      try {
        watcher({ job: { ...snapshot }, stateChanged });
      } catch {
        // A watcher's bug must not fail the job.
      }
    }
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
