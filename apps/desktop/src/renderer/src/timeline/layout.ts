// Timeline panel geometry: pure, DOM-free, so it is unit tested and shared by paint and hit testing.
import type { TimelineView } from "@frameshell/protocol";

/** Height of the time ruler above the lanes, px. */
export const RULER_HEIGHT = 22;

/** Lane height per track kind, px. */
export const LANE_HEIGHT = { video: 44, audio: 44, subtitles: 28 } as const;

/** Stand-in length of a clip whose end is unknown (nested timeline missing), when no clip follows it. */
const UNKNOWN_LENGTH_S = 2;

/** Labeled ruler ticks are at least this far apart, px. */
const MIN_LABEL_SPACING = 80;

/** Unlabeled ruler ticks are at least this far apart, px. */
const MIN_MINOR_SPACING = 6;

/** Most zoomed in: one frame this wide, px. */
const FRAME_PX_MAX = 24;

/** Track kind as the daemon reports it. */
export type TrackKind = TimelineView["tracks"][number]["kind"];

/** How a clip gets its pictures: from a file, another timeline, or an adapter plugin (rendered). */
export type ClipKind = "media" | "timeline" | "generated";

/** One clip placed on the timeline, times in timeline seconds. */
export interface ClipBox {
  id: string;
  /** Clip `type` as stored, e.g. `media`, `timeline`, `hyperframes`. */
  type: string;
  kind: ClipKind;
  /** What it plays, for its label: file name, nested timeline id or composition name. */
  name: string;
  start: number;
  /** Derived end; a stand-in when {@link ClipBox.problem} is set. */
  end: number;
  /** Media clips: project-relative asset, for waveform and thumbnails. */
  asset: string | null;
  /** Source seconds at `start`. */
  in: number;
  /** Source seconds per timeline second. */
  speed: number;
  /** Why the length is unknown (daemon's message); null when it is known. */
  problem: string | null;
  /** `audio.gain`, dB; 0 when unset. */
  gain: number;
  /** `audio.muted`. */
  muted: boolean;
  /** Stored `transform` with defaults filled; null when the clip has none. */
  transform: { x: number; y: number; scale: number; opacity: number } | null;
}

/** One lane, in display order. */
export interface TrackRow {
  id: string;
  kind: TrackKind;
  /** Short label, numbered per kind from the bottom layer: `V1`, `A2`, `S1`. */
  label: string;
  name: string | null;
  /** Subtitle tracks: label of the followed track; null otherwise. */
  followsLabel: string | null;
  /** Top edge in content px (ruler included). */
  top: number;
  height: number;
  /** Sorted by start, never overlapping. */
  clips: ClipBox[];
}

/** Everything the panel draws, derived from one `timeline.show` result. */
export interface TimelineLayout {
  rows: TrackRow[];
  /** Latest clip end, seconds; stand-in ends included. */
  duration: number;
  /** Content height: ruler plus every lane, px. */
  height: number;
  clipCount: number;
}

/**
 * Lay out a timeline the way editors read it: the top video layer first
 * (the file lists the bottom layer first), then audio, then subtitles.
 */
export function layoutTimeline(view: TimelineView): TimelineLayout {
  const problems = new Map(view.problems.map((problem) => [problem.clip, problem.message]));
  const labels = new Map<string, string>();
  const counts: Record<TrackKind, number> = { video: 0, audio: 0, subtitles: 0 };
  const prefix: Record<TrackKind, string> = { video: "V", audio: "A", subtitles: "S" };
  for (const track of view.tracks) labels.set(track.id, `${prefix[track.kind]}${++counts[track.kind]}`);

  const byKind = (kind: TrackKind) => view.tracks.filter((track) => track.kind === kind);
  const ordered = [...byKind("video").reverse(), ...byKind("audio"), ...byKind("subtitles")];

  let top = RULER_HEIGHT;
  let duration = view.duration ?? 0;
  let clipCount = 0;
  const rows = ordered.map((track): TrackRow => {
    const clips = track.clips.map((clip, index) => {
      const box = clipBox(clip, track.clips[index + 1]?.start, problems.get(clip.id) ?? null);
      duration = Math.max(duration, box.end);
      return box;
    });
    clipCount += clips.length;
    const height = LANE_HEIGHT[track.kind];
    const row: TrackRow = {
      id: track.id,
      kind: track.kind,
      label: labels.get(track.id)!,
      name: track.name,
      followsLabel: track.follows ? (labels.get(track.follows) ?? track.follows) : null,
      top,
      height,
      clips,
    };
    top += height;
    return row;
  });
  return { rows, duration, height: top, clipCount };
}

