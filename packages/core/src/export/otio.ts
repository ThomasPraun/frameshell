import { posix, win32 } from "node:path";
import { type Clip, type ClipTrack, type MarkerColor, type Timeline, type TransitionContext, edgeTransitions } from "@frameshell/schema";
import { Dropped, LETTERBOX_NOTICE, baseName, behindNotice, encodePath, leftOut, missingMedia, noLengthNotice, placeClip, skippedTrackNotice } from "./handoff.js";

/**
 * OpenTimelineIO export (ADR 0045): a Frameshell timeline as the JSON of an `.otio` file, for editors that read it.
 * Pure and export-only: the file is derived and never read back (SPEC decision 3).
 */

/** Options of {@link timelineToOtio}. */
export interface OtioOptions {
  /** Project frames per second: the rate of every time in the file. */
  fps: number;
  /** Name of the OTIO timeline. Default: the timeline id. */
  name?: string | undefined;
  /** `target_url` of a project-relative asset path. */
  assetUrl(asset: string): string;
  /** Seconds of material a clip draws from (a nested timeline; a media file, for the handles of a dissolve); see `TransitionContext.sourceDuration`. */
  sourceDuration?: ((clip: Clip) => number | undefined) | undefined;
  /** Whether a media asset has sound a mirror track carries: false for a still image. Default: every media asset has. */
  assetHasSound?: ((asset: string) => boolean) | undefined;
}

/** What {@link timelineToOtio} returns. */
export interface OtioExport {
  /** The `Timeline.1` document, ready for `JSON.stringify`. */
  otio: OtioObject;
  /** One line per thing the file does not carry. */
  warnings: string[];
  /** Counts of what was written: tracks, clips (`Clip.2`, including missing media) and markers. */
  tracks: number;
  clips: number;
  markers: number;
}

/** Any OTIO object: every one carries its `OTIO_SCHEMA`. */
export type OtioObject = { OTIO_SCHEMA: string } & Record<string, unknown>;

/** What the file does with `audio.gain`: it has no level change to carry it. */
const GAIN_OUTCOME = "kept as metadata only, with no level change in the file";

/** OTIO `MarkerColor` of each Frameshell marker colour; markers without one are green. */
const MARKER_COLOR_NAMES: Record<MarkerColor, string> = {
  red: "RED",
  orange: "ORANGE",
  yellow: "YELLOW",
  green: "GREEN",
  blue: "BLUE",
  purple: "PURPLE",
};

/** A time in whole frames at `rate`. */
function time(frames: number, rate: number): OtioObject {
  return { OTIO_SCHEMA: "RationalTime.1", rate, value: frames };
}

function range(startFrames: number, durationFrames: number, rate: number): OtioObject {
  return { OTIO_SCHEMA: "TimeRange.1", duration: time(durationFrames, rate), start_time: time(startFrames, rate) };
}

/** Item fields every Clip, Gap, Track and Stack shares. */
function item(name: string, sourceRange: OtioObject | null, metadata: Record<string, unknown> = {}): Omit<OtioObject, "OTIO_SCHEMA"> {
  return { name, source_range: sourceRange, effects: [], markers: [], enabled: true, metadata };
}

/** A `Clip.2` playing `reference`; `media_references` is how OTIO 0.15+ writes it. */
function clipObject(name: string, sourceRange: OtioObject, reference: OtioObject, effects: OtioObject[], metadata: Record<string, unknown>, enabled: boolean): OtioObject {
  return {
    OTIO_SCHEMA: "Clip.2",
    ...item(name, sourceRange, metadata),
    effects,
    enabled,
    media_references: { DEFAULT_MEDIA: reference },
    active_media_reference_key: "DEFAULT_MEDIA",
  };
}

/**
 * Whether `clip` has sound a sound-mirror Audio track carries (ADR 0045 decision 5): a media clip whose asset is not a
 * still image. Decided by kind, never by probing the file for an audio stream.
 */
export function mirrorsSound(clip: Clip, assetHasSound?: (asset: string) => boolean): boolean {
  return "asset" in clip && (assetHasSound?.(clip.asset) ?? true);
}

/** Name of the Audio track that mirrors the sound of the video track named `videoName`. */
export function soundMirrorName(videoName: string): string {
  return `${videoName} sound`;
}

/**
 * A `Transition.1` between two clips: a dissolve centred on the cut, `half` frames each side. `shape` (wipe, push, iris)
 * is kept in the metadata only: the transition type stays a plain `SMPTE_Dissolve`. `sound`: the crossfade of a sound
 * mirror, which has no shape.
 */
function dissolveObject(clip: Clip, half: number, halfSeconds: number, rate: number, sound: boolean): OtioObject {
  return {
    OTIO_SCHEMA: "Transition.1",
    name: "",
    transition_type: "SMPTE_Dissolve",
    in_offset: time(half, rate),
    out_offset: time(half, rate),
    metadata: { frameshell: { clipId: clip.id, dissolve: clip.dissolve, half: halfSeconds, ...(sound ? { sound: true } : clip.shape !== undefined ? { shape: clip.shape } : {}) } },
  };
}

