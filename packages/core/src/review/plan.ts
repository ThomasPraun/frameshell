import type { ReviewSheetKind, TimelineView } from "@frameshell/protocol";

// Which frames `review` shows and how sheets are laid out. Pure: the frame sampling that #471 `analyze` reuses.
// Everything counts in frame indexes of the film (the timeline's or the file's frame rate).

/** Why a frame is on a sheet; see `ReviewTileSchema`. */
export type PickTag = "start" | "end" | "cut" | "marker" | "cue" | "zoom" | "grid" | "second" | "peak" | "head" | "tail";

/** A frame to show and why. */
export interface FramePick {
  frame: number;
  tag: PickTag;
}

/** Frames `first` to `end - 1` of a film. */
export interface FrameRange {
  first: number;
  end: number;
}

/** A time the film is worth looking at, from its timeline. */
export interface Critical {
  /** Seconds. */
  at: number;
  tag: Extract<PickTag, "cut" | "marker" | "cue" | "zoom">;
}

/** Most tiles of the contact sheet in all images: a film longer than this is sampled more coarsely. */
export const MAX_CONTACT_TILES = 120;
/** Most tiles of the phone sheet in all images. */
export const MAX_PHONE_TILES = 60;
/** Tiles per image of the contact sheet and the phone sheet. */
export const TILES_PER_CONTACT = 30;
export const TILES_PER_PHONE = 15;
/** Consecutive frames of a motion strip, and of each end of a loop seam. */
export const STRIP_FRAMES = 12;
export const SEAM_FRAMES = 6;
/** Seconds between the grid frames of the contact sheet unless the caller says. */
export const DEFAULT_EVERY_S = 0.5;
/** A grid frame this close (seconds) to a critical one is left out: they would show the same picture. */
const GRID_CLEARANCE_S = 0.2;
/** Peaks of motion reported, how far apart they are (seconds), and the weakest that counts (grey levels, 0 to 255). */
export const PEAKS = 5;
export const PEAK_GAP_S = 0.5;
export const MIN_PEAK_ENERGY = 0.5;
/** Strips written: the fastest moments. */
export const STRIPS = 2;
/** Width the grey frames of the motion measure are scaled to. */
export const ENERGY_WIDTH = 320;
/** Most samples the motion of a timeline is measured on (each is a frame render), of a file. */
export const MAX_TIMELINE_SAMPLES = 90;
export const MAX_FILE_SAMPLES = 3000;
/** Samples per second of the motion measure of a file, at most. */
export const FILE_SAMPLE_HZ = 15;

/** Frame index showing at `seconds`, as the `frame` method picks it. */
export function frameIndex(seconds: number, fps: number): number {
  return Math.floor((seconds + 0.0005) * fps);
}

/** Start of frame `frame`, seconds (3 decimals). */
export function frameTime(frame: number, fps: number): number {
  return Math.round((frame / fps) * 1000) / 1000;
}

/** The frames of `film` frames that `from` and `to` (seconds) ask for; null when the range holds none. */
export function frameRange(frames: number, fps: number, from?: number, to?: number): FrameRange | null {
  const first = from === undefined ? 0 : frameIndex(from, fps);
  const end = to === undefined ? frames : Math.min(frames, Math.ceil(to * fps - 1e-6));
  return first >= 0 && first < end ? { first, end } : null;
}

/**
 * Frames of the contact sheet: the first and last of the range, the `critical` times inside it, and a grid frame
 * every `every` seconds (default {@link DEFAULT_EVERY_S}, widened so the total stays within `cap`). Sorted, one
 * pick per frame. Over `cap`, grid frames go first, evenly; the first and last frame always stay.
 */
export function contactPicks(fps: number, range: FrameRange, critical: readonly Critical[], every?: number, cap = MAX_CONTACT_TILES): FramePick[] {
  const picks = new Map<number, PickTag>();
  const add = (frame: number, tag: PickTag) => {
    if (frame >= range.first && frame < range.end && !picks.has(frame)) picks.set(frame, tag);
  };
  add(range.first, "start");
  add(range.end - 1, "end");
  for (const { at, tag } of critical) add(frameIndex(at, fps), tag);
  const span = (range.end - range.first) / fps;
  const step = Math.max(1 / fps, every ?? Math.max(DEFAULT_EVERY_S, span / Math.max(1, cap - picks.size)));
  // A grid closer than the clearance asks for its own frames: half a step is the most that is left out around a critical one.
  const clear = Math.max(1, Math.min(Math.round(GRID_CLEARANCE_S * fps), Math.floor((step * fps) / 2)));
  const fixed = [...picks.keys()];
  const near = (frame: number) => fixed.some((other) => Math.abs(other - frame) < clear);
  for (let t = 0; ; t += step) {
    const frame = range.first + Math.round(t * fps);
    if (frame >= range.end) break;
    if (!near(frame)) add(frame, "grid");
  }
  const sorted = [...picks].map(([frame, tag]) => ({ frame, tag })).sort((a, b) => a.frame - b.frame);
  return sorted.length > cap ? thin(sorted, cap) : sorted;
}

