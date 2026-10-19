import { RpcError } from "@frameshell/protocol";
import { type Timeline, flattenTimeline, isIdentityPlacement, placementOf } from "@frameshell/schema";
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

/** A transformed nested clip whose timeline shows multicam shots. */
export interface TransformedProgram {
  /** Id of the nested clip, in the timeline that holds it. */
  clip: string;
  /** Id of the timeline that holds the clip. */
  timeline: string;
  /** Timeline file the clip nests. */
  source: string;
}

/**
 * First nested clip on a video track that has a transform and plays a
 * timeline showing a program track (directly or nested deeper), or null.
 * Shots fill the frame, so export cannot place them under a transform.
 * `nested` gives a nested timeline by `source`, null when unreadable.
 */
export function transformedProgram(timeline: Timeline, nested: (source: string) => Timeline | null, stack: readonly string[] = []): TransformedProgram | null {
  for (const track of timeline.tracks) {
    if (track.kind !== "video") continue;
    for (const clip of track.clips) {
      if (clip.type !== "timeline" || !clip.source || stack.includes(clip.source)) continue;
      const inner = nested(clip.source);
      if (!inner) continue;
      if (!isIdentityPlacement(placementOf(clip.transform)) && showsProgram(inner, nested, [...stack, clip.source])) {
        return { clip: clip.id, timeline: timeline.id, source: clip.source };
      }
      const deeper = transformedProgram(inner, nested, [...stack, clip.source]);
      if (deeper) return deeper;
    }
  }
  return null;
}

/** True when `timeline` has a program track, or a video-track nested clip that does. */
function showsProgram(timeline: Timeline, nested: (source: string) => Timeline | null, stack: readonly string[]): boolean {
  return timeline.tracks.some((track) => {
    if (track.kind === "program") return true;
    if (track.kind !== "video") return false;
    return track.clips.some((clip) => {
      if (clip.type !== "timeline" || !clip.source || stack.includes(clip.source)) return false;
      const inner = nested(clip.source);
      return inner !== null && showsProgram(inner, nested, [...stack, clip.source]);
    });
  });
}