type ClipView = TimelineView["tracks"][number]["clips"][number];

function clipBox(clip: ClipView, nextStart: number | undefined, problem: string | null): ClipBox {
  const fields = clip as Record<string, unknown>;
  const text = (key: string) => (typeof fields[key] === "string" ? (fields[key] as string) : null);
  const num = (key: string, fallback: number) => (typeof fields[key] === "number" ? (fields[key] as number) : fallback);
  const kind: ClipKind = clip.type === "media" ? "media" : clip.type === "timeline" ? "timeline" : "generated";
  const asset = kind === "media" ? text("asset") : null;
  const source = text("source");
  let name: string;
  if (asset) name = baseName(asset);
  else if (kind === "timeline" && source) name = baseName(source).replace(/\.json$/, "");
  else if (source) name = /^index\.[a-z]+$/i.test(baseName(source)) ? baseName(parentDir(source)) : baseName(source);
  else name = clip.type;
  const end = clip.end ?? Math.max(nextStart ?? clip.start + UNKNOWN_LENGTH_S, clip.start);
  const audio = (fields["audio"] ?? {}) as { gain?: unknown; muted?: unknown };
  const transform = fields["transform"] as Record<string, unknown> | undefined;
  const part = (key: string, fallback: number) => (typeof transform?.[key] === "number" ? (transform[key] as number) : fallback);
  return {
    id: clip.id,
    type: clip.type,
    kind,
    name,
    start: clip.start,
    end,
    asset,
    in: num("in", 0),
    speed: num("speed", 1),
    problem: clip.end === null ? (problem ?? "Length unknown") : null,
    gain: typeof audio.gain === "number" ? audio.gain : 0,
    muted: audio.muted === true,
    transform: transform ? { x: part("x", 0), y: part("y", 0), scale: part("scale", 1), opacity: part("opacity", 1) } : null,
  };
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function parentDir(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut > 0 ? path.slice(0, cut) : path;
}

/**
 * Clips of one track overlapping [t0, t1), by binary search: clips are sorted
 * and never overlap, so starts and ends both ascend. Keeps paint cost
 * proportional to what is on screen, not to the timeline length.
 */
export function visibleClips(clips: readonly ClipBox[], t0: number, t1: number): ClipBox[] {
  const first = lowerBound(clips, (clip) => clip.end > t0);
  const last = lowerBound(clips, (clip) => clip.start >= t1);
  return clips.slice(first, Math.max(first, last));
}

/** First index where `past` turns true; `past` must be monotonic over `items`. */
function lowerBound<T>(items: readonly T[], past: (item: T) => boolean): number {
  let lo = 0;
  let hi = items.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (past(items[mid]!)) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/** Seconds that must fit on screen fully zoomed out: the timeline plus a quarter, at least a minute. */
function span(duration: number): number {
  return Math.max(duration * 1.25, 60);
}

/** Zoom (px per second) that shows the whole timeline in `width` px. */
export function fitZoom(duration: number, width: number): number {
  return width / span(duration);
}

/** Zoom range: from the whole timeline in view to one frame {@link FRAME_PX_MAX} px wide. */
export function zoomLimits(duration: number, width: number, fps: number): { min: number; max: number } {
  return { min: fitZoom(duration, width), max: fps * FRAME_PX_MAX };
}

/** Scrollable width of the lanes, px: never less than the viewport. */
export function contentWidth(duration: number, pxPerSecond: number, width: number): number {
  return Math.max(width, span(duration) * pxPerSecond);
}

/** Keep a horizontal scroll offset inside the content. */
export function clampScroll(scrollLeft: number, duration: number, pxPerSecond: number, width: number): number {
  return Math.min(Math.max(0, scrollLeft), contentWidth(duration, pxPerSecond, width) - width);
}

/**
 * Zoom by `factor` around `anchorX` (px from the lanes' left edge): the time
 * under the anchor stays under it. Scroll is clamped at the start only; the
 * caller clamps the end once the new content width is known.
 */
export function zoomAround(
  viewport: { pxPerSecond: number; scrollLeft: number },
  factor: number,
  anchorX: number,
  limits: { min: number; max: number },
): { pxPerSecond: number; scrollLeft: number } {
  const time = (viewport.scrollLeft + anchorX) / viewport.pxPerSecond;
  const pxPerSecond = Math.min(limits.max, Math.max(limits.min, viewport.pxPerSecond * factor));
  return { pxPerSecond, scrollLeft: Math.max(0, time * pxPerSecond - anchorX) };
}

/** One labeled ruler tick. */
export interface RulerTick {
  /** Px from the lanes' left edge. */
  x: number;
  label: string;
}

/** Candidate tick steps: frame counts below a second, then seconds. */
const FRAME_STEPS = [1, 2, 5, 10, 15];
const SECOND_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];

/**
 * Ruler ticks for the visible range: labeled ones at round times at least
 * {@link MIN_LABEL_SPACING} px apart, unlabeled ones dividing them.
 * Labels carry frames only when ticks fall between whole seconds.
 */
export function rulerTicks(
  viewport: { pxPerSecond: number; scrollLeft: number; width: number },
  fps: number,
): { major: RulerTick[]; minor: number[] } {
  const { pxPerSecond, scrollLeft, width } = viewport;
  // Steps in frames, so tick times are exact frame counts.
  const steps = [...FRAME_STEPS.filter((frames) => frames < fps), ...SECOND_STEPS.map((seconds) => seconds * fps)];
  const pxPerFrame = pxPerSecond / fps;
  const major = steps.find((frames) => frames * pxPerFrame >= MIN_LABEL_SPACING) ?? steps[steps.length - 1]!;
  const minor = [...steps]
    .reverse()
    .find((frames) => frames < major && major % frames === 0 && major / frames >= 4 && frames * pxPerFrame >= MIN_MINOR_SPACING);

  const firstFrame = scrollLeft / pxPerFrame;
  const lastFrame = (scrollLeft + width) / pxPerFrame;
  const x = (frame: number) => frame * pxPerFrame - scrollLeft;
  const withFrames = major % fps !== 0;
  const ticks: RulerTick[] = [];
  for (let k = Math.ceil(firstFrame / major - 1e-9); k * major <= lastFrame + 1e-9; k++) {
    const frame = k * major;
    const label = formatTimecode(frame / fps, fps);
    ticks.push({ x: round(x(frame)), label: withFrames ? label : label.slice(0, 8) });
  }
  const minors: number[] = [];
  if (minor !== undefined) {
    for (let k = Math.ceil(firstFrame / minor - 1e-9); k * minor <= lastFrame + 1e-9; k++) {
      if ((k * minor) % major !== 0) minors.push(round(x(k * minor)));
    }
  }
  return { major: ticks, minor: minors };
}

/** Three decimals; `+ 0` turns -0 into 0. */
function round(value: number): number {
  return Math.round(value * 1000) / 1000 + 0;
}

/** `hh:mm:ss:ff` at `fps`, the notation of the preview's timecode. */
export function formatTimecode(seconds: number, fps: number): string {
  const rate = Math.round(fps);
  const total = Math.round(Math.max(0, seconds) * fps);
  const frames = total % rate;
  const whole = Math.floor(total / rate);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${two(Math.floor(whole / 3600))}:${two(Math.floor(whole / 60) % 60)}:${two(whole % 60)}:${two(frames)}`;
}

/** Compact clip length: `4.5s` under a minute, else `m:ss` or `h:mm:ss`. */
export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${(Math.round(seconds * 10) / 10).toFixed(1)}s`;
  const whole = Math.round(seconds);
  const two = (n: number) => String(n).padStart(2, "0");
  const h = Math.floor(whole / 3600);
  const m = Math.floor(whole / 60) % 60;
  return h > 0 ? `${h}:${two(m)}:${two(whole % 60)}` : `${m}:${two(whole % 60)}`;
}

/** Scroll and zoom of the lanes canvas. */
export interface LaneViewport {
  pxPerSecond: number;
  /** Horizontal offset, px. */
  scrollLeft: number;
  /** Vertical offset of the lanes under the fixed ruler, px. */
  scrollTop: number;
}

/**
 * Clip under a point of the canvas (`x` from the lanes' left edge, `y` from
 * the top, ruler included); null over the ruler, gaps and empty lanes.
 */
export function clipAt(layout: TimelineLayout, viewport: LaneViewport, x: number, y: number): { row: TrackRow; clip: ClipBox } | null {
  if (y < RULER_HEIGHT) return null;
  const contentY = y + viewport.scrollTop;
  const row = layout.rows.find((candidate) => contentY >= candidate.top && contentY < candidate.top + candidate.height);
  if (!row) return null;
  const time = (x + viewport.scrollLeft) / viewport.pxPerSecond;
  const clip = visibleClips(row.clips, time, time + 1e-9)[0];
  return clip ? { row, clip } : null;
}
