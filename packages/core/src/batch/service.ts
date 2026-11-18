import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import {
  type BatchCancelResult,
  type BatchEntry,
  type BatchManifest,
  BatchManifestSchema,
  type BatchRenderResult,
  type BatchReview,
  ErrorCode,
  type JobInfo,
  type ReviewResult,
  RpcError,
} from "@frameshell/protocol";
import { type AnyClip, type BatchFile, type ResolvedBatchFile, type Timeline, parseBatchFile, withRows } from "@frameshell/schema";
import { canonicalJson } from "../clips/cache-key.js";
import { type PlannedRender, type RenderRequest, confirmFinals } from "../export/service.js";
import { canonicalPathSync, exists, readJsonIfExists, writeJsonAtomic } from "../fs-util.js";
import type { JobChange, JobQueue } from "../jobs/queue.js";
import type { AppliedOperation, OperationRequest, SourceInfo } from "../timeline/engine.js";
import type { ReviewRequest } from "../review/service.js";
import { rowsFromCsv, templateColumnTypes } from "./csv.js";
import { chooseRows, notDone, reviewVerdict, settled } from "./select.js";
import { rowError, rowVariant } from "./variant.js";

/** Options for {@link BatchService}. */
export interface BatchServiceOptions {
  /** The queue `render` jobs go to; watched to drive the rows. */
  jobs: JobQueue;
  /** Parsed timeline and project fps, as on disk; see `TimelineService.load`. */
  loadTimeline(root: string, id: string): Promise<{ timeline: Timeline; fps: number }>;
  /** See `TimelineService.applyInMemory`. */
  applyInMemory(root: string, id: string, loaded: { timeline: Timeline; fps: number }, request: OperationRequest): Promise<AppliedOperation>;
  /** See `TimelineService.source`. */
  source(root: string, asset: string): Promise<SourceInfo>;
  /** True when the project-relative asset has a transcript. */
  hasTranscript(root: string, asset: string): Promise<boolean>;
  /** Seconds a TimeRef names on a loaded timeline of the project (markers, `beat:`, `bar:`, `word:`); see `resolveTimeRefAsync`. */
  resolveTime(root: string, ref: number | string, loaded: { timeline: Timeline; fps: number }): Promise<number>;
  /** Seconds timeline `id` of the project runs when it is `timeline`; null when that cannot be told (a nested timeline fails to load). */
  duration(root: string, id: string, timeline: Timeline, fps: number): Promise<number | null>;
  /** See `TimelineService.declaredProps`. Absent: no clip declares props, so a props slot may name any. */
  declaredProps?(root: string, clip: AnyClip): Promise<readonly string[] | null>;
  /** See `ExportService.planRender`. */
  planRender(root: string, params: RenderRequest, loaded: { timeline: Timeline; fps: number }): Promise<PlannedRender>;
  /** See `ReviewService.run`. Absent: `review` is refused. */
  review?(root: string, request: ReviewRequest): Promise<ReviewResult>;
}

/** Params of {@link BatchService.render}; see the daemon method `batch.render`. */
export interface BatchRequest {
  /** Batch file, absolute or relative to `cwd`. */
  file: string;
  /** Absolute output folder; default `<root>/exports/<batch name>/`. */
  out?: string | undefined;
  /** Instead of the file's `formats`. */
  formats?: readonly string[] | undefined;
  /** Row ids or `first..last` ranges to render; default every row. See {@link chooseRows}. */
  rows?: readonly string[] | undefined;
  /** Only rows whose manifest entries are not all `done`; needs the manifest of this batch file. */
  failed: boolean;
  /** Render chosen rows although every entry is `done` and its file exists. */
  force: boolean;
  /** Review each rendered file once its render is done (see {@link BatchReview}). */
  review?: boolean | undefined;
  dryRun: boolean;
  /** The person agreed to wait for the final renders of generated clips the rows make (ADR 0035 decision 4). */
  yes?: boolean | undefined;
}

/** Params of {@link BatchService.cancel}; see the daemon method `batch.cancel`. */
export interface BatchCancelRequest {
  /** Batch file, absolute or relative to `cwd`. */
  file: string;
  /** Absolute output folder; default `<root>/exports/<batch name>/`. */
  out?: string | undefined;
}