/**
 * The OTIO document of `timeline` (ADR 0045): video and audio tracks bottom first, a `Gap.1` for each hole, media clips
 * as `Clip.2` with an `ExternalReference.1` (`source_range` from `in`, lasting the timeline length, since OTIO lays items
 * out by it; `LinearTimeWarp.1` when `speed` is not 1), generated and nested clips as
 * `Clip.2` with a `MissingReference.1` of their length, markers on the stack, dissolves between butted clips as
 * `Transition.1` (`edgeTransitions` decides which, never recomputed here). Every time is a whole frame at `fps`.
 * The sound of the media clips of each video track is mirrored onto one extra Audio track after all the real ones
 * (`<video track> sound`, `metadata.frameshell.mirrorOf`, clips linked by `clipId`): same ranges, speed and crossfades,
 * disabled where the clip or the track is muted. `clips` counts the pictures, not their mirrors.
 * Program tracks, subtitle tracks, dips and fades, transition shapes, transforms, keys, grades, audio effects and sound
 * fades are left out and named in `warnings`; clip gain is metadata only, and named too.
 */
export function timelineToOtio(timeline: Timeline, options: OtioOptions): OtioExport {
  const { fps } = options;
  const context: TransitionContext = { fps, ...(options.sourceDuration ? { sourceDuration: options.sourceDuration } : {}) };
  const warnings: string[] = [];
  const dropped = new Dropped();
  const frames = (seconds: number) => Math.round(seconds * fps);
  const children: OtioObject[] = [];
  const counts = { video: 0, audio: 0 };
  const shared: Shared = { frames, fps, context, options, warnings, dropped };
  const videos: { track: ClipTrack; name: string }[] = [];
  let clipCount = 0;

  for (const track of timeline.tracks) {
    const skipped = skippedTrackNotice(track);
    if (skipped !== undefined) {
      warnings.push(skipped);
      continue;
    }
    if (track.kind === "program" || track.kind === "subtitles") continue;
    counts[track.kind] += 1;
    const name = track.name ?? `${track.kind === "video" ? "V" : "A"}${counts[track.kind]}`;
    const built = trackObject(track, name, "picture", shared);
    clipCount += built.clips;
    children.push(built.track);
    if (track.kind === "video") videos.push({ track, name });
  }
  // After every real track, so the ordinals of the real audio tracks are what they are without the mirrors.
  for (const { track, name } of videos) {
    const mirror = trackObject(track, soundMirrorName(name), "sound", shared);
    if (mirror.clips > 0) children.push(mirror.track);
  }

  if (timeline.letterbox !== undefined) warnings.push(LETTERBOX_NOTICE);

  const markers = [...(timeline.markers ?? [])]
    .sort((a, b) => a.at - b.at)
    .map(
      (marker): OtioObject => ({
        OTIO_SCHEMA: "Marker.2",
        name: marker.label,
        color: MARKER_COLOR_NAMES[marker.color ?? "green"],
        comment: "",
        marked_range: range(frames(marker.at), 0, fps),
        metadata: { frameshell: { markerId: marker.id } },
      }),
    );

  const otio: OtioObject = {
    OTIO_SCHEMA: "Timeline.1",
    name: options.name ?? timeline.id,
    global_start_time: time(0, fps),
    metadata: { frameshell: { timelineId: timeline.id, revision: timeline.revision, schemaVersion: timeline.schemaVersion } },
    tracks: { OTIO_SCHEMA: "Stack.1", ...item("tracks", null), markers, children },
  };
  return { otio, warnings: [...warnings, ...dropped.warnings()], tracks: children.length, clips: clipCount, markers: markers.length };
}

interface Shared {
  frames(seconds: number): number;
  fps: number;
  context: TransitionContext;
  options: OtioOptions;
  warnings: string[];
  dropped: Dropped;
}

/** What {@link trackObject} writes: `track` itself, or the Audio track that mirrors the sound of a video track's media clips. */
type TrackMode = "picture" | "sound";

/**
 * One `Track.1`: clips in order with a `Gap.1` for every hole and a `Transition.1` where a dissolve joins two. A muted audio
 * track and a hidden video track are disabled. `sound` mode writes the mirror of a video track: only the clips that have
 * sound, on an Audio track disabled when the video track is muted, and warning of nothing the picture track already did.
 */
