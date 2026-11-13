import { COVER_MAX_CHARS } from "@frameshell/protocol";
import {
  type FontMetrics,
  SUBTITLE_FONT,
  SUBTITLE_PRESETS,
  type Size,
  type Timeline,
  type TranscriptLookup,
  cleanSubtitleText,
  edgeTransitions,
  normalizeToken,
  trackWords,
} from "@frameshell/schema";
import { assColor, assDocument } from "./ass.js";

/**
 * Cover image and finished frame 0: a chosen frame of the timeline with one big word over it, in the
 * subtitle face and the `big-keyword` look until the project style (#468) holds its own. Pure: the face's
 * metrics come in as an argument, so plans stay golden-testable.
 */

/** What sizing a word needs of a face. */
type SizingMetrics = Pick<FontMetrics, "capHeight" | "width">;

/** Width a platform grid shows a cover at, px: the readability check scales the cover down to it. */
export const THUMBNAIL_WIDTH = 180;
/** Smallest capital letter, px at {@link THUMBNAIL_WIDTH}, that still reads in a grid. */
export const MIN_THUMBNAIL_CAP_HEIGHT = 12;
export { COVER_MAX_CHARS };
/** Fraction of the frame width the word may fill, outline included. */
const MAX_WIDTH_SHARE = 0.84;
/** Largest em as a fraction of the frame height: a one-letter word must not swallow the picture. */
const MAX_SIZE_SHARE = 0.32;
/** Outline as a fraction of the em, as the `big-keyword` subtitles draw it. */
const OUTLINE_SHARE = SUBTITLE_PRESETS["big-keyword"].outline;
/** The word's colour when the caller gives none: the keyword colour of the `big-keyword` look. */
export const DEFAULT_COVER_COLOR = SUBTITLE_PRESETS["big-keyword"].highlight;

/** Where and how big the cover word is drawn; all lengths in output pixels. */
export interface CoverLayout {
  /** Upper-case, ASS markup removed. */
  text: string;
  /** Fill, `#rrggbb`. */
  color: string;
  /** Outline: black on a light fill, white on a dark one. */
  outlineColor: string;
  /** Em size. */
  fontSize: number;
  /** Outline width. */
  outline: number;
  /** The word is centered on this x. */
  centerX: number;
  /** Alphabetic baseline y. */
  baseline: number;
}

/**
 * The cover text as it is drawn: whitespace collapsed, ASS markup dropped, upper-case. Empty when nothing is
 * left to draw.
 */
export function coverText(raw: string): string {
  return cleanSubtitleText(raw).toUpperCase();
}

/**
 * Lay `text` out in a `frame`-sized picture: one line centered on both axes, as large as the width
 * ({@link MAX_WIDTH_SHARE}) and height ({@link MAX_SIZE_SHARE}) allow. `text` must be non-empty after
 * {@link coverText}.
 */
export function layoutCover(text: string, frame: Size, metrics: SizingMetrics, fill: string = DEFAULT_COVER_COLOR): CoverLayout {
  const em = metrics.width(text);
  const fontSize = Math.max(1, Math.floor(Math.min((MAX_WIDTH_SHARE * frame.width) / (em + 2 * OUTLINE_SHARE), MAX_SIZE_SHARE * frame.height)));
  return {
    text,
    color: fill,
    outlineColor: luminance(fill) > LIGHT_FILL ? "#000000" : "#ffffff",
    fontSize,
    outline: round2(fontSize * OUTLINE_SHARE),
    centerX: frame.width / 2,
    baseline: round2(frame.height / 2 + (fontSize * metrics.capHeight) / 2),
  };
}

/** Relative luminance above which the outline turns black (the contrast with black and white is equal at 0.18). */
const LIGHT_FILL = 0.18;