/** How long `batch.cancel` waits for the running render to stop before it answers with the manifest as it is. */
const CANCEL_WAIT_MS = 10_000;

/** One row ready to queue. `entries` are the manifest's, updated in place. */
interface PlannedRow {
  id: string;
  planned: PlannedRender;
  entries: BatchEntry[];
}

/**
 * Batch renders (ADR 0040): each row of a batch file is the template timeline patched in memory
 * ({@link rowVariant}), validated and compiled for every format up front, then queued one row at a time as
 * ordinary `render` jobs: the next row queues from the job watcher when the last job of the row before ends, so
 * the queue is never idle in between (gc and the daemon's idle exit see it busy). `<out>/manifest.json` follows
 * every job state change.
 *
 * With `review`, each file is reviewed (`ReviewService.run` on the file, metrics only) one at a time while the next row
 * renders, and the manifest stays `running` until the last review ended. A review that cannot run never fails the render.
 *
 * A re-run (`rows`, `failed`, `force`) reads the manifest the earlier run left: only the chosen rows are planned and
 * rendered, the others keep their entries, and a chosen row whose renders are all done with the files in place is
 * skipped unless forced. Entries a stopped daemon left `queued` or `running` count as `canceled`.
 */
export class BatchService {
  readonly #options: BatchServiceOptions;
  /** Running batches by canonical out folder. */
  readonly #runs = new Map<string, BatchRun>();

  constructor(options: BatchServiceOptions) {
    this.#options = options;
  }

