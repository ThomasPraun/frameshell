// Subtitle tracks (SPEC §3.4, §5.3): which words show when, in which style. Pure and shared: the export compiler
// burns exactly these cues (as ASS), the preview draws exactly these cues over the picture.
import type { Size } from "./composite.js";
import { type CaptionGap, type CaptionPhrase, type Clip, SUBTITLE_ENTRIES, type SubtitleEntry, type SubtitleTrack, type Timeline } from "./timeline.js";
import { type Transcript, wordSpeaker } from "./transcript.js";

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
  /** Colour of a phrase's keyword (`#rrggbb`); null: it keeps the text colour. */
  keywordColor: string | null;
  /** Keyword size at the start of its entry as a multiple of its size, settling to 1 (1: none). Needs an `entry`. */
  keywordScale: number;
  /** How cues enter; `none`: they just appear. */
  entry: SubtitleEntry;
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
    keywordColor: "#ffd426",
    keywordScale: 1.12,
    entry: "none",
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
    keywordColor: "#ffd426",
    keywordScale: 1.12,
    entry: "none",
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
  /** Cues start a speaker's turn with their name and never span two speakers (ADR 0020). */
  speakerNames: boolean;
}

/**
 * The style a track's `style` field asks for: its preset (default
 * {@link DEFAULT_SUBTITLE_PRESET}) with `position`, `speakerNames` (default false), `keywordColor`,
 * `keywordScale` and `entry` overridden. An unknown
 * preset name (hand-edited file) falls back to the default and is returned
 * in `unknownPreset` for a warning; an invalid override is ignored.
 */
export function resolveSubtitleStyle(style: SubtitleTrack["style"]): { style: SubtitleStyle; unknownPreset: string | null } {
  const asked = style?.preset;
  const known = asked !== undefined && Object.hasOwn(SUBTITLE_PRESETS, asked);
  const preset = known ? (asked as SubtitlePresetId) : DEFAULT_SUBTITLE_PRESET;
  const position = style?.position ?? SUBTITLE_PRESETS[preset].position;
  const base: SubtitlePreset = SUBTITLE_PRESETS[preset];
  const keywordColor = style?.keywordColor;
  const keywordScale = style?.keywordScale;
  const entry = style?.entry;
  return {
    style: {
      ...base,
      preset,
      position,
      speakerNames: style?.speakerNames === true,
      keywordColor: keywordColor === null || (typeof keywordColor === "string" && HEX.test(keywordColor)) ? keywordColor : base.keywordColor,
      keywordScale: typeof keywordScale === "number" && keywordScale >= 1 && keywordScale <= 2 ? keywordScale : base.keywordScale,
      entry: entry !== undefined && SUBTITLE_ENTRIES.includes(entry) ? entry : base.entry,
    },
    unknownPreset: asked !== undefined && !known ? asked : null,
  };
}

const HEX = /^#[0-9a-fA-F]{6}$/;

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
  /** Source-asset seconds of the word in its transcript. */
  sourceStart: number;
  sourceEnd: number;
  /** Speaker id in the word's transcript (an `edits` correction wins), when it names a listed speaker. */
  speaker?: string;
  /** That speaker's transcript name, ASS markup characters removed. */
  speakerName?: string;
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
  return trackWords(followed, transcripts, fps);
}

/**
 * The words one clip track speaks, mapped to timeline frames: what {@link subtitleWords} shows for a subtitle
 * track following `followed`, without needing the subtitle track (the cover's hook word search uses it).
 */
export function trackWords(followed: Exclude<Timeline["tracks"][number], { kind: "subtitles" }>, transcripts: TranscriptLookup, fps: number): SubtitleWord[] {
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
      const text = cleanSubtitleText(transcript.edits[word.id]?.text ?? word.text);
      const from = at(Math.max(word.start, clip.in));
      if (text === "" || from >= end) continue;
      const to = Math.max(from, at(Math.min(word.end, clip.out)));
      const speaker = wordSpeaker(transcript, word);
      const name = speaker === undefined ? undefined : transcript.speakers?.find((candidate) => candidate.id === speaker)?.name;
      words.push({
        id: word.id,
        asset: clip.asset,
        clip: clip.id,
        text,
        start: from,
        end: to,
        sourceStart: word.start,
        sourceEnd: word.end,
        ...(speaker !== undefined && name !== undefined ? { speaker, speakerName: cleanSubtitleText(name) } : {}),
      });
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
  /** Speaker name and colon ("Juan:", preset case applied) when the cue starts that speaker's turn. */
  label?: string;
  /** The style highlights the word being spoken. */
  highlight: boolean;
  /** Index in `words` of the phrase's keyword, when this cue shows it. */
  keyword?: number;
  /** How the cue's text enters. */
  entry: SubtitleEntry;
}

