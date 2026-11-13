import type { BatchEntry, BatchRenderResult } from "@frameshell/protocol";
import { UsageError } from "./timeline-commands.js";

/** Help text of `batch` (ADR 0040), in `frameshell --help`. */
export const BATCH_USAGE = `  batch <file.batch.json> [--out dir] [--formats id,id] [--dry-run]
                               Render variants of a template timeline from data rows: each row sets clip props or swaps
                               assets in memory (never under timelines/), every row x format is validated first, then the
                               rows render one at a time into exports/<batch name>/ with manifest.json. --dry-run checks only
`;

/** Flags `batch` takes besides the global ones. */
export const BATCH_FLAGS: Record<string, readonly string[]> = {
  batch: ["out", "formats", "dry-run"],
};

/** A parsed `batch` command. */
export interface BatchInvocation {
  kind: "batch";
  file: string;
  out?: string;
  formats?: string[];
  dryRun: boolean;
}

/** Parse `batch <file> …`; null when the shape is wrong. Throws `UsageError` for a bad flag value. */
export function parseBatch(rest: string[], options: { out?: string | undefined; formats?: string | undefined; "dry-run": boolean }): BatchInvocation | null {
  if (rest.length !== 1) return null;
  const formats = options.formats?.split(",").map((id) => id.trim()).filter((id) => id !== "");
  if (formats !== undefined && formats.length === 0) throw new UsageError("--formats takes format ids separated by commas, e.g. --formats 16x9,9x16.");
  return { kind: "batch", file: rest[0]!, ...(options.out ? { out: options.out } : {}), ...(formats ? { formats } : {}), dryRun: options["dry-run"] };
}

/** What a batch will render (dry run) or has queued: one line per row × format, with its warnings. */
export function describeBatch(result: BatchRenderResult): string {
  const head = result.dryRun
    ? `Batch ${result.file} checks out: ${rowCount(result.entries)} row(s) of timelines/${result.template}.json, nothing rendered`
    : `Batch ${result.file}: ${rowCount(result.entries)} row(s) of timelines/${result.template}.json, one row at a time; manifest ${result.manifest}`;
  const lines = result.entries.flatMap((entry) => [`  ${batchLabel(entry)} -> ${entry.output}`, ...entry.warnings.map((warning) => `    warning: ${warning}`)]);
  return `${[head, ...lines].join("\n")}\n`;
}

/** The outcome per row × format once every render ended. */
export function batchOutcome(entries: readonly BatchEntry[]): string {
  return entries
    .map((entry) => (entry.status === "done" ? `Rendered ${entry.output}\n` : `Render ${entry.status}: ${batchLabel(entry)}: ${entry.error ?? entry.status}\n`))
    .join("");
}

/** `es [9x16]`: the row and its format. */
export function batchLabel(entry: Pick<BatchEntry, "row" | "format">): string {
  return `${entry.row} [${entry.format}]`;
}

function rowCount(entries: readonly BatchEntry[]): number {
  return new Set(entries.map((entry) => entry.row)).size;
}