  /** Validate every row × format, then queue the first row and return (or return the plan, `dryRun`). */
  async render(root: string, cwd: string, request: BatchRequest): Promise<BatchRenderResult> {
    if (request.review && !this.#options.review) {
      throw new RpcError(ErrorCode.InvalidOperation, "This daemon cannot review rendered files.", { op: "batch.render", reason: "review unavailable", field: "review" });
    }
    const path = resolve(cwd, request.file);
    const parsed = await readBatchFile(path);
    const out = request.out ?? join(root, "exports", batchName(path));
    const manifest = join(out, "manifest.json");
    // A batch whose rows all ended may still be writing the manifest that says so: wait for it, so the manifest read below is final.
    await this.#runs.get(canonicalPathSync(out))?.flushed();
    const earlier = await readManifest(manifest, path, request.failed);
    const loaded = await this.#options.loadTimeline(root, parsed.template);
    const file = await resolveRows(path, parsed, loaded.timeline);
    const ids = file.rows.map((row) => row.id);
    let chosen = chooseRows(ids, request.rows);
    if (request.failed) chosen = chosen.filter((id) => notDone(earlier, id));
    const formats = request.formats ?? file.formats;
    const context = {
      root,
      fps: loaded.fps,
      apply: async (timeline: Timeline, op: OperationRequest) => this.#options.applyInMemory(root, file.template, { timeline, fps: loaded.fps }, op),
      source: (asset: string) => this.#options.source(root, asset),
      hasTranscript: (asset: string) => this.#options.hasTranscript(root, asset),
      resolve: (ref: number | string, at: { timeline: Timeline; fps: number }) => this.#options.resolveTime(root, ref, at),
      duration: (timeline: Timeline) => this.#options.duration(root, file.template, timeline, loaded.fps),
      ...(this.#options.declaredProps ? { declaredProps: (clip: AnyClip) => this.#options.declaredProps!(root, clip) } : {}),
    };
    // The template's content without its revision, which moves on any save: equal content, equal hash.
    const templateContent = canonicalJson({ ...loaded.timeline, revision: undefined });
    const rows: PlannedRow[] = [];
    const skipped: string[] = [];
    const changed: string[] = [];
    let first: PlannedRender["result"] | undefined;
    // Entries of rows this call does not render stay as the earlier run left them.
    const rendering = new Set<string>();
    const kept = (): BatchEntry[] => earlier.filter((entry) => !rendering.has(entry.row) && ids.includes(entry.row)).map(settled);
    // Format ids may hold `-`, so row `a` in format `web-1x1` and row `a-web` in `1x1` both write `a-web-1x1.mp4`.
    const outputs = new Map<string, string>();
    for (const entry of earlier) if (!chosen.includes(entry.row)) outputs.set(entry.output, entry.row);
    for (const row of file.rows.filter((row) => chosen.includes(row.id))) {
      const { timeline: variant, warnings: variantWarnings } = await rowVariant(loaded.timeline, file, row, context);
      let planned: PlannedRender;
      try {
        planned = await this.#options.planRender(
          root,
          { timeline: file.template, preset: file.preset, quality: file.quality, formats, stem: join(out, row.id) },
          { timeline: variant, fps: loaded.fps },
        );
      } catch (error) {
        if (!(error instanceof RpcError) || (error.data as { row?: unknown } | undefined)?.row !== undefined) throw error;
        throw new RpcError(error.code, `Row ${row.id}: ${error.message}`, { ...(error.data as Record<string, unknown> | undefined), row: row.id });
      }
      first ??= planned.result;
      const hash = rowHash(row, file.slots, templateContent);
      const entries = planned.result.renders.map((render) => ({
        row: row.id,
        format: render.format,
        output: render.output,
        status: request.dryRun ? ("planned" as const) : ("queued" as const),
        job: null,
        error: null,
        startedAt: null,
        finishedAt: null,
        duration: null,
        warnings: [...variantWarnings, ...render.warnings, ...planned.provenance],
        hash,
        review: null,
      }));
      for (const entry of entries) {
        const other = outputs.get(entry.output);
        if (other !== undefined) {
          throw rowError(row.id, null, `writes ${entry.output}, as row ${other} does. Rename one row so their outputs differ.`, {
            reason: "output clash",
            output: entry.output,
            other,
          });
        }
        outputs.set(entry.output, row.id);
      }
      const state = request.force ? "render" : await renderedState(earlier, row.id, entries);
      if (state === "skip") {
        skipped.push(row.id);
        continue;
      }
      if (state === "changed") changed.push(row.id);
      rendering.add(row.id);
      rows.push({ id: row.id, planned, entries });
    }
    const base = { dir: root, file: path, template: file.template, out, preset: first?.preset ?? null, quality: first?.quality ?? null, skipped, changed };
    const merged = (): BatchEntry[] => orderEntries(ids, [...kept(), ...rows.flatMap((row) => row.entries)]);
    if (request.dryRun) return { ...base, manifest: null, dryRun: true, entries: merged(), jobs: [] };
    // Every row's finals in one sum, before any row queues: a later row must not start hours of renders unasked.
    if (request.yes !== true) {
      const due = rows.flatMap((row) => row.planned.finals.map((final) => ({ ...final, row: row.id })));
      confirmFinals(due, { subject: "This batch", draft: "set `\"quality\": \"draft\"` in the batch file" });
    }
    // Rows left alone that were rendered without a finished review get one when it is asked for.
    const left = kept();
    const unreviewed = request.review ? await needReview(left) : [];
    if (rows.length === 0 && unreviewed.length === 0) return { ...base, manifest: earlier.length > 0 ? manifest : null, dryRun: false, entries: merged(), jobs: [] };

    // Keyed on the folder once it exists, so two spellings of it (a symlink, macOS `/tmp`) share one key.
    await mkdir(out, { recursive: true });
    const key = canonicalPathSync(out);
    if (this.#runs.has(key)) {
      throw new RpcError(
        ErrorCode.InvalidOperation,
        `A batch is already rendering into ${out}; wait until ${manifest} says \`"state": "done"\`, or pass another \`out\`.`,
        { op: "batch.render", reason: "batch running", field: "out" },
      );
    }
    // A draft or other quality tier differs from the preset's plan by design, so only a render as the preset says is checked against it.
    const reviewer = request.review
      ? (entry: BatchEntry) => this.#review(root, file.template, entry, file.quality === undefined ? (first?.preset ?? null) : null, formats !== undefined)
      : null;
    const run = new BatchRun(root, { batch: path, template: file.template, out, manifest }, rows, left, ids, this.#options.jobs, reviewer, unreviewed);
    this.#runs.set(key, run);
    try {
      // Before any job: an out folder that cannot be written fails the call, and the manifest exists once it returns.
      await writeJsonAtomic(manifest, run.snapshot());
    } catch (error) {
      this.#runs.delete(key);
      throw error;
    }
    void run.ended.then(() => {
      if (this.#runs.get(key) === run) this.#runs.delete(key);
    });
    const jobs = run.start();
    return { ...base, manifest, dryRun: false, entries: run.snapshot().entries, jobs };
  }

  /**
   * Stop the batch of `request.file` rendering into `out`: no further row is queued, the running row's jobs are
   * canceled and every entry not ended becomes `canceled`. Waits (up to {@link CANCEL_WAIT_MS}) until the running
   * render stopped and the manifest says `canceled`. Throws InvalidOperation when no such batch is rendering.
   */
  async cancel(root: string, cwd: string, request: BatchCancelRequest): Promise<BatchCancelResult> {
    const path = resolve(cwd, request.file);
    const out = request.out ?? join(root, "exports", batchName(path));
    const run = this.#runs.get(canonicalPathSync(out));
    const refuse = (reason: string, message: string) => new RpcError(ErrorCode.InvalidOperation, message, { op: "batch.cancel", reason, field: "out" });
    if (!run || run.finished) throw refuse("no batch running", `No batch is rendering into ${out}. \`job.list\` shows what is running.`);
    if (canonicalPathSync(run.batch) !== canonicalPathSync(path)) {
      throw refuse("other batch", `The batch rendering into ${out} is ${run.batch}, not ${path}.`);
    }
    const canceled = run.cancel();
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([run.ended, new Promise<void>((done) => (timer = setTimeout(done, CANCEL_WAIT_MS)))]);
    clearTimeout(timer);
    return { dir: root, file: path, out, manifest: join(out, "manifest.json"), state: run.finished ? "canceled" : "running", canceled, entries: run.snapshot().entries };
  }

  /** `review` of the file `entry` wrote: metrics only, as the batch's `view` of the project (`current`). Never throws. */
  async #review(root: string, template: string, entry: BatchEntry, preset: string | null, listed: boolean): Promise<BatchReview> {
    try {
      const result = await this.#options.review!(root, {
        timeline: template,
        file: entry.output,
        sheets: ["metrics"],
        view: "current",
        ...(preset ? { preset } : {}),
        // Only for the delivery plan of a file: the primary format needs no name.
        ...(preset && listed ? { projectFormat: entry.format } : {}),
      });
      const craft = result.metrics?.craft ?? [];
      const failed = result.metrics?.requirements?.failed ?? 0;
      return {
        state: "done",
        verdict: reviewVerdict(craft.length, failed),
        warnings: craft.length,
        failed,
        checks: [...new Set(craft.map((warning) => warning.check))],
        run: result.run,
        error: null,
      };
    } catch (error) {
      return { state: "error", verdict: null, warnings: 0, failed: 0, checks: [], run: null, error: (error as Error).message.split("\n")[0] ?? "The review failed." };
    }
  }

  /** True while a batch of the project at `root` has rows left to render (gc keeps clip renders then). */
  active(root: string): boolean {
    const key = canonicalPathSync(root);
    return [...this.#runs.values()].some((run) => !run.finished && canonicalPathSync(run.root) === key);
  }
}

