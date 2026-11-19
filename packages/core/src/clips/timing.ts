import { RENDER_TIMING_KINDS, type RenderBeat, type RenderBeatsProblem, type RenderMarker, type RenderTiming, type RenderTimingKind, type RenderWord, type RenderWordsProblem } from "@frameshell/plugin-api";
import type { AdapterClip, BeatsFile, Timeline } from "@frameshell/schema";
import { tempoGrid } from "../timeline/tempo.js";
import { type TimelineWords, unusableGrid } from "../timeline/time-ref.js";

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
  /**
   * Transcript words `timeline` plays (`readTimelineWords`), read only when the clip asks for `words`. Absent: the
   * timeline plays none, so such a clip gets `wordsProblem` `no-transcript`.
   */
  wordsOf?(): Promise<TimelineWords>;
}

/**
 * The timeline's beats, markers and words inside a generated clip, in composition seconds (ADR 0029 decision 8):
 * what `RenderContext.timing` carries and the clip's render key counts. Undefined when the clip asked for nothing, so
 * its key stays as it was. The grid is {@link tempoGrid}'s; a grid `--snap-to` would refuse (none, missing or broken
 * beats file, LOW confidence) gives no beats and its stable code in `beatsProblem`, never an error. The code, not the
 * refusal's words, so the key moves only when the reason does (a file path or a parser message never enters it).
 * Words are those `word:` references count, refused the same way: a stale transcript on the timeline, or no
 * transcribed word at all, gives no words and the code in `wordsProblem`.
 */
export async function clipTiming(input: ClipTimingInput): Promise<RenderTiming | undefined> {
  const kinds = new Set(input.kinds.filter((kind): kind is RenderTimingKind => (RENDER_TIMING_KINDS as readonly string[]).includes(kind)));
  if (kinds.size === 0) return undefined;
  const { clip, timeline, fps } = input;
  const start = clip.start;
  const end = clip.start + clip.duration;
  // Half a frame of slack, as the grid's own clip edges: a point on the clip's first frame belongs to it, on the frame after it does not.
  const slack = 0.5 / fps;
  const inside = (seconds: number) => seconds >= start - slack && seconds < end - slack;
  const at = (seconds: number) => Math.max(0, Math.round(((clip.in ?? 0) + seconds - start) * 1e6) / 1e6);
  const timing: {
    beats?: RenderBeat[];
    tempo?: NonNullable<RenderTiming["tempo"]>;
    beatsProblem?: RenderBeatsProblem;
    markers?: RenderMarker[];
    words?: RenderWord[];
    wordsProblem?: RenderWordsProblem;
  } = {};
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
  if (kinds.has("words")) {
    const read = input.wordsOf ? await input.wordsOf() : { words: [], unchecked: [] };
    // As `word:` refuses: a stale transcript anywhere may misplace every word, and no word at all says to transcribe.
    if (read.unchecked.some((entry) => entry.reason === "stale-transcript")) timing.wordsProblem = "stale-transcript";
    else if (read.words.length === 0) timing.wordsProblem = "no-transcript";
    timing.words = timing.wordsProblem
      ? []
      : read.words
          .filter((word) => inside(word.at))
          .map((word) => ({ at: at(word.at), end: at(word.end), text: word.text, id: word.id }))
          .sort((a, b) => a.at - b.at || a.end - b.end || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }
  return timing;
}
