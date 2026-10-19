// Timeline panel geometry: pure, DOM-free, so it is unit tested and shared by paint and hit testing.
import type { TimelineView } from "@frameshell/protocol";
import { SHOT_LOW_CONFIDENCE } from "@frameshell/schema";
import { t } from "../i18n.js";

/** Height of the time ruler above the lanes, px. */
export const RULER_HEIGHT = 22;

/** Height of the scene band under the ruler, px; the band exists only while a script scene has words on the timeline. */
export const SCENE_BAND_HEIGHT = 18;

/** Lane height per track kind, px. */
export const LANE_HEIGHT = { video: 44, program: 44, audio: 44, subtitles: 28 } as const;

/** Stand-in length of a clip whose end is unknown (nested timeline missing), when no clip follows it. */
const UNKNOWN_LENGTH_S = 2;

/** Labeled ruler ticks are at least this far apart, px. */
const MIN_LABEL_SPACING = 80;

/** Unlabeled ruler ticks are at least this far apart, px. */
const MIN_MINOR_SPACING = 6;

/** Most zoomed in: one frame this wide, px. */
const FRAME_PX_MAX = 24;

/** Angle colours the timeline and inspector cycle through, by an angle's place in its group. */
export const ANGLE_COLOR_COUNT = 6;

/** Track kind as the daemon reports it. */
export type TrackKind = TimelineView["tracks"][number]["kind"];

/** How a clip gets its pictures: from a file, another timeline, an adapter plugin (rendered), or a multicam group's angles. */
export type ClipKind = "media" | "timeline" | "generated" | "shot";

/** One clip placed on the timeline, times in timeline seconds. */
export interface ClipBox {
  id: string;
  /** Clip `type` as stored, e.g. `media`, `timeline`, `hyperframes`, `shot`. */
  type: string;
  kind: ClipKind;
  /** What it plays, for its label: file name, nested timeline id, composition name, or a shot's layout and angle ids. */
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
  /** Shots: what they show; null for other clips. */
  shot: ShotBox | null;
}

/** One angle a shot shows. */
export interface ShotAngle {
  /** Angle id in the group, as the shot stores it. */
  id: string;
  /** Angle name from the group; the id when the group does not list it. */
  name: string;
  /** Colour slot, 0 to {@link ANGLE_COLOR_COUNT} - 1: the angle's place in its group, so one person keeps one colour. */
  color: number;
}

/** A shot clip's layout and angles, and the director's verdict on it. */
export interface ShotBox {
  /** `solo`, `two-up` or `grid` as stored. */
  layout: string;
  /** In layout order. */
  angles: ShotAngle[];
  /** Director's confidence, 0 to 1; null on a shot a person chose. */
  confidence: number | null;
  /** Director's reason for the shot; null on a shot a person chose. */
  reason: string | null;
  /** Below `SHOT_LOW_CONFIDENCE`: worth a look. */
  doubtful: boolean;
}

/** One lane, in display order. */
export interface TrackRow {
  id: string;
  kind: TrackKind;
  /** Short label, numbered per kind from the bottom layer: `V1`, `P1`, `A2`, `S1`. */
  label: string;
  name: string | null;
  /** Subtitle tracks: label of the followed track; null otherwise. */
  followsLabel: string | null;
  /** Program tracks: id of the multicam group they show; null otherwise. */
  group: string | null;
  /** Program tracks: the group's angles in group order (what the number keys pick); empty otherwise. */
  angles: ShotAngle[];
  /** Top edge in content px (ruler included). */
  top: number;
  height: number;
  /** Sorted by start, never overlapping. */
  clips: ClipBox[];
}

/** A script scene's words placed on the timeline, as the scene band shows it (ADR 0015). */
export interface SceneBox {
  /** Project-relative script, e.g. `scripts/plan.md`. */
  script: string;
  /** Heading slug: the `#anchor` of a `scriptRef`. */
  slug: string;
  /** Heading text. */
  title: string;
  /** Timeline seconds of its first placed word. */
  start: number;
  /** Timeline seconds where its last placed word ends. */
  end: number;
  /** Ids of this timeline's clips whose `scriptRef` is the scene; the span is hollow while empty. */
  clips: string[];
}

/** Everything the panel draws, derived from one `timeline.show` result. */
export interface TimelineLayout {
  /** Scene spans in start order; empty draws no band. */
  scenes: SceneBox[];
  /** Height of the fixed top area, px: the ruler plus the scene band when there are scenes. Lanes start here. */
  head: number;
  rows: TrackRow[];
  /** Latest clip end, seconds; stand-in ends included. */
  duration: number;
  /** Content height: ruler plus every lane, px. */
  height: number;
  clipCount: number;
}

/**
 * Lay out a timeline the way editors read it: the top picture layer first
 * (the file lists the bottom layer first; program tracks stack among video
 * tracks), then audio, then subtitles. `scenes` add the band under the ruler
 * and push the lanes down.
 */
