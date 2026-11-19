import { posix, win32 } from "node:path";
import { type Clip, type ClipTrack, type MarkerColor, type Timeline, type TransitionContext, clipLength } from "@frameshell/schema";

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
  /** Seconds of material a nested timeline clip draws from; see `TransitionContext.sourceDuration`. */
  sourceDuration?: ((clip: Clip) => number | undefined) | undefined;
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

/** OTIO `MarkerColor` of each Frameshell marker colour; markers without one are green. */
const MARKER_COLOR_NAMES: Record<MarkerColor, string> = {
  red: "RED",
  orange: "ORANGE",
  yellow: "YELLOW",
  green: "GREEN",
  blue: "BLUE",
  purple: "PURPLE",
};

/** Clip ids listed in a warning before "…". */
const LISTED_IDS = 5;

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

/** Last path segment of a `/`-separated project path. */
function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** A composition or nested timeline file by name: `compositions/hyperframes/intro/index.html` is `intro`, `timelines/inner.json` is `inner`. */
function sourceName(source: string): string {
  const parts = source.split("/");
  const file = parts.pop() ?? source;
  const stem = file.replace(/\.[^.]+$/, "");
  return stem === "index" && parts.length > 0 ? parts[parts.length - 1]! : stem;
}

/** Collects the ids of clips that carry something the file leaves out, one warning per kind. */
class Dropped {
  readonly #kinds = new Map<string, string[]>();

  add(kind: string, clip: string): void {
    const ids = this.#kinds.get(kind) ?? [];
    ids.push(clip);
    this.#kinds.set(kind, ids);
  }

  warnings(): string[] {
    return [...this.#kinds].map(([kind, ids]) => {
      const shown = ids.slice(0, LISTED_IDS).join(", ");
      return `${kind} on ${ids.length} clip${ids.length === 1 ? "" : "s"} not exported (${shown}${ids.length > LISTED_IDS ? ", …" : ""}).`;
    });
  }
}

/** Features of a clip the file does not carry, by the words the warning uses. */
function leftOut(clip: Clip, dropped: Dropped, audioTrack: boolean): void {
  const known = clip as unknown as Record<string, unknown>;
  if (clip.dissolve !== undefined || clip.fadeIn !== undefined || clip.fadeOut !== undefined) dropped.add("transitions (dissolves, fades)", clip.id);
  if (clip.transform !== undefined || clip.keys !== undefined) dropped.add("transform and keys", clip.id);
  if (known.grade !== undefined) dropped.add("colour grade", clip.id);
  if (known.vignette !== undefined || known.grain !== undefined || known.backdrop !== undefined || known.motionBlur !== undefined) dropped.add("film finish and effects", clip.id);
  if ("asset" in clip && clip.audio?.effects !== undefined && clip.audio.effects.length > 0) dropped.add("audio effects", clip.id);
  if (clip.audio?.muted === true && !audioTrack) dropped.add("muted sound of a video clip", clip.id);
}

/**
 * The OTIO document of `timeline` (ADR 0045): video and audio tracks bottom first, a `Gap.1` for each hole, media clips
 * as `Clip.2` with an `ExternalReference.1` (`LinearTimeWarp.1` when `speed` is not 1), generated and nested clips as
 * `Clip.2` with a `MissingReference.1` of their length, markers on the stack. Every time is a whole frame at `fps`.
 * Program tracks, subtitle tracks, transitions, transforms, keys, grades and audio effects are left out and named in
 * `warnings`.
 */
