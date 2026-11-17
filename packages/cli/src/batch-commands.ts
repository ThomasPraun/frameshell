import { readFile } from "node:fs/promises";
import { type BatchCancelResult, type BatchEntry, BatchManifestSchema, type BatchRenderResult } from "@frameshell/protocol";
import { UsageError } from "./timeline-commands.js";

/** Help text of `batch` (ADR 0040), in `frameshell --help`. */
export const BATCH_USAGE = `  batch cancel <file.batch.json> [--out dir]
                               Stop the batch that is rendering: no further row starts, the running render is canceled, the
                               manifest says canceled. Ctrl-C in \`batch\` asks the same. Re-run the rest with --failed.
  batch <file.batch.json> [--out dir] [--formats id,id] [--rows id,a..c] [--failed] [--force] [--review] [--dry-run] [--yes]
                               Render variants of a template timeline from data rows (in the file or its csv): each row sets
                               clip props, swaps assets or places a voiceover in memory (never under timelines/), every row x
                               format is validated first, then the rows render one at a time into exports/<batch name>/ with
                               manifest.json. --dry-run checks only.
                               Re-run: --rows renders only those rows (ids, or first..last in file order), --failed the rows
                               the manifest lists as not done (failed, canceled, or left running by a stopped daemon).
                               A row whose renders are all done with the files in place is skipped unless --force or its data
                               (cells, slots, template timeline) changed since: it then renders again, listed as changed.
                               --review: review each rendered file (metrics only) and record pass/warn/fail in manifest.json
                               Blender clips (and other plugins with finals): unless the batch quality is draft, the rows
                               render their finals first. Over 5 minutes estimated for all rows: refused until --yes,
                               which you pass only after the person agreed to wait
`;

/** Flags `batch` takes besides the global ones. */
export const BATCH_FLAGS: Record<string, readonly string[]> = {
  batch: ["out", "formats", "rows", "failed", "force", "review", "dry-run", "yes"],
};

/** A parsed `batch` command. */
export interface BatchInvocation {
  kind: "batch";
  file: string;
  out?: string;
  formats?: string[];
  /** Row ids or `first..last` ranges. */
  rows?: string[];
  failed: boolean;
  force: boolean;
  review: boolean;
  dryRun: boolean;
  /** The person agreed to wait for the final renders the rows make (ADR 0035). */
  yes: boolean;
}

/** A parsed `batch cancel` command. */
export interface BatchCancelInvocation {
  kind: "batch.cancel";
  file: string;
  out?: string;
}

/** Parse `batch <file> …` or `batch cancel <file>`; null when the shape is wrong. Throws `UsageError` for a bad flag value. */
export function parseBatch(
  rest: string[],
  options: { out?: string | undefined; formats?: string | undefined; rows?: string | undefined; failed: boolean; force?: boolean | undefined; review?: boolean | undefined; "dry-run": boolean; yes?: boolean | undefined },
): BatchInvocation | BatchCancelInvocation | null {
  if (rest[0] === "cancel" && rest.length === 2) return { kind: "batch.cancel", file: rest[1]!, ...(options.out ? { out: options.out } : {}) };
  if (rest.length !== 1) return null;
  const formats = list(options.formats);
  if (formats !== undefined && formats.length === 0) throw new UsageError("--formats takes format ids separated by commas, e.g. --formats 16x9,9x16.");
  const rows = list(options.rows);
  if (rows !== undefined && rows.length === 0) throw new UsageError("--rows takes row ids separated by commas, or a range, e.g. --rows es,fr or --rows es..de.");
  return {
    kind: "batch",
    file: rest[0]!,
    ...(options.out ? { out: options.out } : {}),
    ...(formats ? { formats } : {}),
    ...(rows ? { rows } : {}),
    failed: options.failed,
    force: options.force === true,
    review: options.review === true,
    dryRun: options["dry-run"],
    yes: options.yes === true,
  };
}

/** `a, b` → `["a", "b"]`; undefined when the flag is absent. */
function list(value: string | undefined): string[] | undefined {
  return value?.split(",").map((id) => id.trim()).filter((id) => id !== "");
}

/** What a batch will render (dry run) or has queued: one line per row × format, with its warnings, and the rows left alone. */
export function describeBatch(result: BatchRenderResult): string {
  const todo = result.entries.filter((entry) => entry.status === "planned" || entry.status === "queued" || entry.status === "running");
  const head = result.dryRun
    ? `Batch ${result.file} checks out: ${rowCount(todo)} row(s) of timelines/${result.template}.json, nothing rendered`
    : todo.length === 0
      ? `Batch ${result.file}: nothing to render`
      : `Batch ${result.file}: ${rowCount(todo)} row(s) of timelines/${result.template}.json, one row at a time; manifest ${result.manifest}`;
  const lines = todo.flatMap((entry) => [`  ${batchLabel(entry)} -> ${entry.output}`, ...entry.warnings.map((warning) => `    warning: ${warning}`)]);
  const skipped = result.skipped.length > 0 ? [`  skipped (done, files in place; --force renders them again): ${result.skipped.join(", ")}`] : [];
  const changed = result.changed.length > 0 ? [`  changed since their last render, rendered again: ${result.changed.join(", ")}`] : [];
  return `${[head, ...lines, ...changed, ...skipped].join("\n")}\n`;
}