/** `picks` cut to `cap`: grid frames dropped evenly first, then any but the first and last. */
function thin(picks: FramePick[], cap: number): FramePick[] {
  const evenly = (items: FramePick[], keep: number) => items.filter((_, i) => Math.floor(((i + 1) * keep) / items.length) > Math.floor((i * keep) / items.length));
  const fixed = picks.filter((pick) => pick.tag !== "grid");
  const grid = picks.filter((pick) => pick.tag === "grid");
  if (fixed.length <= cap) return [...fixed, ...evenly(grid, cap - fixed.length)].sort((a, b) => a.frame - b.frame);
  const ends = fixed.filter((pick) => pick.tag === "start" || pick.tag === "end");
  const rest = fixed.filter((pick) => pick.tag !== "start" && pick.tag !== "end");
  return [...ends, ...evenly(rest, Math.max(0, cap - ends.length))].sort((a, b) => a.frame - b.frame);
}

/** One frame per second of the range (a longer one is sampled more coarsely, to at most `cap` frames). */
export function phonePicks(fps: number, range: FrameRange, cap = MAX_PHONE_TILES): FramePick[] {
  const span = (range.end - range.first) / fps;
  const step = Math.max(1, span / cap);
  const picks: FramePick[] = [];
  for (let t = 0; ; t += step) {
    const frame = range.first + Math.round(t * fps);
    if (frame >= range.end) break;
    if (picks.at(-1)?.frame !== frame) picks.push({ frame, tag: "second" });
  }
  return picks;
}

/** The last {@link SEAM_FRAMES} and the first {@link SEAM_FRAMES} frames of the range (fewer on a film under 12 frames); null under 2 frames. */
export function seamPicks(range: FrameRange): FramePick[] | null {
  const frames = range.end - range.first;
  if (frames < 2) return null;
  const count = Math.min(SEAM_FRAMES, Math.floor(frames / 2));
  const tail = Array.from({ length: count }, (_, i): FramePick => ({ frame: range.end - count + i, tag: "tail" }));
  const head = Array.from({ length: count }, (_, i): FramePick => ({ frame: range.first + i, tag: "head" }));
  return [...tail, ...head];
}

/** A moment of fast change. */
export interface MotionPeak {
  /** Seconds of the middle of the change. */
  at: number;
  /** Grey levels, 0 to 255. */
  energy: number;
}

/**
 * The fastest moments of a motion series: `energy[i]` is how much the picture changed between sample `i - 1` and
 * sample `i` (`times` in seconds). Greedy: the strongest first, each at least {@link PEAK_GAP_S} from the ones
 * taken, up to {@link PEAKS}, none weaker than {@link MIN_PEAK_ENERGY}.
 */
export function motionPeaks(times: readonly number[], energy: readonly number[]): MotionPeak[] {
  const middle = (i: number) => (times[i - 1]! + times[i]!) / 2;
  const order = energy.map((value, i) => ({ i, value })).filter(({ i, value }) => i > 0 && value >= MIN_PEAK_ENERGY).sort((a, b) => b.value - a.value || a.i - b.i);
  const peaks: MotionPeak[] = [];
  for (const { i, value } of order) {
    const at = middle(i);
    if (peaks.length < PEAKS && peaks.every((peak) => Math.abs(peak.at - at) >= PEAK_GAP_S)) peaks.push({ at: Math.round(at * 1000) / 1000, energy: Math.round(value * 100) / 100 });
  }
  return peaks;
}

/** {@link STRIP_FRAMES} consecutive frames around second `at`, moved to stay inside the range; fewer when the range is shorter. */
export function stripPicks(fps: number, range: FrameRange, at: number): FramePick[] {
  const count = Math.min(STRIP_FRAMES, range.end - range.first);
  const first = Math.min(Math.max(range.first, Math.round(at * fps) - Math.floor(count / 2)), range.end - count);
  return Array.from({ length: count }, (_, i): FramePick => ({ frame: first + i, tag: "peak" }));
}

