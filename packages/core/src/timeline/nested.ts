import { RpcError } from "@frameshell/protocol";
import { type Timeline, flattenTimeline } from "@frameshell/schema";
import { readTimelineFile } from "./service.js";

/** Reads a nested timeline by clip `source` (project-relative); null when missing or invalid. */
export type NestedReader = (root: string, source: string) => Promise<Timeline | null>;

/** Nested timeline file as on disk; null when missing or invalid (the caller reports the unresolved clip). */
export async function readNestedFile(root: string, source: string): Promise<Timeline | null> {
  try {
    return await readTimelineFile(root, source);
  } catch (error) {
    if (error instanceof RpcError) return null;
    throw error;
  }
}

/**
 * `timeline` with its nested timelines flattened (SPEC §3.5 step 1), as
 * export and the preview see it: nested clips become `<nested clip>/<clip>`
 * on the host track (`<track>/<n>` for extra layers). Every file the nesting
 * reaches is read once; unreadable ones stay `timeline` clips.
 */
export async function resolveNested(root: string, timeline: Timeline, read: NestedReader = readNestedFile): Promise<Timeline> {
  const nested = new Map<string, Timeline | null>();
  const pending = [timeline];
  // flattenTimeline itself stops cycles.
  while (pending.length > 0) {
    for (const track of pending.pop()!.tracks) {
      if (track.kind === "subtitles") continue;
      for (const clip of track.clips) {
        if (clip.type !== "timeline" || !("source" in clip) || !clip.source || nested.has(clip.source)) continue;
        const found = await read(root, clip.source);
        nested.set(clip.source, found);
        if (found) pending.push(found);
      }
    }
  }
  return flattenTimeline(timeline, (source) => nested.get(source) ?? null);
}
