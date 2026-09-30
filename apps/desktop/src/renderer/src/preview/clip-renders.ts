// Render cache state of the timeline's generated clips (SPEC §6.5): read with `clip.renders`, kept live by `clip` job events.
import type { ClipRenderInfo, JobInfo } from "@frameshell/protocol";

/** Clip id to render state. */
export type ClipRenders = ReadonlyMap<string, ClipRenderInfo>;

/**
 * Fold one `clip` job event into `renders`. Progress of a known render
 * updates in place; anything else (a render finished, failed, or started
 * for a key no clip has yet: a composition edit) asks for a re-read.
 * Returns the same map when nothing changed.
 */
export function applyClipJob(renders: ClipRenders, job: JobInfo): { renders: ClipRenders; refetch: boolean } {
  const key = job.output?.split(/[\\/]/).at(-1) ?? null;
  const matches = [...renders.values()].filter((info) => info.job === job.id || (key !== null && info.key === key && info.state !== "ready"));
  if (job.state !== "queued" && job.state !== "running") return { renders, refetch: true };
  if (matches.length === 0) return { renders, refetch: true };
  const state = job.state === "running" ? "rendering" : "queued";
  let changed = false;
  const next = new Map(renders);
  for (const info of matches) {
    if (info.state === state && info.progress === job.progress && info.job === job.id) continue;
    next.set(info.clip, { ...info, state, progress: job.progress, job: job.id });
    changed = true;
  }
  return { renders: changed ? next : renders, refetch: false };
}
