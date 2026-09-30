import type { Clip, Timeline } from "@frameshell/schema";
import type { FrameGrid } from "./grid.js";

/** Derived duration of a nested timeline file, project-relative. */
export type NestedDuration = (source: string) => Promise<number>;

/**
 * Timeline time just after the last frame of `clip`, on the grid. Media:
 * `(out - in) / speed`; nested timelines without `duration` play to the end
 * of the nested file; adapter clips carry `duration`.
 */
export async function clipEnd(clip: Clip, grid: FrameGrid, nested: NestedDuration): Promise<number> {
  let duration: number;
  // Only media clips have `asset`; adapter `type` is any string, so it cannot narrow.
  if ("asset" in clip) duration = (clip.out - clip.in) / (clip.speed ?? 1);
  else if (clip.duration !== undefined) duration = clip.duration;
  else duration = (await nested(clip.source!)) - (clip.in ?? 0);
  return grid.snap(clip.start + duration);
}

/** Derived timeline duration (never stored): the latest clip end on any track; 0 when empty. */
export async function timelineDuration(timeline: Timeline, grid: FrameGrid, nested: NestedDuration): Promise<number> {
  let end = 0;
  for (const track of timeline.tracks) {
    if (track.kind === "subtitles") continue;
    for (const clip of track.clips) end = Math.max(end, await clipEnd(clip, grid, nested));
  }
  return end;
}
