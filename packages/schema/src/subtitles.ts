// Subtitle tracks (SPEC §3.4, §5.3): which words show when, in which style. Pure and shared: the export compiler
// burns exactly these cues (as ASS), the preview draws exactly these cues over the picture.
import type { Size } from "./composite.js";
import type { Clip, SubtitleTrack, Timeline } from "./timeline.js";
import type { Transcript } from "./transcript.js";

/** Where a subtitle line sits in the frame. */
export type SubtitlePosition = "top" | "center" | "bottom";

/** Positions a subtitle track's `style.position` may take. */
export const SUBTITLE_POSITIONS: readonly SubtitlePosition[] = ["top", "center", "bottom"];

/**
 * The one subtitle face, bundled so preview and export render the same
 * glyphs on every OS: Archivo Black (OFL-1.1) from npm
 * `@expo-google-fonts/archivo-black`. `ascent`/`descent` are its OS/2
 * winAscent/winDescent over unitsPerEm: libass sizes a line by their sum and
 * aligns on them, so the layout uses them too.
 */
export const SUBTITLE_FONT = {
  family: "Archivo Black",
  /** Module specifier of the TTF file. */
  module: "@expo-google-fonts/archivo-black/400Regular/ArchivoBlack_400Regular.ttf",
  /** File name export writes it under, in the directory libass reads fonts from. */
  file: "ArchivoBlack-Regular.ttf",
  ascent: 1.035,
  descent: 0.312,
} as const;

/** Style tokens of a preset. Sizes are fractions of the frame, so every output size looks the same. */
export interface SubtitlePreset {
  /** Font size (em) as a fraction of the frame's short side: a line fits portrait frames too. */
  size: number;
  uppercase: boolean;
  /** Text colour, `#rrggbb`. */
  color: string;
  /** Colour of the word being spoken (the keyword); null: no highlight. */
  highlight: string | null;
  /** Outline width as a fraction of the font size. */
  outline: number;
  outlineColor: string;
  /** Distance of the line box from the top or bottom edge, fraction of the frame height. */
  margin: number;
  position: SubtitlePosition;
  /** Most words on screen at once. */
  maxWords: number;
  /** Most characters (spaces included) on screen at once; a longer single word still shows alone. */
  maxChars: number;
}

/**
 * Built-in presets. `big-keyword`: a few large upper-case words, the word
 * being spoken highlighted, low in the frame (short-form style). `plain`:
 * sentence-length lines, no highlight.
 */
export const SUBTITLE_PRESETS = {
  "big-keyword": {
    size: 0.065,
    uppercase: true,
    color: "#ffffff",
    highlight: "#ffd426",
    outline: 0.09,
    outlineColor: "#000000",
    margin: 0.12,
    position: "bottom",
    maxWords: 3,
    maxChars: 18,
  },
  plain: {
    size: 0.045,
    uppercase: false,
    color: "#ffffff",
    highlight: null,
    outline: 0.08,
    outlineColor: "#000000",
    margin: 0.06,
    position: "bottom",
    maxWords: 7,
    maxChars: 42,
  },
} as const satisfies Record<string, SubtitlePreset>;

/** Name of a built-in preset. */
export type SubtitlePresetId = keyof typeof SUBTITLE_PRESETS;

/** Preset names, default first. */
export const SUBTITLE_PRESET_IDS = Object.keys(SUBTITLE_PRESETS) as SubtitlePresetId[];

/** Preset of a subtitle track whose `style` names none. */
export const DEFAULT_SUBTITLE_PRESET: SubtitlePresetId = "big-keyword";

/** A preset with the track's overrides applied. */
export interface SubtitleStyle extends SubtitlePreset {
  preset: SubtitlePresetId;
}

/**
 * The style a track's `style` field asks for: its preset (default
 * {@link DEFAULT_SUBTITLE_PRESET}) with `position` overridden. An unknown
 * preset name (hand-edited file) falls back to the default and is returned
 * in `unknownPreset` for a warning.
 */
export function resolveSubtitleStyle(style: SubtitleTrack["style"]): { style: SubtitleStyle; unknownPreset: string | null } {
  const asked = style?.preset;
  const known = asked !== undefined && Object.hasOwn(SUBTITLE_PRESETS, asked);
  const preset = known ? (asked as SubtitlePresetId) : DEFAULT_SUBTITLE_PRESET;
  const position = style?.position ?? SUBTITLE_PRESETS[preset].position;
  return { style: { ...SUBTITLE_PRESETS[preset], preset, position }, unknownPreset: asked !== undefined && !known ? asked : null };
}