/** Frames between samples of the motion measure of a timeline of `frames` frames: every frame up to {@link MAX_TIMELINE_SAMPLES}, else spread. */
export function timelineSampleStep(frames: number): number {
  return Math.max(1, Math.ceil(frames / MAX_TIMELINE_SAMPLES));
}

/** Samples per second of the motion measure of a file of `seconds`. */
export function fileSampleRate(seconds: number, fps: number): number {
  return Math.min(FILE_SAMPLE_HZ, fps, MAX_FILE_SAMPLES / Math.max(seconds, 1));
}

/** How one kind of sheet is tiled. */
export interface SheetLayout {
  columns: number;
  /** Tiles per image; a longer pick list is split into several images. */
  perImage: number;
  /** Width of a tile, px. */
  tileWidth: number;
}

/** Tiling of `kind` for pictures of `aspect` (width / height): vertical films get more, narrower columns. */
export function sheetLayout(kind: ReviewSheetKind, aspect: number): SheetLayout {
  const tall = aspect < 1;
  switch (kind) {
    case "contact":
      return tall ? { columns: 10, perImage: TILES_PER_CONTACT, tileWidth: 160 } : { columns: 6, perImage: TILES_PER_CONTACT, tileWidth: 270 };
    case "phone":
      return { columns: 5, perImage: TILES_PER_PHONE, tileWidth: 360 };
    case "motion":
      return tall ? { columns: 6, perImage: STRIP_FRAMES, tileWidth: 320 } : { columns: 4, perImage: STRIP_FRAMES, tileWidth: 640 };
    case "seam":
      return tall ? { columns: 6, perImage: 2 * SEAM_FRAMES, tileWidth: 200 } : { columns: 6, perImage: 2 * SEAM_FRAMES, tileWidth: 320 };
  }
}

/** Height of a tile `width` px wide for pictures of `aspect`, even (video-safe). */
export function tileHeight(width: number, aspect: number): number {
  return Math.max(2, 2 * Math.round(width / aspect / 2));
}

/** `picks` split into the lists of each image. */
export function splitImages<T>(picks: readonly T[], perImage: number): T[][] {
  const images: T[][] = [];
  for (let i = 0; i < picks.length; i += perImage) images.push(picks.slice(i, i + perImage));
  return images;
}

/** Text drawn on a tile: the time, and why the frame is shown unless it is a plain grid or second frame. */
export function tileLabel(at: number, tag: PickTag): string {
  const time = at.toFixed(2);
  return tag === "grid" || tag === "second" ? time : `${time} ${tag}`;
}

/** The keys and timing of a clip of `timeline.show` that {@link timelineCritical} reads. */
interface KeyedClip {
  start: number;
  end: number | null;
  in?: number;
  speed?: number;
  keys?: { scale?: { at: number; value: number }[] };
}

/**
 * Times of a timeline worth a frame: where every clip of a visible picture track (video or program) starts and
 * where one ends before the timeline does (`cut`), every marker, every subtitle cue start (`cueStarts`, timeline
 * seconds) and, for a clip whose scale is keyed to more than one value, the key at its largest scale (`zoom`).
 */
export function timelineCritical(view: Pick<TimelineView, "tracks" | "markers">, cueStarts: readonly number[]): Critical[] {
  const found: Critical[] = [];
  for (const track of view.tracks) {
    if ((track.kind !== "video" && track.kind !== "program") || track.hidden === true) continue;
    for (const clip of track.clips as KeyedClip[]) {
      found.push({ at: clip.start, tag: "cut" });
      if (clip.end !== null) found.push({ at: clip.end, tag: "cut" });
      const scale = clip.keys?.scale;
      if (!scale || scale.length < 2 || clip.end === null) continue;
      const deepest = scale.reduce((best, key) => (key.value > best.value ? key : best));
      if (deepest.value <= Math.min(...scale.map((key) => key.value))) continue;
      const at = clip.start + (deepest.at - (clip.in ?? 0)) / (clip.speed ?? 1);
      if (at >= clip.start && at < clip.end) found.push({ at, tag: "zoom" });
    }
  }
  for (const marker of view.markers ?? []) found.push({ at: marker.at, tag: "marker" });
  for (const at of cueStarts) found.push({ at, tag: "cue" });
  return found;
}