/** Whether the word reads in a platform grid: its capitals at {@link THUMBNAIL_WIDTH} against the smallest that do. */
export interface CoverReadability {
  /** Width the cover is scaled to for the check, px. */
  thumbnailWidth: number;
  /** Height of a capital letter once the cover is scaled to `thumbnailWidth`, px. */
  capHeight: number;
  /** Smallest `capHeight` that reads. */
  minCapHeight: number;
  /** `capHeight` reaches `minCapHeight`. */
  readable: boolean;
}

/** Check `layout` at thumbnail size. */
export function coverReadability(layout: CoverLayout, frame: Size, metrics: SizingMetrics): CoverReadability {
  const capHeight = round2((layout.fontSize * metrics.capHeight * THUMBNAIL_WIDTH) / frame.width);
  return { thumbnailWidth: THUMBNAIL_WIDTH, capHeight, minCapHeight: MIN_THUMBNAIL_CAP_HEIGHT, readable: capHeight >= MIN_THUMBNAIL_CAP_HEIGHT };
}

/** ASS script drawing the cover word from time 0 on, in the bundled face. */
export function assCover(layout: CoverLayout, frame: Size): string {
  const style = [
    "Style: cover",
    SUBTITLE_FONT.family,
    round2(layout.fontSize * (SUBTITLE_FONT.ascent + SUBTITLE_FONT.descent)),
    assColor(layout.color),
    assColor(layout.color),
    assColor(layout.outlineColor),
    assColor(layout.outlineColor),
    "0,0,0,0,100,100,0,0,1",
    layout.outline,
    "0,2,0,0,0,1",
  ].join(",");
  // \an2: the point is the bottom of the line box, i.e. baseline + descent.
  const at = `{\\an2\\pos(${round2(layout.centerX)},${round2(layout.baseline + layout.fontSize * SUBTITLE_FONT.descent)})}`;
  return assDocument(frame, [style], [`Dialogue: 0,0:00:00.00,9:59:59.00,cover,,0,0,0,,${at}${layout.text}`]);
}

/**
 * Timeline seconds where the first run of words matching `text` starts, over the speech of every video and
 * audio track (earliest wins); null when nobody says it. Words compare as the aligner does
 * (`normalizeToken`: case, accents and punctuation ignored), a transcript correction counts. Limits: speech that
 * lives in a multicam group's angles (program tracks) is not searched, and a muted track or clip still counts as spoken.
 */
export function hookWordTime(timeline: Timeline, transcripts: TranscriptLookup, text: string, fps: number): number | null {
  const wanted = cleanSubtitleText(text).split(" ").map(normalizeToken).filter((token) => token !== "");
  if (wanted.length === 0) return null;
  let found: number | null = null;
  for (const track of timeline.tracks) {
    if (track.kind !== "video" && track.kind !== "audio") continue;
    const words = trackWords(track, transcripts, fps).filter((word) => normalizeToken(word.text) !== "");
    for (let i = 0; i + wanted.length <= words.length; i++) {
      if (!wanted.every((token, k) => normalizeToken(words[i + k]!.text) === token)) continue;
      const at = words[i]!.start / fps;
      if (found === null || at < found) found = at;
      break;
    }
  }
  return found;
}

/**
 * Timeline seconds of the first frame that shows a whole picture: where the earliest clip of a video or program
 * track starts, plus that clip's effective fade in from black (`edgeTransitions`), so the default cover is never
 * the black frame a fade-in opens with; 0 when there is no picture.
 */
export function firstPictureTime(timeline: Timeline, fps: number): number {
  let first: { start: number; fadeIn: number } | null = null;
  for (const track of timeline.tracks) {
    if (track.kind !== "video" && track.kind !== "program") continue;
    const edges = track.kind === "video" ? edgeTransitions(track.clips, { fps }) : null;
    for (const clip of track.clips) {
      if (first === null || clip.start < first.start) first = { start: clip.start, fadeIn: edges?.get(clip.id)?.fadeIn ?? 0 };
    }
  }
  return first === null ? 0 : round2(first.start + first.fadeIn);
}

/** WCAG relative luminance of `#rrggbb`. */
function luminance(hex: string): number {
  const channel = (offset: number) => {
    const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
