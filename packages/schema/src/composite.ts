// How video layers composite (SPEC §3.4, §3.5, §5.3). Pure and shared: the export compiler and the preview place
// layers with these same functions, so a preview frame matches the exported one.
import type { Clip, ClipAudio, ClipTrack, Timeline, Track, Transform } from "./timeline.js";

/** A clip {@link Transform} with every default filled in. */
export interface Placement {
  /** Offset of the layer's center from the frame's center, project pixels. */
  x: number;
  y: number;
  /** Factor on the fitted size. */
  scale: number;
  /** 0 (invisible) to 1 (opaque). */
  opacity: number;
}

/** Width and height in pixels. */
export interface Size {
  width: number;
  height: number;
}

/** Integer pixel rectangle of a layer in an output frame; may reach outside it. */
export interface LayerRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** No transform: centered, fitted, opaque. */
export const IDENTITY_PLACEMENT: Placement = Object.freeze({ x: 0, y: 0, scale: 1, opacity: 1 });

/** `transform` with its defaults (SPEC §5.3); absent means {@link IDENTITY_PLACEMENT}. */
export function placementOf(transform: Transform | undefined): Placement {
  return {
    x: transform?.x ?? 0,
    y: transform?.y ?? 0,
    scale: transform?.scale ?? 1,
    opacity: transform?.opacity ?? 1,
  };
}

/** True when `placement` leaves a layer where an untransformed clip would be. */
export function isIdentityPlacement(placement: Placement): boolean {
  return placement.x === 0 && placement.y === 0 && placement.scale === 1 && placement.opacity === 1;
}

/**
 * Where a `source`-sized picture lands in an `output`-sized frame. The
 * picture is first fitted (letterboxed, like an untransformed clip), then
 * scaled about its center, then offset by `x`/`y`, which are project pixels
 * (`project` = `frameshell.json` resolution) mapped onto the output. Sizes
 * round to whole pixels (at least 1), then the corner rounds.
 */
export function layerRect(source: Size, output: Size, project: Size, placement: Placement): LayerRect {
  const fit = Math.min(output.width / source.width, output.height / source.height);
  const width = Math.max(1, Math.round(source.width * fit * placement.scale));
  const height = Math.max(1, Math.round(source.height * fit * placement.scale));
  const cx = output.width / 2 + (placement.x * output.width) / project.width;
  const cy = output.height / 2 + (placement.y * output.height) / project.height;
  return { left: Math.round(cx - width / 2), top: Math.round(cy - height / 2), width, height };
}

/**
 * Placement of a clip inside a nested timeline whose clip is placed with
 * `outer`: the nested frame is project-sized, so it fits the outer frame
 * exactly and offsets scale with it. Opacity multiplies per layer (overlapping
 * layers of the nested timeline are not flattened into one group first).
 */
export function composePlacement(outer: Placement, inner: Placement): Placement {
  return {
    x: outer.x + inner.x * outer.scale,
    y: outer.y + inner.y * outer.scale,
    scale: outer.scale * inner.scale,
    opacity: outer.opacity * inner.opacity,
  };
}

/** Parsed timeline of a nested clip's `source`; null when missing or invalid. */
export type NestedTimelines = (source: string) => Timeline | null;

/**
 * SPEC §3.5 step 1: `timeline` with every nested `type: "timeline"` clip
 * replaced by the clips it plays, recursively, so compilers only see media
 * and adapter clips.
 *
 * A nested clip on track T plays nested seconds `[in, in + duration)` from
 * its `start`. The nested timeline's first video track goes onto T itself,
 * in the nested clip's slot; its further video tracks become layers
 * `T/2`, `T/3`, … right above T, and its audio tracks `T/a1`, `T/a2`, …
 * (on an audio track T, every nested track is sound). Clips are cut to the
 * window; ids become `<nested clip>/<clip>`. The nested clip's transform
 * composes with each video clip's ({@link composePlacement}), its gain adds,
 * its mute wins. Subtitle tracks of nested timelines are dropped.
 *
 * A clip whose timeline `nested` cannot give, or that would nest a timeline
 * inside itself, stays as it is for the caller to report. The root is
 * assumed to be `timelines/<id>.json`.
 */
export function flattenTimeline(timeline: Timeline, nested: NestedTimelines): Timeline {
  return { ...timeline, tracks: flattenTracks(timeline.tracks, nested, [`timelines/${timeline.id}.json`]) };
}

