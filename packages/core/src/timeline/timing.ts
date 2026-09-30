import { ErrorCode, RpcError } from "@frameshell/protocol";
import type { Clip, Timeline } from "@frameshell/schema";
import type { FrameGrid } from "./grid.js";

/**
 * Derived duration of a nested timeline file, project-relative. Throws
 * {@link NestedTimelineError} when it cannot be derived.
 */
export type NestedDuration = (source: string) => Promise<number>;

/**
 * A nested timeline's duration cannot be derived: a file on the nesting
 * chain is missing, invalid, or nests itself. Timeline files are plain
 * project files, so users and agents can rename or break them at any time.
 */
export class NestedTimelineError extends Error {
  override readonly name = "NestedTimelineError";

  /**
   * @param reason What is wrong with `broken`.
   * @param chain Files from the referenced one down to `broken`, project-relative (`[source]` when `source` itself is broken).
   * @param details Parser output for `invalid`; the full cycle for `cycle`; empty for `missing`.
   * @param available Timeline ids under `timelines/`, for suggestions.
   */
  constructor(
    readonly reason: "missing" | "invalid" | "cycle",
    readonly chain: readonly string[],
    readonly details: string,
    readonly available: readonly string[] = [],
  ) {
    super(nestedProblem(reason, chain, details));
  }

  /** The file that is missing, invalid or closes the cycle. */
  get broken(): string {
    return this.chain[this.chain.length - 1]!;
  }
}

function nestedProblem(reason: NestedTimelineError["reason"], chain: readonly string[], details: string): string {
  const broken = chain[chain.length - 1]!;
  const via = chain.length > 1 ? ` (via ${chain.slice(0, -1).join(" -> ")})` : "";
  if (reason === "missing") return `${broken}${via} does not exist`;
  if (reason === "invalid") return `${broken}${via} is not a valid timeline: ${details}`;
  return `${broken} would contain itself (${details})`;
}

/**
 * Actionable error for an existing clip whose nested timeline is unavailable:
 * names the clip, its track and the broken file, and gives both fixes.
 */
export function nestedClipError(
  error: NestedTimelineError,
  where: { timeline: string; track: string; clip: Clip; op?: string },
): RpcError {
  const { timeline, track, clip, op } = where;
  const source = error.chain[0]!;
  const restore =
    error.reason === "missing"
      ? `Restore ${error.broken}${error.available.length > 0 ? ` (existing timelines: ${error.available.join(", ")})` : ""}`
      : error.reason === "invalid"
        ? `Fix ${error.broken} (or restore it from version control)`
        : `Remove the clip in ${error.chain[error.chain.length - 2] ?? `timelines/${timeline}.json`} that nests ${error.broken}`;
  const message =
    `${op ? `${op}: ` : ""}clip ${clip.id} on track ${track} of timeline ${timeline} nests ${source}, ` +
    `but its length is unknown: ${error.message}. ${restore}, or remove the clip: \`frameshell clip remove ${clip.id}\`.`;
  return new RpcError(ErrorCode.NestedTimelineUnavailable, message, {
    timeline,
    track,
    clip: clip.id,
    source,
    broken: error.broken,
    reason: error.reason,
    details: error.details,
  });
}

/**
 * Timeline time just after the last frame of `clip`, on the grid. Media:
 * `(out - in) / speed`; nested timelines without `duration` play to the end
 * of the nested file; adapter clips carry `duration`. Throws what `nested`
 * throws.
 */
export async function clipEnd(clip: Clip, grid: FrameGrid, nested: NestedDuration): Promise<number> {
  let duration: number;
  // Only media clips have `asset`; adapter `type` is any string, so it cannot narrow.
  if ("asset" in clip) duration = (clip.out - clip.in) / (clip.speed ?? 1);
  else if (clip.duration !== undefined) duration = clip.duration;
  else duration = (await nested(clip.source!)) - (clip.in ?? 0);
  return grid.snap(clip.start + duration);
}

/** Derived timeline duration (never stored): the latest clip end on any track; 0 when empty. Throws what `nested` throws. */
export async function timelineDuration(timeline: Timeline, grid: FrameGrid, nested: NestedDuration): Promise<number> {
  let end = 0;
  for (const track of timeline.tracks) {
    if (track.kind === "subtitles") continue;
    for (const clip of track.clips) end = Math.max(end, await clipEnd(clip, grid, nested));
  }
  return end;
}