/** One batch being rendered: queues rows in turn and keeps `manifest.json` current. */
class BatchRun {
  readonly root: string;
  /** Resolves once the batch ended and the manifest says so. */
  readonly ended: Promise<void>;
  /** True once every row ended, although the manifest may not say so yet. */
  get finished(): boolean {
    return this.#finishedAt !== null;
  }
  /** Absolute path of the batch file. */
  get batch(): string {
    return this.#where.batch;
  }

  readonly #where: { batch: string; template: string; out: string; manifest: string };
  readonly #rows: PlannedRow[];
  /** Entries of the rows this run does not render, as the manifest of the run before left them. */
  readonly #kept: BatchEntry[];
  /** Row ids in the batch file's order. */
  readonly #order: readonly string[];
  readonly #jobs: JobQueue;
  readonly #byJob = new Map<string, BatchEntry>();
  readonly #startedAt = new Date().toISOString();
  #finishedAt: string | null = null;
  /** Set by {@link cancel}: no row is queued and no review starts any more. */
  #canceled = false;
  /** Rows whose render {@link cancel} stopped or kept from starting. */
  readonly #canceledRows = new Set<string>();
  #next = 0;
  #unwatch: () => void = () => {};
  #dirty = false;
  #writing = false;
  #resolveEnded: () => void = () => {};
  /** Reviews the batch runs, or null; one at a time, so they never compete with each other for the CPU. */
  readonly #reviewer: ((entry: BatchEntry) => Promise<BatchReview>) | null;
  /** Entries `pending` a review, in the order they will run. */
  readonly #reviewQueue: BatchEntry[] = [];
  #reviewing = false;
  readonly #unreviewed: readonly BatchEntry[];