function trackObject(track: ClipTrack, name: string, mode: TrackMode, shared: Shared): { track: OtioObject; clips: number } {
  const { frames, fps, context, warnings, dropped } = shared;
  const sound = mode === "sound";
  const out: OtioObject[] = [];
  const edges = edgeTransitions(track.clips, context);
  let cursor = 0;
  let clips = 0;
  for (const clip of [...track.clips].sort((a, b) => a.start - b.start)) {
    if (sound && !mirrorsSound(clip, shared.options.assetHasSound)) continue;
    const placed = placeClip(clip, context, fps);
    if (placed === undefined) {
      warnings.push(noLengthNotice(clip));
      continue;
    }
    const { startFrames, endFrames, lengthFrames } = placed;
    const edge = edges.get(clip.id);
    // A Transition.1 sits between two Clip.2: the frame positions must agree with the butted clips the dissolve was cut for.
    const joined = edge?.mode === "dissolve" && edge.dissolve > 0 && startFrames <= cursor && out[out.length - 1]?.["OTIO_SCHEMA"] === "Clip.2";
    if (joined) out.push(dissolveObject(clip, Math.max(1, frames(edge.dissolve)), edge.dissolve, fps, sound));
    if (startFrames > cursor) out.push({ OTIO_SCHEMA: "Gap.1", ...item("", range(0, startFrames - cursor, fps)) });
    cursor = Math.max(cursor, endFrames);
    out.push(clipOf(clip, lengthFrames, mode, track.kind === "audio", shared));
    if (!sound) leftOut(clip, dropped, joined, GAIN_OUTCOME);
    clips += 1;
  }

  const behind = sound ? undefined : behindNotice(track);
  if (behind !== undefined) warnings.push(behind);
  const hidden = !sound && track.kind === "video" && track.hidden === true;
  const muted = track.muted === true;
  // A muted video track keeps its picture enabled: its sound is on the mirror track, which is the one disabled.
  const enabled = sound || track.kind === "audio" ? !muted : !hidden;
  const metadata = {
    frameshell: { ...(sound ? { mirrorOf: track.id } : { trackId: track.id }), ...(muted ? { muted: true } : {}), ...(hidden ? { hidden: true } : {}) },
  };
  return {
    track: { OTIO_SCHEMA: "Track.1", ...item(name, null, metadata), enabled, children: out, kind: track.kind === "video" && !sound ? "Video" : "Audio" },
    clips,
  };
}

/**
 * The `Clip.2` of one clip: media with an external reference, anything Frameshell renders as a missing one. In `sound`
 * mode (the mirror of a video track: media clips only) it is the same clip, disabled when its sound is muted and linked
 * to the picture by `linkedClipId`.
 */
function clipOf(clip: Clip, lengthFrames: number, mode: TrackMode, audioTrack: boolean, shared: Shared): OtioObject {
  const { frames, fps, options, warnings } = shared;
  const sound = mode === "sound";
  const own = { clipId: clip.id, start: clip.start, length: lengthFrames / fps, ...(sound ? { linkedClipId: clip.id } : {}) };
  // A muted clip on a video track still shows its picture: only a track that carries sound switches off with it.
  const enabled = !((sound || audioTrack) && clip.audio?.muted === true);
  if ("asset" in clip) {
    const speed = clip.speed ?? 1;
    const effects: OtioObject[] = speed === 1 ? [] : [{ OTIO_SCHEMA: "LinearTimeWarp.1", name: "", effect_name: "LinearTimeWarp", time_scalar: speed, metadata: {} }];
    const gain = clip.audio?.gain;
    return clipObject(
      baseName(clip.asset),
      range(frames(clip.in), lengthFrames, fps),
      { OTIO_SCHEMA: "ExternalReference.1", name: "", available_range: null, metadata: {}, target_url: options.assetUrl(clip.asset) },
      effects,
      { frameshell: { ...own, ...(gain !== undefined && gain !== 0 ? { gain } : {}), ...(speed !== 1 ? { speed } : {}), ...(sound ? { sound: true } : {}) } },
      enabled,
    );
  }
  const missing = missingMedia(clip);
  warnings.push(missing.warning);
  return clipObject(
    missing.name,
    range(0, lengthFrames, fps),
    { OTIO_SCHEMA: "MissingReference.1", name: "", available_range: null, metadata: {} },
    [],
    { frameshell: { ...own, type: clip.type } },
    enabled,
  );
}

/** Where relative and absolute `target_url`s are taken from; see {@link otioAssetUrl}. */
export interface OtioUrlBase {
  /** Absolute project root. */
  root: string;
  /** Absolute folder of the `.otio` file. */
  outDir: string;
  /** True: `file://` URLs. False: paths relative to `outDir`. */
  absolute: boolean;
  /** Path rules of the machine that owns `root`. Default: this machine's. */
  flavour?: "posix" | "win32";
}

/**
 * `target_url` of project asset `asset` (ADR 0045 decision 4): by default a `/`-separated path relative to the
 * `.otio` file's folder, with `file://` URLs only when asked for, or when the asset is on another Windows drive and
 * has no relative path.
 */
export function otioAssetUrl(base: OtioUrlBase, asset: string): string {
  const path = base.flavour === "win32" ? win32 : base.flavour === "posix" ? posix : process.platform === "win32" ? win32 : posix;
  const file = path.join(base.root, ...asset.split("/"));
  if (!base.absolute) {
    const relative = path.relative(base.outDir, file);
    if (!path.isAbsolute(relative)) return encodePath(relative.split(path.sep).join("/"));
  }
  const slashed = file.split(path.sep).join("/");
  return `file://${encodePath(slashed.startsWith("/") ? slashed : `/${slashed}`)}`;
}