export function layoutTimeline(view: TimelineView, scenes: readonly SceneBox[] = []): TimelineLayout {
  const problems = new Map(view.problems.map((problem) => [problem.clip, problem.message]));
  const labels = new Map<string, string>();
  const counts: Record<TrackKind, number> = { video: 0, program: 0, audio: 0, subtitles: 0 };
  const prefix: Record<TrackKind, string> = { video: "V", program: "P", audio: "A", subtitles: "S" };
  for (const track of view.tracks) labels.set(track.id, `${prefix[track.kind]}${++counts[track.kind]}`);

  const byKind = (kind: TrackKind) => view.tracks.filter((track) => track.kind === kind);
  const pictures = view.tracks.filter((track) => track.kind === "video" || track.kind === "program");
  const ordered = [...pictures.reverse(), ...byKind("audio"), ...byKind("subtitles")];

  const head = RULER_HEIGHT + (scenes.length > 0 ? SCENE_BAND_HEIGHT : 0);
  let top = head;
  let duration = view.duration ?? 0;
  let clipCount = 0;
  const rows = ordered.map((track): TrackRow => {
    const group = track.kind === "program" ? view.groups?.find((candidate) => candidate.id === track.group) : undefined;
    const clips = track.clips.map((clip, index) => {
      const box = clipBox(clip, track.clips[index + 1]?.start, problems.get(clip.id) ?? null, group);
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
      group: track.kind === "program" ? (track.group ?? null) : null,
      angles: (group?.angles ?? []).map((angle, index): ShotAngle => ({ id: angle.id, name: angle.name, color: index % ANGLE_COLOR_COUNT })),
      top,
      height,
      clips,
    };
    top += height;
    return row;
  });
  return { scenes: [...scenes], head, rows, duration, height: top, clipCount };
}

type ClipView = TimelineView["tracks"][number]["clips"][number];
type GroupView = NonNullable<TimelineView["groups"]>[number];

/** Layout names as the user reads them; an unknown one shows as stored. */
export function layoutName(layout: string): string {
  return (t.timeline.layouts as Record<string, string>)[layout] ?? layout;
}

function shotBox(fields: Record<string, unknown>, group: GroupView | undefined): ShotBox {
  const ids = Array.isArray(fields["angles"]) ? (fields["angles"] as unknown[]).filter((angle): angle is string => typeof angle === "string") : [];
  const angles = ids.map((id, index): ShotAngle => {
    const at = group ? group.angles.findIndex((angle) => angle.id === id) : -1;
    return { id, name: at >= 0 ? group!.angles[at]!.name : id, color: (at >= 0 ? at : index) % ANGLE_COLOR_COUNT };
  });
  const confidence = typeof fields["confidence"] === "number" ? (fields["confidence"] as number) : null;
  return {
    layout: typeof fields["shot"] === "string" ? (fields["shot"] as string) : "",
    angles,
    confidence,
    reason: typeof fields["reason"] === "string" ? (fields["reason"] as string) : null,
    doubtful: confidence !== null && confidence < SHOT_LOW_CONFIDENCE,
  };
}

function clipBox(clip: ClipView, nextStart: number | undefined, problem: string | null, group?: GroupView): ClipBox {
  const fields = clip as Record<string, unknown>;
  const text = (key: string) => (typeof fields[key] === "string" ? (fields[key] as string) : null);
  const num = (key: string, fallback: number) => (typeof fields[key] === "number" ? (fields[key] as number) : fallback);
  const kind: ClipKind = clip.type === "media" ? "media" : clip.type === "timeline" ? "timeline" : clip.type === "shot" ? "shot" : "generated";
  const asset = kind === "media" ? text("asset") : null;
  const source = text("source");
  let name: string;
  const shot = kind === "shot" ? shotBox(fields, group) : null;
  if (asset) name = baseName(asset);
  else if (shot) name = [layoutName(shot.layout), shot.angles.map((angle) => angle.name).join(", ")].filter(Boolean).join(" · ");
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
    problem: clip.end === null ? (problem ?? t.timeline.lengthUnknown) : null,
    gain: typeof audio.gain === "number" ? audio.gain : 0,
    muted: audio.muted === true,
    transform: transform ? { x: part("x", 0), y: part("y", 0), scale: part("scale", 1), opacity: part("opacity", 1) } : null,
    shot,
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
 * Scene span under a point of the canvas (`x` from the lanes' left edge, `y`
 * from the top); null outside the band. The band is fixed: vertical scroll
 * does not move it. Where spans overlap, the one drawn last (latest start) wins.
 */
export function sceneAt(layout: TimelineLayout, viewport: LaneViewport, x: number, y: number): SceneBox | null {
  if (y < RULER_HEIGHT || y >= layout.head) return null;
  const time = (x + viewport.scrollLeft) / viewport.pxPerSecond;
  return layout.scenes.findLast((scene) => time >= scene.start && time < scene.end) ?? null;
}

/**
 * Clip under a point of the canvas (`x` from the lanes' left edge, `y` from
 * the top, ruler included); null over the ruler and scene band, gaps and empty lanes.
 */
export function clipAt(layout: TimelineLayout, viewport: LaneViewport, x: number, y: number): { row: TrackRow; clip: ClipBox } | null {
  if (y < layout.head) return null;
  const contentY = y + viewport.scrollTop;
  const row = layout.rows.find((candidate) => contentY >= candidate.top && contentY < candidate.top + candidate.height);
  if (!row) return null;
  const time = (x + viewport.scrollLeft) / viewport.pxPerSecond;
  const clip = visibleClips(row.clips, time, time + 1e-9)[0];
  return clip ? { row, clip } : null;
}