  constructor(
    root: string,
    where: { batch: string; template: string; out: string; manifest: string },
    rows: PlannedRow[],
    kept: BatchEntry[],
    order: readonly string[],
    jobs: JobQueue,
    reviewer: ((entry: BatchEntry) => Promise<BatchReview>) | null,
    /** Entries among `kept` that are rendered but have no finished review. */
    unreviewed: readonly BatchEntry[],
  ) {
    this.root = root;
    this.#reviewer = reviewer;
    this.#where = where;
    this.#rows = rows;
    this.#kept = kept;
    this.#order = order;
    this.#jobs = jobs;
    this.ended = new Promise((resolve) => (this.#resolveEnded = resolve));
    this.#unreviewed = unreviewed;
    for (const entry of unreviewed) entry.review = pendingReview();
  }

  /** Resolves once the manifest says `done` when the batch has finished; at once while it still has rows left. */
  flushed(): Promise<void> {
    return this.finished ? this.ended : Promise.resolve();
  }

  /** Queue the first row; returns its jobs. */
  start(): JobInfo[] {
    this.#unwatch = this.#jobs.watch((change) => this.#changed(change));
    const first = this.#rows[this.#next];
    for (const entry of this.#unreviewed) this.#queueReview(entry);
    this.#advance();
    return (first?.entries ?? []).flatMap((entry) => {
      const job = entry.job ? this.#jobs.get(entry.job) : undefined;
      return job ? [job] : [];
    });
  }

  /**
   * Stop the batch: rows not queued yet become `canceled` and are never queued, reviews still waiting are dropped,
   * and the render jobs of the row in progress are canceled (a running one ends `canceled` when it stops, and then
   * the manifest says so). Returns the ids of the rows it stopped or kept from starting, in file order; a second
   * call changes nothing.
   */
  cancel(): string[] {
    if (!this.#canceled && !this.finished) {
      this.#canceled = true;
      const at = new Date().toISOString();
      for (const row of this.#rows.slice(this.#next)) {
        this.#canceledRows.add(row.id);
        for (const entry of row.entries) {
          entry.status = "canceled";
          entry.error = "The batch was canceled before this render started.";
          entry.finishedAt = at;
        }
      }
      for (const entry of this.#reviewQueue.splice(0)) entry.review = null;
      for (const entry of this.#rows[this.#next - 1]?.entries ?? []) {
        if (ended(entry) || !entry.job) continue;
        this.#canceledRows.add(entry.row);
        // A queued job ends at once and reaches `#changed` before this returns; a running one stops later.
        this.#jobs.cancel(entry.job);
      }
      this.#persist();
      this.#finish();
    }
    return this.#rows.filter((row) => this.#canceledRows.has(row.id)).map((row) => row.id);
  }

  snapshot(): BatchManifest {
    return {
      ...this.#where,
      state: this.#finishedAt ? (this.#canceled ? "canceled" : "done") : "running",
      startedAt: this.#startedAt,
      finishedAt: this.#finishedAt,
      entries: orderEntries(this.#order, [...this.#kept, ...this.#rows.flatMap((row) => row.entries)]).map((entry) => ({ ...entry, warnings: [...entry.warnings] })),
    };
  }

  #changed({ job, stateChanged }: JobChange): void {
    const entry = this.#byJob.get(job.id);
    if (!entry || !stateChanged) return;
    record(entry, job);
    this.#settle(entry);
    const current = this.#rows[this.#next - 1];
    if (current?.entries.every(ended)) this.#advance();
    else this.#persist();
  }

  /** A render's entry ended: a `done` one is reviewed when asked, another has no file to review. */
  #settle(entry: BatchEntry): void {
    if (!ended(entry) || !this.#reviewer) return;
    if (entry.status === "done") this.#queueReview(entry);
    else entry.review = null;
  }

  #queueReview(entry: BatchEntry): void {
    if (this.#canceled) {
      entry.review = null;
      return;
    }
    if (this.#reviewQueue.includes(entry)) return;
    entry.review = pendingReview();
    this.#reviewQueue.push(entry);
    void this.#reviewNext();
  }

  /** Run the queued reviews in turn; each result is written to its entry and the manifest. */
  async #reviewNext(): Promise<void> {
    if (this.#reviewing) return;
    this.#reviewing = true;
    for (let entry = this.#reviewQueue.shift(); entry; entry = this.#reviewQueue.shift()) {
      entry.review = await this.#reviewer!(entry);
      this.#persist();
    }
    this.#reviewing = false;
    this.#finish();
  }

  /** Ends the batch once every row ended and no review is left. */
  #finish(): void {
    if (this.#finishedAt || (!this.#canceled && this.#next < this.#rows.length) || !this.#rows.every((row) => row.entries.every(ended)) || this.#reviewing || this.#reviewQueue.length > 0) return;
    this.#finishedAt = new Date().toISOString();
    this.#unwatch();
    this.#persist();
  }

  /**
   * Queue rows until one has a job still queued or running. `start` queues synchronously and the watcher ignores
   * the jobs until their ids are known, so each job's snapshot after `start` is taken as its state.
   */
  #advance(): void {
    while (!this.#canceled && this.#next < this.#rows.length) {
      const row = this.#rows[this.#next++]!;
      const queued = row.planned.start();
      queued.renders.forEach((render, index) => {
        const entry = row.entries[index]!;
        entry.job = render.job.id;
        this.#byJob.set(render.job.id, entry);
        record(entry, this.#jobs.get(render.job.id) ?? render.job);
        this.#settle(entry);
      });
      if (!row.entries.every(ended)) break;
    }
    this.#persist();
    this.#finish();
  }

  /** Write the manifest; writes never overlap, and the last one carries the latest state. */
  #persist(): void {
    this.#dirty = true;
    if (this.#writing) return;
    this.#writing = true;
    void (async () => {
      while (this.#dirty) {
        this.#dirty = false;
        // A failed write (disk full, folder removed) must not stop the renders; the next change writes again.
        await writeJsonAtomic(this.#where.manifest, this.snapshot()).catch(() => {});
      }
      this.#writing = false;
      if (this.#finishedAt) this.#resolveEnded();
    })();
  }
}

/** The review of an entry whose render is queued or running, or whose file is waiting for its turn. */
function pendingReview(): BatchReview {
  return { state: "pending", verdict: null, warnings: 0, failed: 0, checks: [], run: null, error: null };
}

/** The entries of `entries` that are `done` with the file in place but have no finished review. */
async function needReview(entries: readonly BatchEntry[]): Promise<BatchEntry[]> {
  const found: BatchEntry[] = [];
  for (const entry of entries) if (entry.status === "done" && entry.review?.state !== "done" && (await exists(entry.output))) found.push(entry);
  return found;
}

/** `entries` by the batch file's row order, then the order they came in (format order within a row). */
function orderEntries(ids: readonly string[], entries: readonly BatchEntry[]): BatchEntry[] {
  const at = new Map(ids.map((id, index) => [id, index]));
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => at.get(a.entry.row)! - at.get(b.entry.row)! || a.index - b.index)
    .map(({ entry }) => entry);
}

/**
 * The entries a manifest left in `path` for the batch file `batch`; none when there is no manifest, it is not valid or
 * it is another batch file's (its rows say nothing about this one). `failed` needs it, so it throws then.
 */
async function readManifest(path: string, batch: string, failed: boolean): Promise<BatchEntry[]> {
  const needed = (reason: string, why: string) =>
    new RpcError(ErrorCode.InvalidOperation, `\`failed\` re-runs the rows a manifest lists as not done, but ${why}. Render the batch once, or name the rows with \`rows\`.`, {
      op: "batch.render",
      reason,
      field: "failed",
      manifest: path,
    });
  let json: unknown;
  try {
    json = await readJsonIfExists(path);
  } catch {
    json = null;
  }
  if (json === undefined) {
    if (failed) throw needed("no manifest", `there is no ${path}`);
    return [];
  }
  const parsed = BatchManifestSchema.safeParse(json);
  if (!parsed.success) {
    if (failed) throw needed("manifest unreadable", `${path} is not a valid manifest`);
    return [];
  }
  if (canonicalPathSync(parsed.data.batch) !== canonicalPathSync(batch)) {
    if (failed) throw needed("manifest of another batch", `${path} belongs to ${parsed.data.batch}`);
    return [];
  }
  return parsed.data.entries;
}

/**
 * What a chosen row needs: `skip` when every planned entry has a `done` entry for the same output in `earlier`, the
 * file is still there and the data it was made from is the same; `changed` when only that data differs (an earlier
 * entry with no hash, from before hashes, counts as the same); else `render`.
 */
async function renderedState(earlier: readonly BatchEntry[], row: string, planned: readonly BatchEntry[]): Promise<"skip" | "changed" | "render"> {
  let changed = false;
  for (const entry of planned) {
    const was = earlier.find((other) => other.row === row && other.output === entry.output);
    if (was?.status !== "done" || !(await exists(entry.output))) return "render";
    if (was.hash !== null && was.hash !== entry.hash) changed = true;
  }
  return changed ? "changed" : "skip";
}

/** Fingerprint of what a row's render is made from: its cells, the batch file's slots and the template's content. */
function rowHash(row: object, slots: Record<string, string>, template: string): string {
  return createHash("sha256").update(canonicalJson({ row, slots, template })).digest("hex").slice(0, 32);
}

/** True for an entry whose job ended. */
function ended(entry: BatchEntry): boolean {
  return entry.status === "done" || entry.status === "failed" || entry.status === "canceled";
}

/** Copy a job snapshot's state into its manifest entry. */
function record(entry: BatchEntry, job: JobInfo): void {
  entry.status = job.state;
  entry.error = job.error;
  entry.startedAt = job.startedAt;
  entry.finishedAt = job.finishedAt;
  entry.duration = job.startedAt && job.finishedAt ? (Date.parse(job.finishedAt) - Date.parse(job.startedAt)) / 1000 : null;
}

/** `launch.batch.json` → `launch`: the default output folder's name. */
function batchName(path: string): string {
  return basename(path).replace(/(\.batch)?\.json$/i, "");
}

/**
 * The batch file with its rows in hand: those written in it, or read from its `csv` (relative to the batch file's
 * folder) and typed by the template's values. Throws AssetNotFound for a missing CSV file, InvalidProjectFile naming
 * the line and column of every cell that is wrong.
 */
async function resolveRows(path: string, file: BatchFile, template: Timeline): Promise<ResolvedBatchFile> {
  if (file.rows) return { ...file, rows: file.rows };
  const csv = resolve(dirname(path), file.csv!);
  let text: string;
  try {
    text = await readFile(csv, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    throw new RpcError(ErrorCode.AssetNotFound, `No rows file ${csv}, which ${path} names as its \`csv\`.`, { path: csv });
  }
  const rows = rowsFromCsv(text, csv, file.slots, templateColumnTypes(template, file.slots));
  const resolved = withRows(file, rows);
  if (!resolved.ok) throw new RpcError(ErrorCode.InvalidProjectFile, `Invalid rows file ${csv}:\n${resolved.error}`, { path: csv, details: resolved.error });
  return resolved.value;
}

/** Parsed batch file; throws AssetNotFound when missing, InvalidProjectFile when it is not a valid one. */
async function readBatchFile(path: string): Promise<BatchFile> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    throw new RpcError(ErrorCode.AssetNotFound, `No batch file ${path}. Write one (\`*.batch.json\`, JSON Schema \`batch.json\`) first.`, { path });
  }
  const invalid = (details: string) => new RpcError(ErrorCode.InvalidProjectFile, `Invalid batch file ${path}:\n${details}`, { path, details });
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw invalid(`not JSON: ${(error as Error).message}`);
  }
  const parsed = parseBatchFile(json);
  if (!parsed.ok) throw invalid(parsed.error);
  return parsed.value;
}