/** One transcript word placed on the timeline by a subtitle track. */
export interface SubtitleWord {
  /** Word id in its transcript, e.g. `w_000123`. */
  id: string;
  asset: string;
  /** Followed clip that plays it. */
  clip: string;
  /** Text as corrected in the transcript's `edits`, ASS markup characters removed. */
  text: string;
  /** Timeline frames `[start, end)`, inside the clip. */
  start: number;
  end: number;
}

/** A clip's transcript, by asset; null when there is none. */
export type TranscriptLookup = (asset: string) => Transcript | null;

/**
 * Words a subtitle track shows (SPEC §5.3): for each media clip of the
 * followed track, the words of its asset's transcript whose midpoint lies in
 * the clip's `[in, out)` (the rule of `transcribe --verify` and the transcript
 * view), mapped through `start` and `speed` to timeline frames and clipped to
 * the clip. So a cut removes its words with no extra edit. Text comes from
 * the transcript's `edits` when a word has one; a word edited to nothing is
 * not shown. `timeline` must be flattened (nested clips resolved). Clip
 * edges round to frames like export's; an overlapping later clip wins.
 */
export function subtitleWords(timeline: Timeline, trackId: string, transcripts: TranscriptLookup, fps: number): SubtitleWord[] {
  const track = timeline.tracks.find((candidate) => candidate.id === trackId);
  if (!track || track.kind !== "subtitles") return [];
  const followed = timeline.tracks.find((candidate) => candidate.id === track.follows);
  if (!followed || followed.kind === "subtitles") return [];
  const frame = (seconds: number) => Math.round(seconds * fps);
  const spans = followed.clips
    .filter((clip): clip is Extract<Clip, { type: "media" }> => clip.type === "media" && "asset" in clip)
    .map((clip) => {
      const speed = clip.speed ?? 1;
      const start = frame(clip.start);
      return { clip, speed, start, end: Math.max(start + 1, frame(clip.start + (clip.out - clip.in) / speed)) };
    })
    .sort((a, b) => a.start - b.start);
  for (let i = 1; i < spans.length; i++) spans[i - 1]!.end = Math.min(spans[i - 1]!.end, spans[i]!.start);

  const words: SubtitleWord[] = [];
  for (const { clip, speed, start, end } of spans) {
    const transcript = transcripts(clip.asset);
    if (!transcript) continue;
    const at = (source: number) => Math.min(end, Math.max(start, frame(clip.start + (source - clip.in) / speed)));
    for (const word of [...transcript.words].sort((a, b) => a.start - b.start)) {
      const middle = (word.start + word.end) / 2;
      if (middle < clip.in || middle >= clip.out) continue;
      const text = cleanText(transcript.edits[word.id]?.text ?? word.text);
      const from = at(Math.max(word.start, clip.in));
      if (text === "" || from >= end) continue;
      words.push({ id: word.id, asset: clip.asset, clip: clip.id, text, start: from, end: Math.max(from, at(Math.min(word.end, clip.out))) });
    }
  }
  return words;
}

/** One subtitle line on screen: timeline frames `[start, end)`. */
export interface SubtitleCue {
  start: number;
  end: number;
  /** Words as displayed (preset case applied), in order. Word `i` is spoken from its `start` until word `i + 1` starts. */
  words: SubtitleWord[];
  /** The style highlights the word being spoken. */
  highlight: boolean;
}