/** Hand-written captions of a track (#460) that {@link subtitleCues} applies. */
export interface CaptionRules {
  /** Chunks and keywords; words no phrase holds are grouped by the style. */
  phrases?: readonly CaptionPhrase[] | undefined;
  /** Ranges (timeline seconds) in which no cue shows: a cue overlapping one is hidden. */
  gaps?: readonly CaptionGap[] | undefined;
}

/** A pause at least this long (timeline seconds) starts a new cue. */
const CUE_PAUSE_S = 0.6;
/** A hand-chunked cue lasts until the next cue starts, at most this long after its last word (timeline seconds)... */
const CHUNK_TAIL_S = 0.35;
/** ...and, when nothing follows soon, never under this long. */
const CHUNK_MIN_S = 0.4;
const SENTENCE_END = /[.!?…]["»”')]?$/;

/** What a cue shows as space-joined tokens: its label (if any), then its words. */
export function cueTokens(cue: SubtitleCue): string[] {
  return cue.label === undefined ? cue.words.map((word) => word.text) : [cue.label, ...cue.words.map((word) => word.text)];
}

/**
 * Group `words` into cues: at most `maxWords` words and `maxChars`
 * characters, broken after a sentence end and at a pause. A cue shows from
 * its first word's start to its last word's end (never into the next cue).
 * With `style.speakerNames` a cue never spans two speakers (words of one
 * transcript speaker, or with none), and the first cue of a turn carries the
 * speaker's name as `label`, counted in `maxChars`.
 *
 * `rules.phrases` (#460) put the words they hold into the cues they chunk,
 * whatever the limits above: a chunk lasts until the next cue starts, at
 * most 0.35 s after its last word and not under 0.4 s (the next cue still
 * wins). A phrase's keyword is `keyword` of its cue. Words a cut removed
 * leave their chunk shorter. `rules.gaps` then hide every cue that overlaps one.
 */
export function subtitleCues(words: readonly SubtitleWord[], style: SubtitleStyle, fps: number, rules: CaptionRules = {}): SubtitleCue[] {
  const pause = Math.round(CUE_PAUSE_S * fps);
  const turn = (word: SubtitleWord) => (word.speaker === undefined ? "" : `${word.asset}\0${word.speaker}`);
  const chunkOf = chunkIndex(rules.phrases ?? []);
  const cues: SubtitleCue[] = [];
  const hand: boolean[] = [];
  let current: SubtitleWord[] = [];
  let label: string | undefined;
  let previous: SubtitleWord | undefined;
  let chunk: string | undefined;
  let keyword: number | undefined;
  let entry: SubtitleEntry = style.entry;
  const flush = () => {
    if (current.length === 0) return;
    cues.push({
      start: current[0]!.start,
      end: Math.max(current[0]!.start + 1, current.at(-1)!.end),
      words: current,
      ...(label === undefined ? {} : { label }),
      highlight: style.highlight !== null,
      ...(keyword === undefined ? {} : { keyword }),
      entry,
    });
    hand.push(chunk !== undefined);
    current = [];
    label = undefined;
    chunk = undefined;
    keyword = undefined;
    entry = style.entry;
  };
  for (const word of words) {
    const shown = { ...word, text: style.uppercase ? word.text.toUpperCase() : word.text };
    const last = current.at(-1);
    const info = chunkOf.get(`${word.asset}\0${word.id}`);
    const newTurn = style.speakerNames && (previous === undefined || turn(previous) !== turn(shown));
    if (last) {
      const handMade = info !== undefined || chunk !== undefined;
      const chars = (label === undefined ? 0 : label.length + 1) + current.reduce((sum, w) => sum + w.text.length + 1, 0) + shown.text.length;
      const automatic = current.length >= style.maxWords || chars > style.maxChars || shown.start - last.end >= pause || SENTENCE_END.test(last.text);
      if (newTurn || (handMade ? info?.chunk !== chunk : automatic)) flush();
    }
    if (current.length === 0) {
      chunk = info?.chunk;
      entry = info?.phrase.entry ?? style.entry;
      if (newTurn && shown.speakerName !== undefined) {
        const name = `${shown.speakerName}:`;
        label = style.uppercase ? name.toUpperCase() : name;
      }
    }
    if (info?.keyword) keyword = current.length;
    current.push(shown);
    previous = word;
  }
  flush();
  const tail = Math.round(CHUNK_TAIL_S * fps);
  const least = Math.round(CHUNK_MIN_S * fps);
  for (let i = 0; i < cues.length; i++) {
    const cue = cues[i]!;
    const next = cues[i + 1]?.start;
    if (hand[i]) {
      const lasting = Math.max(Math.min(cue.words.at(-1)!.end + tail, next ?? Number.POSITIVE_INFINITY), cue.start + least);
      cue.end = Math.max(cue.start + 1, Math.min(lasting, next ?? Number.POSITIVE_INFINITY));
    } else if (next !== undefined) {
      cue.end = Math.max(cue.start + 1, Math.min(cue.end, next));
    }
  }
  const hidden = (rules.gaps ?? []).map((gap) => ({ from: Math.round(gap.from * fps), to: Math.round(gap.to * fps) }));
  return hidden.length === 0 ? cues : cues.filter((cue) => !hidden.some((gap) => cue.start < gap.to && cue.end > gap.from));
}

/** Where each phrase word sits: its chunk (`phrase:chunk`), its phrase, and whether it is the keyword. Key `asset\0word id`. */
function chunkIndex(phrases: readonly CaptionPhrase[]): Map<string, { chunk: string; phrase: CaptionPhrase; keyword: boolean }> {
  const found = new Map<string, { chunk: string; phrase: CaptionPhrase; keyword: boolean }>();
  phrases.forEach((phrase, p) => {
    let c = 0;
    let used = 0;
    phrase.words.forEach((id, i) => {
      while (c < phrase.chunks.length - 1 && i >= used + phrase.chunks[c]!) used += phrase.chunks[c++]!;
      found.set(`${phrase.asset}\0${id}`, { chunk: `${p}:${c}`, phrase, keyword: phrase.keyword === i });
    });
  });
  return found;
}

/** Entry animation of a cue: the shapes preview and export share. */
export const SUBTITLE_ENTRY = {
  /** Seconds one unit takes from invisible to settled (soft: 0.3-0.45 s). */
  seconds: 0.4,
  /** Seconds between neighbouring characters in `chars`. */
  charStagger: 0.03,
  /** Blur at the start, as a fraction of the font size. */
  blur: 0.08,
  /** Easing exponent: progress is `t ** accel` (libass `\t` accel), so the motion eases out and never overshoots. */
  accel: 0.5,
} as const;

/** One piece of a cue's text that enters on its own: a token, or a character in `chars`. */
export interface EntryUnit {
  text: string;
  /** Index in {@link cueTokens}. */
  token: number;
  /** Seconds after the cue starts at which it begins to enter. */
  delay: number;
  /** Part of the phrase's keyword. */
  keyword: boolean;
}

/**
 * Units of `cue` in order, with their entry delays: `line` all at once;
 * `words` each at its spoken time (the speaker label at once); `chars` one
 * `SUBTITLE_ENTRY.charStagger` after another. `none` gives the tokens,
 * undelayed.
 */
export function entryUnits(cue: SubtitleCue, fps: number): EntryUnit[] {
  const tokens = cueTokens(cue);
  const lead = tokens.length - cue.words.length;
  const units: EntryUnit[] = [];
  let ordinal = 0;
  tokens.forEach((text, token) => {
    const index = token - lead;
    const keyword = cue.keyword !== undefined && index === cue.keyword;
    if (cue.entry === "chars") {
      for (const char of Array.from(text)) units.push({ text: char, token, delay: ordinal++ * SUBTITLE_ENTRY.charStagger, keyword });
      return;
    }
    const word = cue.words[index];
    units.push({ text, token, delay: cue.entry === "words" && word ? Math.max(0, (word.start - cue.start) / fps) : 0, keyword });
  });
  return units;
}

/** How far a unit with entry `delay` has entered `elapsed` seconds after its cue started: 0 invisible, 1 settled. */
export function entryProgress(elapsed: number, delay: number): number {
  const raw = Math.min(1, Math.max(0, (elapsed - delay) / SUBTITLE_ENTRY.seconds));
  return raw ** SUBTITLE_ENTRY.accel;
}

/** Seconds after the cue starts at which its last unit has settled; 0 for `none`. */
export function entryEnd(cue: SubtitleCue, fps: number): number {
  if (cue.entry === "none") return 0;
  return Math.max(...entryUnits(cue, fps).map((unit) => unit.delay)) + SUBTITLE_ENTRY.seconds;
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
  /** Frame rate `cues` are counted in. */
  fps: number;
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
    const cues = subtitleCues(subtitleWords(timeline, track.id, transcripts, fps), style, fps, { phrases: track.phrases, gaps: track.gaps });
    out.push({ track: track.id, follows: track.follows, style, unknownPreset, cues, fps, missing });
  }
  return out;
}

/** Braces and backslashes are ASS markup: dropped so export shows what the preview shows. */
export function cleanSubtitleText(text: string): string {
  return text.replace(/[{}\\]/g, "").replace(/\s+/g, " ").trim();
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
