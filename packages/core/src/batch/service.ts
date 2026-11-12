import { mkdir, readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { type BatchEntry, type BatchManifest, type BatchRenderResult, ErrorCode, type JobInfo, RpcError } from "@frameshell/protocol";
import { type BatchFile, type Timeline, parseBatchFile } from "@frameshell/schema";
import type { PlannedRender, RenderRequest } from "../export/service.js";
import { canonicalPathSync, writeJsonAtomic } from "../fs-util.js";
import type { JobChange, JobQueue } from "../jobs/queue.js";
import type { AppliedOperation, OperationRequest, SourceInfo } from "../timeline/engine.js";
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
  /** See `ExportService.planRender`. */
  planRender(root: string, params: RenderRequest, loaded: { timeline: Timeline; fps: number }): Promise<PlannedRender>;
}

/** Params of {@link BatchService.render}; see the daemon method `batch.render`. */
export interface BatchRequest {
  /** Batch file, absolute or relative to `cwd`. */
  file: string;
  /** Absolute output folder; default `<root>/exports/<batch name>/`. */
  out?: string | undefined;
  /** Instead of the file's `formats`. */
  formats?: readonly string[] | undefined;
  dryRun: boolean;
}

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
    const path = resolve(cwd, request.file);
    const file = await readBatchFile(path);
    const out = request.out ?? join(root, "exports", batchName(path));
    const loaded = await this.#options.loadTimeline(root, file.template);
    const formats = request.formats ?? file.formats;
    const context = {
      fps: loaded.fps,
      apply: async (timeline: Timeline, op: OperationRequest) => this.#options.applyInMemory(root, file.template, { timeline, fps: loaded.fps }, op),
      source: (asset: string) => this.#options.source(root, asset),
      hasTranscript: (asset: string) => this.#options.hasTranscript(root, asset),
    };
    const rows: PlannedRow[] = [];
    // Format ids may hold `-`, so row `a` in format `web-1x1` and row `a-web` in `1x1` both write `a-web-1x1.mp4`.
    const outputs = new Map<string, string>();
    for (const row of file.rows) {
      const variant = await rowVariant(loaded.timeline, file, row, context);
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
        warnings: [...render.warnings, ...planned.provenance],
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
      rows.push({ id: row.id, planned, entries });
    }
    const first = rows[0]!.planned.result;
    const base = { dir: root, file: path, template: file.template, out, preset: first.preset, quality: first.quality };
    if (request.dryRun) return { ...base, manifest: null, dryRun: true, entries: rows.flatMap((row) => row.entries), jobs: [] };

    const manifest = join(out, "manifest.json");
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
    const run = new BatchRun(root, { batch: path, template: file.template, out, manifest }, rows, this.#options.jobs);
    this.#runs.set(key, run);
    try {
      // Before any job: an out folder that cannot be written fails the call, and the manifest exists once it returns.
      await writeJsonAtomic(manifest, run.snapshot());
    } catch (error) {
      this.#runs.delete(key);
      throw error;
    }
    void run.ended.then(() => this.#runs.delete(key));
    const jobs = run.start();
    return { ...base, manifest, dryRun: false, entries: run.snapshot().entries, jobs };
  }

  /** True while a batch of the project at `root` has rows left to render (gc keeps clip renders then). */
  active(root: string): boolean {
    const key = canonicalPathSync(root);
    return [...this.#runs.values()].some((run) => canonicalPathSync(run.root) === key);
  }
}

/** One batch being rendered: queues rows in turn and keeps `manifest.json` current. */
class BatchRun {
  readonly root: string;
  /** Resolves once the batch ended and the manifest says so. */
  readonly ended: Promise<void>;
  readonly #where: { batch: string; template: string; out: string; manifest: string };
  readonly #rows: PlannedRow[];
  readonly #jobs: JobQueue;
  readonly #byJob = new Map<string, BatchEntry>();
  readonly #startedAt = new Date().toISOString();
  #finishedAt: string | null = null;
  #next = 0;
  #unwatch: () => void = () => {};
  #dirty = false;
  #writing = false;
  #resolveEnded: () => void = () => {};

  constructor(
    root: string,
    where: { batch: string; template: string; out: string; manifest: string },
    rows: PlannedRow[],
    jobs: JobQueue,
  ) {
    this.root = root;
    this.#where = where;
    this.#rows = rows;
    this.#jobs = jobs;
    this.ended = new Promise((resolve) => (this.#resolveEnded = resolve));
  }

  /** Queue the first row; returns its jobs. */
  start(): JobInfo[] {
    this.#unwatch = this.#jobs.watch((change) => this.#changed(change));
    const first = this.#next;
    this.#advance();
    return this.#rows[first]!.entries.flatMap((entry) => {
      const job = entry.job ? this.#jobs.get(entry.job) : undefined;
      return job ? [job] : [];
    });
  }

  snapshot(): BatchManifest {
    return {
      ...this.#where,
      state: this.#finishedAt ? "done" : "running",
      startedAt: this.#startedAt,
      finishedAt: this.#finishedAt,
      entries: this.#rows.flatMap((row) => row.entries.map((entry) => ({ ...entry, warnings: [...entry.warnings] }))),
    };
  }

  #changed({ job, stateChanged }: JobChange): void {
    const entry = this.#byJob.get(job.id);
    if (!entry || !stateChanged) return;
    record(entry, job);
    const current = this.#rows[this.#next - 1];
    if (current?.entries.every(ended)) this.#advance();
    else this.#persist();
  }

  /**
   * Queue rows until one has a job still queued or running. `start` queues synchronously and the watcher ignores
   * the jobs until their ids are known, so each job's snapshot after `start` is taken as its state.
   */
  #advance(): void {
    while (this.#next < this.#rows.length) {
      const row = this.#rows[this.#next++]!;
      const queued = row.planned.start();
      queued.renders.forEach((render, index) => {
        const entry = row.entries[index]!;
        entry.job = render.job.id;
        this.#byJob.set(render.job.id, entry);
        record(entry, this.#jobs.get(render.job.id) ?? render.job);
      });
      if (!row.entries.every(ended)) break;
    }
    if (this.#next >= this.#rows.length && this.#rows.every((row) => row.entries.every(ended))) {
      this.#finishedAt = new Date().toISOString();
      this.#unwatch();
    }
    this.#persist();
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
