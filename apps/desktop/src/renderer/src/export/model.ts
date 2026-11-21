// Export video (#738): what the preview's button and status show for the window's export, pure.
import type { JobInfo } from "@frameshell/protocol";

/** One export this window started: the daemon's `render` job as last heard, and what the start said. */
export interface VideoExport {
  /** Absolute file the job writes. */
  output: string;
  /** What the export leaves out (daemon `render` `warnings`). */
  warnings: string[];
  job: JobInfo;
}

/** What the button and status show. */
export type ExportView =
  | { kind: "idle" }
  /** The save dialog is open, or `render` was asked and has not answered. */
  | { kind: "starting" }
  /** `percent`: whole percent done; `waiting`: queued behind other jobs. */
  | { kind: "running"; percent: number; waiting: boolean }
  | { kind: "done"; file: string; output: string; warnings: string[] }
  | { kind: "failed"; message: string };

/** The view of the window's export: `starting` while asking, else the last export (null: none yet), else `error` from the start. */
export function exportView(current: VideoExport | null, starting: boolean, error: string | null): ExportView {
  if (starting) return { kind: "starting" };
  if (error !== null) return { kind: "failed", message: error };
  if (!current) return { kind: "idle" };
  const { job, output, warnings } = current;
  if (job.state === "queued" || job.state === "running") return { kind: "running", percent: Math.floor(job.progress * 100), waiting: job.state === "queued" };
  if (job.state === "done") return { kind: "done", file: output.split(/[\\/]/).pop() ?? output, output, warnings: [...warnings, ...job.warnings] };
  return { kind: "failed", message: job.error ?? job.state };
}

/** `current` after `job` was heard: the same export with its new state; other jobs, and a reconnect (null), change nothing. */
export function heardJob(current: VideoExport | null, job: JobInfo | null): VideoExport | null {
  return current && job && job.id === current.job.id ? { ...current, job } : current;
}
