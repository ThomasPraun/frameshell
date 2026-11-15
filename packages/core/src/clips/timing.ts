import type { RenderBeat, RenderBeatsProblem, RenderMarker, RenderTiming, RenderTimingKind } from "@frameshell/plugin-api";
import type { AdapterClip, BeatsFile, Timeline } from "@frameshell/schema";
import { tempoGrid } from "../timeline/tempo.js";
import { unusableGrid } from "../timeline/time-ref.js";

/** Input of {@link clipTiming}. */
export interface ClipTimingInput {
  /** The generated clip, placed on `timeline`. */
  clip: Pick<AdapterClip, "start" | "in" | "duration">;
  /** The timeline the clip sits in (flattened when the clip came from a nested one): its `tempo`, markers and tracks. */
  timeline: Pick<Timeline, "tempo" | "tracks" | "markers">;
  /** Project frame rate. */
  fps: number;
  /** What the clip's adapter asked for (`ClipAdapter.timing`); unknown kinds are ignored. */
  kinds: readonly string[];
  /** Beats file of a project-relative asset, or null; throws for a broken one. */
  beatsOf(asset: string): Promise<BeatsFile | null>;
}

/**
 * The timeline's beats and markers inside a generated clip, in composition seconds (ADR 0029 decision 8): what
 * `RenderContext.timing` carries and the clip's render key counts. Undefined when the clip asked for nothing, so its
 * key stays as it was. The grid is {@link tempoGrid}'s; a grid `--snap-to` would refuse (none, missing or broken
 * beats file, LOW confidence) gives no beats and its stable code in `beatsProblem`, never an error. The code, not the
 * refusal's words, so the key moves only when the reason does (a file path or a parser message never enters it).
 */
export async function clipTiming(input: ClipTimingInput): Promise<RenderTiming | undefined> {
  const kinds = new Set(input.kinds.filter((kind): kind is RenderTimingKind => kind === "beats" || kind === "markers"));
  if (kinds.size === 0) return undefined;
  const { clip, timeline, fps } = input;
  const start = clip.start;
  const end = clip.start + clip.duration;
  // Half a frame of slack, as the grid's own clip edges: a point on the clip's first frame belongs to it, on the frame after it does not.
  const slack = 0.5 / fps;
  const inside = (seconds: number) => seconds >= start - slack && seconds < end - slack;
  const at = (seconds: number) => Math.max(0, Math.round(((clip.in ?? 0) + seconds - start) * 1e6) / 1e6);
  const timing: { beats?: RenderBeat[]; tempo?: NonNullable<RenderTiming["tempo"]>; beatsProblem?: RenderBeatsProblem; markers?: RenderMarker[] } = {};
  if (kinds.has("beats")) {
    timing.beats = [];
    let found: Awaited<ReturnType<typeof tempoGrid>> | null = null;
    try {
      found = await tempoGrid({ fps, timeline, horizon: end, beatsOf: input.beatsOf });
    } catch {
      // A beats file that cannot be read or does not validate: the person may be editing it.
      timing.beatsProblem = "broken-beats";
    }
    const unusable = found ? unusableGrid(found) : null;
    if (unusable) timing.beatsProblem = unusable.code;
    else if (found?.grid) {
      const { grid } = found;
      timing.tempo = { bpm: grid.bpm, meter: grid.meter };
      const bars = new Map(grid.bars.map((seconds, index) => [seconds, grid.barBase + index + 1]));
      grid.beats.forEach((seconds, index) => {
        if (!inside(seconds)) return;
        const bar = bars.get(seconds);
        timing.beats!.push({ at: at(seconds), beat: grid.beatBase + index + 1, ...(bar !== undefined ? { bar } : {}) });
      });
    }
  }
  if (kinds.has("markers")) {
    timing.markers = (timeline.markers ?? [])
      .filter((marker) => inside(marker.at))
      .map((marker) => ({ at: at(marker.at), id: marker.id, label: marker.label, ...(marker.color ? { color: marker.color } : {}) }))
      .sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1));
  }
  return timing;
}