function flattenTracks(tracks: readonly Track[], nested: NestedTimelines, stack: readonly string[]): Track[] {
  const out: Track[] = [];
  for (const track of tracks) {
    if (track.kind === "subtitles" || !track.clips.some(isNestedClip)) {
      out.push(track);
      continue;
    }
    const own: Clip[] = [];
    /** Extra tracks by id, in first-seen order: layers `T/2`… and sound `T/a1`…. */
    const extra = new Map<string, ClipTrack>();
    const extraTrack = (id: string, kind: ClipTrack["kind"]) => {
      let found = extra.get(id);
      if (!found) extra.set(id, (found = { id, kind, clips: [] }));
      return found;
    };
    for (const clip of track.clips) {
      const inner = isNestedClip(clip) && !stack.includes(clip.source) ? nested(clip.source) : null;
      if (!isNestedClip(clip) || !inner) {
        own.push(clip);
        continue;
      }
      const flat = flattenTracks(inner.tracks, nested, [...stack, clip.source]);
      const from = clip.in ?? 0;
      const to = clip.duration !== undefined ? from + clip.duration : durationOf(flat);
      let videoIndex = 0;
      let audioIndex = 0;
      let ownTaken = false;
      for (const child of flat) {
        if (child.kind === "subtitles") continue;
        let target: Clip[];
        if (track.kind === "video" && child.kind === "video") {
          videoIndex++;
          target = videoIndex === 1 ? own : extraTrack(`${track.id}/${videoIndex}`, "video").clips;
        } else if (track.kind === "audio" && !ownTaken) {
          // On an audio track the first nested track's sound takes the nested clip's slot.
          ownTaken = true;
          target = own;
        } else {
          target = extraTrack(`${track.id}/a${++audioIndex}`, "audio").clips;
        }
        const video = child.kind === "video" && track.kind === "video";
        for (const part of child.clips) {
          const placed = window(part, from, to, clip, video);
          if (placed) target.push(placed);
        }
      }
    }
    const byStart = (a: Clip, b: Clip) => a.start - b.start;
    out.push({ ...track, clips: own.sort(byStart) });
    for (const added of extra.values()) out.push({ ...added, clips: added.clips.sort(byStart) });
  }
  return out;
}

/** Adapter types never match `timeline` (ADAPTER_CLIP_TYPE_PATTERN), so `type` alone narrows. */
function isNestedClip(clip: Clip): clip is Extract<Clip, { type: "timeline" }> {
  return clip.type === "timeline";
}

/** End of `clip` in its timeline's seconds; null for a nested clip (unresolved) without `duration`. */
function clipEnd(clip: Clip): number | null {
  if ("asset" in clip) return clip.start + (clip.out - clip.in) / (clip.speed ?? 1);
  return clip.duration !== undefined ? clip.start + clip.duration : null;
}

/** Latest clip end over flattened tracks; unresolved nested clips without a length count as ending where they start. */
function durationOf(tracks: readonly Track[]): number {
  let end = 0;
  for (const track of tracks) {
    if (track.kind === "subtitles") continue;
    for (const clip of track.clips) end = Math.max(end, clipEnd(clip) ?? clip.start);
  }
  return end;
}

/**
 * `part` (nested seconds) cut to `[from, to)`, moved to the nested clip's
 * timeline position, with its transform and audio composed in; null when
 * nothing of it plays.
 */
function window(part: Clip, from: number, to: number, host: Extract<Clip, { type: "timeline" }>, video: boolean): Clip | null {
  const end = clipEnd(part) ?? part.start;
  const a = Math.max(part.start, from);
  const b = Math.min(end, to);
  if (b <= a) return null;
  const start = host.start + (a - from);
  const id = `${host.id}/${part.id}`;
  let placed: Clip;
  if ("asset" in part) {
    const speed = part.speed ?? 1;
    placed = { ...part, id, start, in: part.in + (a - part.start) * speed, out: part.in + (b - part.start) * speed };
  } else if (part.duration !== undefined) {
    placed = { ...part, id, start, in: (part.in ?? 0) + (a - part.start), duration: b - a } as Clip;
  } else {
    // Unresolved nested clip of unknown length: keep it, moved; the caller reports it.
    placed = { ...part, id, start } as Clip;
  }
  if (video && host.transform) {
    placed.transform = composePlacement(placementOf(host.transform), placementOf(part.transform));
  } else if (!video) {
    delete placed.transform;
  }
  const audio = composeAudio(host.audio, part.audio);
  if (audio) placed.audio = audio;
  return placed;
}

function composeAudio(outer: ClipAudio | undefined, inner: ClipAudio | undefined): ClipAudio | undefined {
  if (!outer) return inner;
  const gain = (outer.gain ?? 0) + (inner?.gain ?? 0);
  const muted = outer.muted === true || inner?.muted === true;
  return { ...inner, ...(gain !== 0 || inner?.gain !== undefined ? { gain } : {}), ...(muted ? { muted } : {}) };
}