/** What `batch cancel` stopped: the rows that will not render, and where the manifest is. */
export function describeCancel(result: BatchCancelResult): string {
  const pending = result.state === "running" ? "; the running render has not stopped yet" : "";
  return `${canceledLine(result.file, result.canceled)}${pending}. Manifest: ${result.manifest}\n`;
}

/** `Batch x.batch.json canceled (rows not rendered: es, fr)`. */
export function canceledLine(file: string, rows: readonly string[]): string {
  return `Batch ${file} canceled (${rows.length > 0 ? `rows not rendered: ${rows.join(", ")}` : "every row had rendered already"})`;
}

/** Row ids of the entries a cancel left `canceled`, in order, each once. */
export function canceledRows(entries: readonly BatchEntry[]): string[] {
  return [...new Set(entries.filter((entry) => entry.status === "canceled").map((entry) => entry.row))];
}

/**
 * Watch the manifest at `path` for `"state": "canceled"`, which another `batch cancel` (or an agent's `batch.cancel`)
 * writes: the rows it kept from starting have no job, so waiting for their files would never end. `canceled` resolves
 * with the manifest's entries and never otherwise; `stop` ends the polling.
 */
export function watchCanceled(path: string, pause = 500): { canceled: Promise<BatchEntry[]>; stop: () => void } {
  let stopped = false;
  const canceled = (async () => {
    while (!stopped) {
      await new Promise((resolve) => setTimeout(resolve, pause));
      try {
        const parsed = BatchManifestSchema.safeParse(JSON.parse(await readFile(path, "utf8")));
        if (parsed.success && parsed.data.state === "canceled") return parsed.data.entries;
      } catch {
        // Replaced atomically, so a read between two writes can only miss the file: ask again.
      }
    }
    return new Promise<BatchEntry[]>(() => {});
  })();
  return { canceled, stop: () => void (stopped = true) };
}

/**
 * Resolve once the person presses Ctrl-C (SIGINT), the first time only: a second one ends the CLI as usual, so a
 * stuck cancel can still be left. `dispose` removes the handler.
 */
export function onInterrupt(): { interrupted: Promise<void>; dispose: () => void } {
  let handler: () => void = () => {};
  const interrupted = new Promise<void>((resolve) => {
    handler = resolve;
    process.once("SIGINT", handler);
  });
  return { interrupted, dispose: () => void process.off("SIGINT", handler) };
}

/** The outcome per row × format once every render ended. */
export function batchOutcome(entries: readonly BatchEntry[]): string {
  return entries
    .map((entry) => (entry.status === "done" ? `Rendered ${entry.output}\n${reviewLine(entry)}` : `Render ${entry.status}: ${batchLabel(entry)}: ${entry.error ?? entry.status}\n`))
    .join("");
}

/** `  review: warn (2 warnings: static, peak), run 14`; empty when the entry has no review. */
function reviewLine(entry: Pick<BatchEntry, "review">): string {
  const review = entry.review;
  if (!review) return "";
  if (review.state === "error") return `  review failed: ${review.error ?? "unknown error"}\n`;
  if (review.state === "pending") return "  review pending\n";
  const what = review.failed > 0 ? `${review.failed} failed` : review.warnings > 0 ? `${review.warnings} warning${review.warnings === 1 ? "" : "s"}` : "";
  const detail = [what, review.checks.length > 0 ? review.checks.join(", ") : ""].filter((part) => part !== "").join(": ");
  return `  review: ${review.verdict}${detail ? ` (${detail})` : ""}, run ${review.run} (.frameshell/review/${review.run}/metrics.json)\n`;
}

/** `es [9x16]`: the row and its format. */
export function batchLabel(entry: Pick<BatchEntry, "row" | "format">): string {
  return `${entry.row} [${entry.format}]`;
}

function rowCount(entries: readonly BatchEntry[]): number {
  return new Set(entries.map((entry) => entry.row)).size;
}

/**
 * The entries of the manifest at `path` once it says `done`: the reviews finish after the render jobs, so the
 * daemon's manifest is where they are read. Polls; gives up with no entries when the file is not a valid manifest.
 */
export async function waitReviews(path: string, pause = 400): Promise<BatchEntry[]> {
  for (;;) {
    let json: unknown;
    try {
      json = JSON.parse(await readFile(path, "utf8"));
    } catch {
      // Replaced atomically, so a read between two writes can only miss the file: ask again.
      await new Promise((resolve) => setTimeout(resolve, pause));
      continue;
    }
    const parsed = BatchManifestSchema.safeParse(json);
    if (!parsed.success) return [];
    if (parsed.data.state !== "running") return parsed.data.entries;
    await new Promise((resolve) => setTimeout(resolve, pause));
  }
}