export function timelineToOtio(timeline: Timeline, options: OtioOptions): OtioExport {
  const { fps } = options;
  const context: TransitionContext = { fps, ...(options.sourceDuration ? { sourceDuration: options.sourceDuration } : {}) };
  const warnings: string[] = [];
  const dropped = new Dropped();
  const frames = (seconds: number) => Math.round(seconds * fps);
  const children: OtioObject[] = [];
  const counts = { video: 0, audio: 0 };
  let clipCount = 0;

  for (const track of timeline.tracks) {
    if (track.kind === "program") {
      warnings.push(`program track ${track.id} (multicam shots) not exported: ${track.clips.length} shot${track.clips.length === 1 ? "" : "s"} skipped.`);
      continue;
    }
    if (track.kind === "subtitles") {
      warnings.push(`subtitle track ${track.id} not exported.`);
      continue;
    }
    counts[track.kind] += 1;
    const built = trackObject(track, counts[track.kind], { frames, fps, context, options, warnings, dropped });
    clipCount += built.clips;
    children.push(built.track);
  }

  if (timeline.letterbox !== undefined) warnings.push("letterbox bars not exported.");

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

/** One `Track.1`: clips in order with a `Gap.1` for every hole. A muted audio track and a hidden video track are disabled. */
function trackObject(track: ClipTrack, ordinal: number, shared: Shared): { track: OtioObject; clips: number } {
  const { frames, fps, context, warnings, dropped } = shared;
  const out: OtioObject[] = [];
  let cursor = 0;
  let clips = 0;
  for (const clip of [...track.clips].sort((a, b) => a.start - b.start)) {
    const length = clipLength(clip, context);
    if (!Number.isFinite(length)) {
      warnings.push(`clip ${clip.id} (nested ${"source" in clip ? clip.source : "timeline"}) has no known length: skipped.`);
      continue;
    }
    const startFrames = frames(clip.start);
    const lengthFrames = Math.max(1, frames(length));
    if (startFrames > cursor) out.push({ OTIO_SCHEMA: "Gap.1", ...item("", range(0, startFrames - cursor, fps)) });
    cursor = Math.max(cursor, startFrames + lengthFrames);
    out.push(clipOf(clip, startFrames, lengthFrames, track.kind === "audio", shared));
    leftOut(clip, dropped, track.kind === "audio");
    clips += 1;
  }

  const hidden = track.kind === "video" && track.hidden === true;
  const muted = track.muted === true;
  // A muted video track still shows its picture, and OTIO has no switch for the sound alone.
  if (muted && track.kind === "video") warnings.push(`video track ${track.id} is muted: exported enabled, since its picture shows.`);
  const enabled = track.kind === "audio" ? !muted : !hidden;
  const name = track.name ?? `${track.kind === "video" ? "V" : "A"}${ordinal}`;
  const metadata = { frameshell: { trackId: track.id, ...(muted ? { muted: true } : {}), ...(hidden ? { hidden: true } : {}) } };
  return {
    track: { OTIO_SCHEMA: "Track.1", ...item(name, null, metadata), enabled, children: out, kind: track.kind === "video" ? "Video" : "Audio" },
    clips,
  };
}

/** The `Clip.2` of one clip: media with an external reference, anything Frameshell renders as a missing one. */
function clipOf(clip: Clip, startFrames: number, lengthFrames: number, audioTrack: boolean, shared: Shared): OtioObject {
  const { frames, fps, options, warnings } = shared;
  const own = { clipId: clip.id, start: clip.start, length: lengthFrames / fps };
  const enabled = !(audioTrack && clip.audio?.muted === true);
  if ("asset" in clip) {
    const speed = clip.speed ?? 1;
    const effects: OtioObject[] = speed === 1 ? [] : [{ OTIO_SCHEMA: "LinearTimeWarp.1", name: "", effect_name: "LinearTimeWarp", time_scalar: speed, metadata: {} }];
    const sourceFrames = Math.max(1, frames(clip.out - clip.in));
    if (speed !== 1) {
      warnings.push(
        `clip ${clip.id} plays at ${speed}x: its source_range is ${sourceFrames} frames of source, its timeline length ${lengthFrames} frames (metadata.frameshell.length); ` +
          "an editor that lays items out by source duration moves what follows.",
      );
    }
    const gain = clip.audio?.gain;
    return clipObject(
      baseName(clip.asset),
      range(frames(clip.in), sourceFrames, fps),
      { OTIO_SCHEMA: "ExternalReference.1", name: "", available_range: null, metadata: {}, target_url: options.assetUrl(clip.asset) },
      effects,
      { frameshell: { ...own, ...(gain !== undefined && gain !== 0 ? { gain } : {}), ...(speed !== 1 ? { speed } : {}) } },
      enabled,
    );
  }
  const nested = clip.type === "timeline";
  const label = "source" in clip && clip.source ? sourceName(clip.source) : clip.id;
  warnings.push(
    nested
      ? `nested timeline clip ${clip.id} (${label}) exported as missing media of its length: export that timeline on its own and relink it.`
      : `generated clip ${clip.id} (${clip.type}) exported as missing media of its length: render it and relink the file by hand.`,
  );
  return clipObject(
    nested ? `timeline ${label}` : `${clip.type} ${label}`,
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

/** Percent-encodes each segment of a `/`-separated path, leaving `/`, `..` and a drive letter (`C:`) alone. */
function encodePath(path: string): string {
  return path
    .split("/")
    .map((segment) => (segment === ".." || /^[A-Za-z]:$/.test(segment) ? segment : encodeURIComponent(segment)))
    .join("/");
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
