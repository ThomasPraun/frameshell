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
  const runs = (render: { job: string | null; key: string | null; state: string }) =>
    render.job === job.id || (key !== null && render.key === key && render.state !== "ready");
  // A clip with motion blur has a second render, `final` (ADR 0041): its job is followed the same way.
  const matches = [...renders.values()].filter((info) => runs(info) || (info.final !== undefined && runs(info.final)));
  if (job.state !== "queued" && job.state !== "running") return { renders, refetch: true };
  if (matches.length === 0) return { renders, refetch: true };
  const state = job.state === "running" ? "rendering" : "queued";
  const current = (render: { state: string; progress: number; job: string | null }) =>
    render.state === state && render.progress === job.progress && render.job === job.id;
  const progress = { state, progress: job.progress, job: job.id } as const;
  let changed = false;
  const next = new Map(renders);
  for (const info of matches) {
    const final = info.final;
    if (runs(info) ? current(info) : current(final!)) continue;
    next.set(info.clip, runs(info) ? { ...info, ...progress } : { ...info, final: { ...final!, ...progress } });
    changed = true;
  }
  return { renders: changed ? next : renders, refetch: false };
}