/** A pause at least this long (timeline seconds) starts a new cue. */
const CUE_PAUSE_S = 0.6;
const SENTENCE_END = /[.!?…]["»”')]?$/;

/**
 * Group `words` into cues: at most `maxWords` words and `maxChars`
 * characters, broken after a sentence end and at a pause. A cue shows from
 * its first word's start to its last word's end (never into the next cue).
 */
export function subtitleCues(words: readonly SubtitleWord[], style: SubtitleStyle, fps: number): SubtitleCue[] {
  const pause = Math.round(CUE_PAUSE_S * fps);
  const cues: SubtitleCue[] = [];
  let current: SubtitleWord[] = [];
  const flush = () => {
    if (current.length === 0) return;
    cues.push({ start: current[0]!.start, end: Math.max(current[0]!.start + 1, current.at(-1)!.end), words: current, highlight: style.highlight !== null });
    current = [];
  };
  for (const word of words) {
    const shown = { ...word, text: style.uppercase ? word.text.toUpperCase() : word.text };
    const last = current.at(-1);
    if (last) {
      const chars = current.reduce((sum, w) => sum + w.text.length + 1, 0) + shown.text.length;
      if (current.length >= style.maxWords || chars > style.maxChars || shown.start - last.end >= pause || SENTENCE_END.test(last.text)) flush();
    }
    current.push(shown);
  }
  flush();
  for (let i = 1; i < cues.length; i++) cues[i - 1]!.end = Math.max(cues[i - 1]!.start + 1, Math.min(cues[i - 1]!.end, cues[i]!.start));
  return cues;
}

/**
 * The cue showing at timeline frame `frame` and the index of its word being
 * spoken (-1 when the style highlights none); null when no cue shows.
 */
export function subtitleAt(cues: readonly SubtitleCue[], frame: number): { cue: SubtitleCue; active: number } | null {
  let lo = 0;
  let hi = cues.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cues[mid]!.end <= frame) lo = mid + 1;
    else hi = mid;
  }
  const cue = cues[lo];
  if (!cue || cue.start > frame) return null;
  if (!cue.highlight) return { cue, active: -1 };
  let active = 0;
  while (active + 1 < cue.words.length && cue.words[active + 1]!.start <= frame) active++;
  return { cue, active };
}

/** Where a cue's line goes in a frame of a given size, px. */
export interface SubtitleLayout {
  /** Font size (em), whole px. */
  fontSize: number;
  /** Outline width around each glyph, px. */
  outline: number;
  /** The line is centered on this x. */
  centerX: number;
  /** Alphabetic baseline y. */
  baseline: number;
}

/**
 * Layout of `style` in a `frame`-sized picture: font sized on the short
 * side, line box (font ascent + descent) at the style's margin from the top
 * or bottom edge, or centered.
 */
export function subtitleLayout(style: SubtitleStyle, frame: Size): SubtitleLayout {
  const fontSize = Math.max(1, Math.round(style.size * Math.min(frame.width, frame.height)));
  const ascent = fontSize * SUBTITLE_FONT.ascent;
  const descent = fontSize * SUBTITLE_FONT.descent;
  const margin = style.margin * frame.height;
  const baseline =
    style.position === "top" ? margin + ascent : style.position === "center" ? frame.height / 2 + (ascent - descent) / 2 : frame.height - margin - descent;
  return { fontSize, outline: round2(fontSize * style.outline), centerX: frame.width / 2, baseline: round2(baseline) };
}

/** Everything one subtitle track shows. */
export interface ResolvedSubtitleTrack {
  track: string;
  follows: string;
  style: SubtitleStyle;
  /** The track's `style.preset` when it names no built-in preset (the default was used); else null. */
  unknownPreset: string | null;
  cues: SubtitleCue[];
  /** Assets the followed track plays that have no transcript: their words cannot show. */
  missing: string[];
}

/** Every subtitle track of flattened `timeline`, in track order, with its cues. */
export function subtitleTracks(timeline: Timeline, transcripts: TranscriptLookup, fps: number): ResolvedSubtitleTrack[] {
  const out: ResolvedSubtitleTrack[] = [];
  for (const track of timeline.tracks) {
    if (track.kind !== "subtitles") continue;
    const { style, unknownPreset } = resolveSubtitleStyle(track.style);
    const followed = timeline.tracks.find((candidate) => candidate.id === track.follows);
    const assets = followed && followed.kind !== "subtitles" ? followed.clips.flatMap((clip) => ("asset" in clip && clip.type === "media" ? [clip.asset] : [])) : [];
    const missing = [...new Set(assets)].filter((asset) => transcripts(asset) === null);
    const cues = subtitleCues(subtitleWords(timeline, track.id, transcripts, fps), style, fps);
    out.push({ track: track.id, follows: track.follows, style, unknownPreset, cues, missing });
  }
  return out;
}

/** Braces and backslashes are ASS markup: dropped so export shows what the preview shows. */
function cleanText(text: string): string {
  return text.replace(/[{}\\]/g, "").replace(/\s+/g, " ").trim();
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
