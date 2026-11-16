import { z } from "zod";
import { StyleSuggestionSchema } from "./brand.js";
import { type ReviewSheet, ReviewTileSchema } from "./review.js";

// `analyze` (#471, epic #451): measure a reference video's grammar (rhythm, colour, look, events, loudness, tempo) so an agent makes "like this" from numbers.

/** Folder of analyses, project-relative: regenerable, gitignored with the rest of `.frameshell/`. One subfolder per analysed video. */
export const ANALYSIS_DIR = ".frameshell/analysis";

/** Name of the manifest `analyze` writes in its folder: the result plus the beat lists. */
export const ANALYSIS_MANIFEST = "analysis.json";

/** Name of an analysis (its folder under {@link ANALYSIS_DIR}): letters, digits, `.`, `_` and `-`, at most 64, starting with a letter or digit. */
export const ANALYSIS_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** The sheets `analyze` can write. */
export const ANALYZE_SHEETS = ["contact", "shots", "diff"] as const;

/** One colour of a palette. */
export interface AnalyzeColor {
  /** `#rrggbb`: the mean of the pixels that count as this colour. */
  hex: string;
  /** Fraction of the sampled pixels that are this colour or a shade merged into it, 0 to 1; a palette is sorted by it. */
  share: number;
}

/** Columns and rows of the colour grid of a look. */
export const ANALYZE_GRID = { columns: 8, rows: 6 } as const;

/** How a picture looks, in four figures averaged over its frames. */
export interface AnalyzeShotLook {
  /** Mean luma (Rec. 709 weights on the gamma-coded values), 0 black to 1 white. */
  brightness: number;
  /** Mean over the frames of the spread (standard deviation) of luma inside a frame, 0 to 0.5. */
  contrast: number;
  /** Mean HSV saturation, 0 grey to 1 pure colour. */
  saturation: number;
  /** Mean of (red - blue) over 255, -1 blue to 1 red: above 0 the picture leans warm, below it cool. */
  warmth: number;
}

/** The look of the whole film: the figures and a coarse colour grid. */
export interface AnalyzeLook extends AnalyzeShotLook {
  /** Mean colour of each cell of an {@link ANALYZE_GRID} 8 x 6 grid laid over the picture, `#rrggbb`, row by row from the top left. */
  grid: string[];
}

/** Where a value in an analysis comes from; every value of an `analyze` result carries one (see `labels`). */
export const ANALYZE_LABELS = ["MEASURED", "ESTIMATED", "DECISION"] as const;

/** One of {@link ANALYZE_LABELS}. */
export type AnalyzeLabel = (typeof ANALYZE_LABELS)[number];

/** A box on the picture, as fractions of its width and height (0 to 1, origin top left). */
export interface AnalyzeBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** How much of the picture graphics and text cover. */
export interface AnalyzeInk {
  /** Mean over the frames of the share of the picture covered, 0 to 1. */
  mean: number;
  /** Largest share covered in any frame. */
  peak: number;
  /** Seconds of the first frame with the `peak`; null when nothing is covered. */
  peakAt: number | null;
  /** Box around what is covered at that frame, in steps of one grid cell (1/8 wide, 1/6 high); null when nothing is covered. */
  region: AnalyzeBox | null;
}

/** The eases a move is compared with. */
export const ANALYZE_EASES = ["linear", "in", "out", "inOut"] as const;

/** A stretch of steady motion of the picture. */
export interface AnalyzeMove {
  startFrame: number;
  /** The frame after the last one. */
  endFrame: number;
  start: number;
  end: number;
  /** `endFrame - startFrame` frames ÷ fps, rounded down. */
  duration: number;
  /** Largest change between two frames inside, grey levels 0 to 255 on a 64 px wide picture, 2 decimals. */
  peak: number;
  /** Seconds of the frame with the `peak`. */
  peakAt: number;
  /** The ease whose speed profile is closest to the move's: `linear` (steady), `in` (starts slow, ends fast), `out` (starts fast, settles), `inOut` (slow, fast, slow); null for a move under 4 frames or over 3 s. */
  ease: (typeof ANALYZE_EASES)[number] | null;
  /** Root-mean-square gap between the move's speed and that ease's, in units of the mean speed (0 an exact match), 3 decimals; null when `ease` is. */
  fit: number | null;
}

/** How much the picture changes over time. */
export interface AnalyzeCurve {
  /** Seconds each value covers (0.1, or more for a long film so that there are at most 1200 values). */
  step: number;
  /** Mean change between consecutive frames in each `step`, grey levels 0 to 255 on a 64 px wide picture, 2 decimals; value `i` starts at `i * step` seconds. */
  values: number[];
  /** Mean over every frame. */
  mean: number;
  /** Largest change between two frames. */
  peak: number;
  /** Seconds of that frame. */
  peakAt: number;
  /** Stretches of steady motion between the big changes of the picture, in time order, at most 200. */
  moves: AnalyzeMove[];
}

/** The lag between a talking face's mouth and the voice. */
export interface AnalyzeSync {
  /** Seconds the mouth moves after the voice (negative: before it), to the frame; null when it could not be measured (see `reason`). */
  offset: number | null;
  /** How alike mouth motion and voice level are at that offset, 0 to 1 (Pearson correlation); null when not measured. */
  confidence: number | null;
  /** The face track of the people scan the mouth was read from (`t1`…); null when not measured. */
  track: string | null;
  /** Frames the two were compared on. */
  frames: number;
  /** Why there is no offset; null when there is one. */
  reason: string | null;
}

/** One shot of the film. */
export interface AnalyzeShot {
  /** 1-based, in film order. */
  index: number;
  /** First frame (0-based) of the shot. */
  startFrame: number;
  /** The frame after the last one: the next shot's `startFrame`, or the number of frames. */
  endFrame: number;
  /** `startFrame` ÷ fps, rounded down to the millisecond. Every time of an analysis is written this way. */
  start: number;
  /** `endFrame` ÷ fps, rounded down. */
  end: number;
  /** `endFrame - startFrame` frames ÷ fps, rounded down: how long the shot lasts, seconds. */
  length: number;
  /** Scene score (0 to 1) of the cut that opens the shot; null for the first shot. */
  cutScore: number | null;
  /** Absolute path of a JPEG of the shot's middle frame, at most 640 px on the long side. */
  image: string;
  /** Dominant colours of the shot, up to 5, biggest first. */
  palette: AnalyzeColor[];
  /** How the shot looks. `analysis.json` adds `grid` (the 8 x 6 colour grid of the shot) to it. */
  look: AnalyzeShotLook;
  /** How much of the picture graphics and text cover in the shot, seen as detail that is not there at the shot's quietest. */
  ink: AnalyzeInk;
}

/** How the film is cut. */
export interface AnalyzeStats {
  shotCount: number;
  /** `shotCount - 1` cuts over the length of the film in minutes, 2 decimals. */
  cutsPerMinute: number;
  /** Seconds, rounded down. */
  averageLength: number;
  medianLength: number;
  shortest: number;
  longest: number;
}

/** Several big changes of the picture close together. */
export interface AnalyzeBurst {
  startFrame: number;
  /** The frame after the last change of the burst. */
  endFrame: number;
  start: number;
  end: number;
  /** Big changes inside. */
  count: number;
}

/** How the film moves in time. */
export interface AnalyzeRhythm {
  /** Standard deviation of the shot lengths over their mean, 3 decimals: 0 is a metronome, above 0.6 the cutting is irregular. */
  shotLengthCv: number;
  /** Share of the frames (after the first) in which the picture does not change, 0 to 1. */
  stillShare: number;
  /** Longest hold of the picture, seconds. */
  longestStill: number;
  /** Big changes of the picture: cuts, flashes, jumps of the layout. */
  changeCount: number;
  /** `changeCount` per minute of film, 2 decimals. */
  changesPerMinute: number;
  /** Longest stretch between two big changes, or between an end of the film and the nearest one, seconds. */
  largestGap: number;
  /** Mean change between consecutive frames, grey levels 0 to 255 on a 64 px wide picture, 2 decimals. */
  meanActivity: number;
  /** Stretches with 3 or more big changes within 1.5 s. */
  bursts: AnalyzeBurst[];
}

/** The kinds of {@link AnalyzeCut}. */
export const ANALYZE_CUT_KINDS = ["cut", "jump", "punch-in", "punch-out", "change"] as const;

/** Most cuts `analyze` lists; a film with more has its first ones listed and a warning. */
export const ANALYZE_MAX_CUTS = 300;

/** One big change of the picture, told apart by what it is. */
export interface AnalyzeCut {
  /** First frame (0-based) of the picture after the change. */
  frame: number;
  /** `frame` ÷ fps, rounded down to the millisecond. */
  time: number;
  /**
   * `cut`: a new scene. `jump`: the same framing with time skipped (a jump cut: the subject moved, the camera did not).
   * `punch-in` / `punch-out`: the same shot scaled up / down (a crop and zoom of it), see `scale`. `change`: not a cut: a
   * flash, a caption or an element on a picture that stays.
   */
  kind: (typeof ANALYZE_CUT_KINDS)[number];
  /** Mean grey change between the two frames, grey levels 0 to 255 on a 64 px wide picture, 2 decimals. */
  score: number;
  /** Zero-mean correlation of the frame before and the frame after, 0 to 1, 3 decimals: high is the same framing, but a moving subject lowers it. */
  similarity: number;
  /** A punch: how many times larger the picture after shows what the one before shows (1.3: 30 % bigger; under 1 a punch out), 2 decimals; null otherwise. */
  scale: number | null;
  /** Share of the picture that changed (grey levels past 16 after levelling the brightness), 0 to 1, 3 decimals. */
  changed: number;
  /** True when ffmpeg's scene score at `threshold` opened a shot here (it is in `shots`); false for what it missed. */
  opensShot: boolean;
}

/** What the cuts of the film are. */
export interface AnalyzeCuts {
  /** How many of each kind, every kind present. */
  counts: Record<(typeof ANALYZE_CUT_KINDS)[number], number>;
  /** Jump cuts and punches (in and out) per minute of film, 2 decimals: the cutting a talking-head reel uses. */
  jumpsPerMinute: number;
  /** Every big change in time order, at most {@link ANALYZE_MAX_CUTS}. */
  list: AnalyzeCut[];
}

/** The kinds of {@link AnalyzeEvent}. */
export const ANALYZE_EVENT_KINDS = ["flash", "appear", "disappear", "hold", "hit"] as const;

/** Something that happens in the film, at a frame. */
export interface AnalyzeEvent {
  /**
   * `flash`: the whole picture jumps brighter or darker for at most a quarter of a second. `appear` / `disappear`: part of
   * the picture gains / loses detail while the rest holds (an element enters or leaves, a caption shows or goes) over at most 2 s.
   * `hold`: the picture does not change for at least 0.5 s. `hit`: a sudden rise of the sound.
   */
  kind: (typeof ANALYZE_EVENT_KINDS)[number];
  /** First frame (0-based). A `hit` is one frame. */
  startFrame: number;
  /** The frame after the last one. */
  endFrame: number;
  /** `startFrame` ÷ fps, rounded down to the millisecond. */
  start: number;
  /** `endFrame` ÷ fps, rounded down. */
  end: number;
  /** `flash`: `up` (brighter) or `down` (darker). */
  direction?: "up" | "down" | undefined;
  /** `flash`: change of the mean luma, 0 to 1. `hit`: rise of the sound over the 80 ms before, dB. */
  amount?: number | undefined;
  /** `appear` / `disappear`: share of the picture that changed, 0 to 1. */
  area?: number | undefined;
  /** `appear` / `disappear`: box around what changed, as fractions of the picture width and height (0 to 1, top left origin). */
  region?: { x: number; y: number; width: number; height: number } | undefined;
  /** `hit`: loudest level in the 100 ms after the onset, dBFS. */
  level?: number | undefined;
  /** `hit`: seconds from the nearest big change of the picture within 0.2 s to the hit (negative: the hit comes first); null when none is near. */
  offset?: number | null | undefined;
}

/** Loudness of the sound by EBU R128. */
export interface AnalyzeLoudness {
  /** Integrated loudness, LUFS; null for silence. */
  integrated: number | null;
  /** Loudness range, LU; null for silence. */
  range: number | null;
  /** Highest true peak, dBTP; null for digital silence. */
  truePeak: number | null;
}

/** Tempo found in the sound. */
export interface AnalyzeTempo {
  bpm: number;
  /** Beats per bar. */
  meter: number;
  /** 0 to 1. */
  confidence: number;
  /** True under 0.5: the grid may be double or half time or a bar off, or the sound has no steady beat. */
  low: boolean;
  /** Largest gap between the straight grid and a hit it matched, ms. */
  residualMs: number;
  beatCount: number;
  downbeatCount: number;
  /** The other tempi, best supported first; only when `low`. */
  alternatives: { tempo: "double" | "half"; bpm: number }[];
  /** Beat detector and version, as in a beats file. */
  detector: string;
}

/** The pitch of a voice over some speech. Estimated from the mix, so loud music under the voice makes it less sure. */
export interface AnalyzePitch {
  /** 10th percentile of the voiced frames, Hz. */
  low: number;
  /** Median of the voiced frames, Hz. */
  median: number;
  /** 90th percentile of the voiced frames, Hz. */
  high: number;
  /** `low` to `high` in semitones, 1 decimal: how much the voice moves. */
  range: number;
  /** Voiced frames the figures are read from (one every 20 ms). */
  frames: number;
}

/** One sentence the voice speaks. */
export interface AnalyzeSentence {
  startFrame: number;
  /** The frame after the one the sentence ends in. */
  endFrame: number;
  /** `startFrame` ÷ fps, rounded down to the millisecond. */
  start: number;
  end: number;
  /** What was recognised, words as the transcription writes them. */
  text: string;
  /** Words with a letter or digit in them. */
  words: number;
  /** Words per second from the first word's start to the last word's end, pauses inside included, 2 decimals; null under 0.3 s. */
  pace: number | null;
  /** Null when fewer than 8 voiced frames were found. */
  pitch: AnalyzePitch | null;
  /** Level of the voice alone over the words, dBFS RMS, 1 decimal: the mix with the music under it taken off. Null when the music is as loud as the mix. */
  voice: number | null;
  /** Level of the music under the sentence, dBFS RMS, 1 decimal, from the gaps between its words; null when there is no music under it (below -50 dBFS) or no gap to read. */
  music: number | null;
  /** `voice` minus `music`, dB, 1 decimal: how far the voice sits over the music. Null when either is. */
  voiceOverMusic: number | null;
}

/** The spoken part of the sound. */
export interface AnalyzeSpeech {
  /** `skipped` when the speech could not be recognised (see `reason`); then there are no sentences, and no effects. */
  status: "measured" | "skipped";
  /** Why the speech was skipped; null when measured. */
  reason: string | null;
  /** Transcription provider and model the words came from; null when skipped. */
  provider: string | null;
  model: string | null;
  /** Language the provider reported, when it did. */
  language: string | null;
  sentences: AnalyzeSentence[];
  /** Words in all the sentences. */
  words: number;
  /** Seconds the sentences take together. */
  speakingTime: number;
  /** `words` over `speakingTime`, 2 decimals; null with no speech. */
  wordsPerSecond: number | null;
  /** The pitch over all the sentences; null with too little voiced speech. */
  pitch: AnalyzePitch | null;
  /** How far the voice sits over the music in the sentences that have music under them; null when none has. */
  overMusic: { count: number; median: number; lowest: number } | null;
}

/** One sound effect found over the music. */
export interface AnalyzeEffect {
  frame: number;
  /** `frame` ÷ fps, rounded down. */
  time: number;
  /** Peak of the effect together with what plays under it, dBFS, 1 decimal. */
  level: number;
  /** The effect alone over the bed under it, dB, 1 decimal; null when nothing plays under it (below -50 dBFS). */
  overMusic: number | null;
}

/** Effects of the sound: hits that are neither a word nor the music's own beat. */
export interface AnalyzeEffects {
  count: number;
  /** `count` per minute of sound, 2 decimals. */
  perMinute: number;
  /** Hits left out because they fall on the music's beat (only counted when the tempo is trustworthy). */
  onBeat: number;
  /** Over the effects that have music under them; null when none has. */
  overMusic: { median: number; loudest: number } | null;
  /** In time order, at most 100. */
  list: AnalyzeEffect[];
}

/** A stretch of the sound that keeps one level. */
export interface AnalyzeSection {
  startFrame: number;
  endFrame: number;
  start: number;
  end: number;
  /** Mean level of the sound without the words (the whole mix when the speech was skipped), dBFS RMS, 1 decimal. */
  level: number;
  /** `level` minus the section before it, dB; null for the first. */
  change: number | null;
  /** Length in bars when both ends sit on the tempo's downbeats; null otherwise. */
  bars: number | null;
  /** Share of the section that the sentences cover, 0 to 1; null when the speech was skipped. */
  speech: number | null;
}

/** What the sound does: speech, effects over the music and sections. */
export interface AnalyzeAudio {
  speech: AnalyzeSpeech;
  /** Null when the speech was skipped: without it a word cannot be told from an effect. */
  effects: AnalyzeEffects | null;
  /** Where the level of the sound steps by 4 dB or more, at least 4 s apart; one section for a steady sound. */
  sections: AnalyzeSection[];
}

/**
 * One `style.json` value an analysis suggests: the path and value as `style.set` takes them. Never applied by `analyze`;
 * `style.apply` with `analysis` applies the ones the person agrees to.
 */
export interface AnalyzeStyleSuggestion {
  /** A style path (`STYLE_PATHS`), e.g. `colors.accent`. */
  path: string;
  value: unknown;
  /** What in the film it comes from, with the numbers. */
  why: string;
  /** Paths of the result fields it is read from, e.g. `palette`, `curve.moves`. */
  from: string[];
  /** ESTIMATED: read off measured fields by a heuristic. DECISION: a taste rule over them, with nothing measured to match. */
  label: AnalyzeLabel;
}

/** One image `analyze` wrote: a `review` sheet of another kind. */
export interface AnalyzeSheet extends Omit<ReviewSheet, "kind"> {
  kind: (typeof ANALYZE_SHEETS)[number];
}

/** What `analyze` measured. */
export interface AnalyzeResultShape {
  /** Absolute path of the video analysed. */
  file: string;
  /** Name of the analysis: its folder is `.frameshell/analysis/<name>/`. */
  name: string;
  /** Absolute folder of the analysis. */
  dir: string;
  fps: number;
  /** Size of the video's frames, px. */
  width: number;
  height: number;
  frames: number;
  /** Seconds: `frames` ÷ fps, rounded down. */
  duration: number;
  /** Scene score a frame needed to open a shot. */
  threshold: number;
  shots: AnalyzeShot[];
  stats: AnalyzeStats;
  /** Dominant colours of the whole film, up to 5, biggest first. */
  palette: AnalyzeColor[];
  /** How the whole film looks. */
  look: AnalyzeLook;
  /** How the film moves in time. */
  rhythm: AnalyzeRhythm;
  /** Every big change of the picture told apart: new scene, jump cut, punch in or out, or no cut. */
  cuts: AnalyzeCuts;
  /** Flashes, appearing and disappearing elements, holds and sound hits, in time order. */
  events: AnalyzeEvent[];
  /** How much the picture changes over time, and the moves in it. */
  curve: AnalyzeCurve;
  /** How much of the picture graphics and text cover over the whole film. */
  ink: AnalyzeInk;
  /** Mouth against voice; `reason` says why not when it was not measured. */
  sync: AnalyzeSync;
  /** Null when the video has no sound. */
  loudness: AnalyzeLoudness | null;
  /** Null when there is no sound, or no steady beat in it (see `warnings`). */
  tempo: AnalyzeTempo | null;
  /** Sentences with pace and pitch, voice against music, effects over the music and sections. Null when the video has no sound. */
  audio: AnalyzeAudio | null;
  sheets: AnalyzeSheet[];
  /** Values for the project's `style.json` read from the film; never applied by `analyze`. */
  suggestions: AnalyzeStyleSuggestion[];
  warnings: string[];
  /** MEASURED, ESTIMATED or DECISION for every value: the key is the path of a field (`shots[].ink`, `events`), and covers everything inside it. */
  labels: Record<string, AnalyzeLabel>;
}

const ColorSchema = z.object({
  hex: z.string().describe("`#rrggbb`: the mean of the pixels that count as this colour."),
  share: z.number().describe("Fraction of the sampled pixels that are this colour or a shade merged into it, 0 to 1; the palette is sorted by it."),
});

const ShotLookSchema = z.object({
  brightness: z.number().describe("Mean luma (Rec. 709 weights on the gamma-coded values), 0 black to 1 white."),
  contrast: z.number().describe("Mean over the frames of the spread (standard deviation) of luma inside a frame, 0 to 0.5: flat grey 0, half black and half white 0.5."),
  saturation: z.number().describe("Mean HSV saturation of the pixels, 0 grey to 1 pure colour."),
  warmth: z.number().describe("Mean of (red - blue) over 255, -1 blue to 1 red: above 0 the picture leans warm, below it cool."),
});

const BoxSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
});

const InkSchema = z.object({
  mean: z.number().describe("Mean over the frames of the share of the picture covered by graphics or text, 0 to 1, 3 decimals."),
  peak: z.number().describe("Largest share covered in any frame, 0 to 1."),
  peakAt: z.number().nullable().describe("Seconds of the first frame with the `peak`; null when nothing is covered."),
  region: BoxSchema.nullable().describe("Box around what is covered at that frame, as fractions of the picture's width and height (origin top left), in steps of one grid cell (1/8 wide, 1/6 high); null when nothing is covered."),
});

const MoveSchema = z.object({
  startFrame: z.int(),
  endFrame: z.int().describe("The frame after the last one."),
  start: z.number(),
  end: z.number(),
  duration: z.number().describe("`endFrame - startFrame` frames ÷ fps, rounded down, seconds."),
  peak: z.number().describe("Largest change between two frames inside the move, grey levels 0 to 255 on a 64 px wide picture."),
  peakAt: z.number().describe("Seconds of the frame with the `peak`."),
  ease: z
    .enum(ANALYZE_EASES)
    .nullable()
    .describe("The ease whose speed profile is closest to the move's: `linear` (steady), `in` (starts slow, ends fast), `out` (starts fast, settles), `inOut` (slow, fast, slow). Null for a move under 4 frames or over 3 s (camera work, a subject walking)."),
  fit: z.number().nullable().describe("Root-mean-square gap between the move's speed and that ease's, in units of the mean speed: 0 is an exact match, over 0.5 a poor one. Null when `ease` is."),
});

const CurveSchema = z.object({
  step: z.number().describe("Seconds each value covers: 0.1, or more for a long film so that there are at most 1200 values."),
  values: z.array(z.number()).describe("Mean change between consecutive frames in each `step`, grey levels 0 to 255 on a 64 px wide picture, 2 decimals. Value `i` starts at `i * step` seconds; a cut is a spike."),
  mean: z.number().describe("Mean over every frame."),
  peak: z.number().describe("Largest change between two frames."),
  peakAt: z.number().describe("Seconds of that frame."),
  moves: z.array(MoveSchema).describe("Stretches of steady motion between the big changes of the picture (a pan, a slide-in, a zoom, a counter), in time order, at most 200. The direction of a move and any overshoot are not measured: the change has no sign."),
});

const SyncSchema = z.object({
  offset: z.number().nullable().describe("Seconds the mouth moves after the voice (negative: before it), to the frame. Positive: the picture is late or the sound early. Null when not measured: see `reason`."),
  confidence: z.number().nullable().describe("How alike mouth motion and voice level are at that offset, 0 to 1 (Pearson correlation). Under 0.2 there is no offset. Null when not measured."),
  track: z.string().nullable().describe("The face track of the people scan the mouth was read from (`t1`…); null when not measured."),
  frames: z.int().describe("Frames the two were compared on."),
  reason: z.string().nullable().describe("Why there is no offset (no sound, no people scan of this file, a face that does not talk…); null when there is one."),
});

const LabelsSchema = z.record(z.string(), z.enum(ANALYZE_LABELS));

const ShotSchema = z.object({
  index: z.int().describe("1-based, in film order."),
  startFrame: z.int().describe("First frame (0-based) of the shot."),
  endFrame: z.int().describe("The frame after the last one: the next shot's `startFrame`, or the number of frames."),
  start: z.number().describe("`startFrame` ÷ fps, rounded down to the millisecond. Every time of an analysis is written this way."),
  end: z.number().describe("`endFrame` ÷ fps, rounded down."),
  length: z.number().describe("`endFrame - startFrame` frames ÷ fps, rounded down: how long the shot lasts, seconds."),
  cutScore: z.number().nullable().describe("Scene score (0 to 1) of the cut that opens the shot: how different its first picture is from the one before. Null for the first shot."),
  image: z.string().describe("Absolute path of a JPEG of the shot's middle frame, at most 640 px on the long side."),
  palette: z.array(ColorSchema).describe("Dominant colours of the shot, up to 5, biggest first."),
  look: ShotLookSchema.describe("How the shot looks. `analysis.json` adds `grid` (the 8 x 6 colour grid of the shot) to it."),
  ink: InkSchema.describe("How much of the picture graphics and text cover in the shot: detail in a grid cell that is not there at the shot's quietest. Text that stays on the whole shot is not seen."),
});

const LookSchema = z.object({
  ...ShotLookSchema.shape,
  grid: z.array(z.string()).describe("Mean colour of each cell of an 8 columns x 6 rows grid laid over the picture, `#rrggbb`, 48 values row by row from the top left."),
});

const BurstSchema = z.object({
  startFrame: z.int(),
  endFrame: z.int().describe("The frame after the last change of the burst."),
  start: z.number(),
  end: z.number(),
  count: z.int().describe("Big changes of the picture inside."),
});

const RhythmSchema = z.object({
  shotLengthCv: z.number().describe("Standard deviation of the shot lengths over their mean, 3 decimals: 0 is a metronome, above 0.6 the cutting is irregular."),
  stillShare: z.number().describe("Share of the frames (after the first) in which the picture does not change (mean change under 0.5 grey levels), 0 to 1."),
  longestStill: z.number().describe("Longest hold of the picture, seconds."),
  changeCount: z.int().describe("Big changes of the picture (a frame 4 times the change around it or 15 % of the grey range, or a cut): cuts, flashes, jumps of the layout."),
  changesPerMinute: z.number().describe("`changeCount` per minute of film, 2 decimals."),
  largestGap: z.number().describe("Longest stretch between two big changes, or between an end of the film and the nearest one, seconds."),
  meanActivity: z.number().describe("Mean change between consecutive frames, grey levels 0 to 255 on a 64 px wide picture, 2 decimals."),
  bursts: z.array(BurstSchema).describe("Stretches with 3 or more big changes within 1.5 s: a montage burst, a flurry of effects."),
});

const CutSchema = z.object({
  frame: z.int().describe("First frame (0-based) of the picture after the change."),
  time: z.number().describe("`frame` ÷ fps, rounded down to the millisecond."),
  kind: z
    .enum(ANALYZE_CUT_KINDS)
    .describe(
      "`cut`: a new scene. `jump`: the same framing with time skipped (the subject moved, the camera did not). `punch-in` / `punch-out`: the same shot scaled up / down (a crop and zoom), see `scale`. `change`: not a cut: a flash, a caption or an element on a picture that stays.",
    ),
  score: z.number().describe("Mean grey change between the two frames, grey levels 0 to 255 on a 64 px wide picture, 2 decimals."),
  similarity: z.number().describe("Zero-mean correlation of the frame before and the frame after, 0 to 1, 3 decimals: high is the same framing, but a moving subject lowers it."),
  scale: z.number().nullable().describe("A punch: how many times larger the picture after shows what the one before shows (1.3: 30 % bigger; under 1 a punch out), 2 decimals, good to a few percent; null otherwise."),
  changed: z.number().describe("Share of the picture that changed (grey levels past 16 after levelling the brightness), 0 to 1, 3 decimals."),
  opensShot: z.boolean().describe("True when ffmpeg's scene score at `threshold` opened a shot here (it is in `shots`); false for the jump cuts and punches it missed."),
});

const CutsSchema = z.object({
  counts: z.object({ cut: z.int(), jump: z.int(), "punch-in": z.int(), "punch-out": z.int(), change: z.int() }).describe("How many big changes of each kind."),
  jumpsPerMinute: z.number().describe("Jump cuts and punches (in and out) per minute of film, 2 decimals."),
  list: z.array(CutSchema).describe("Every big change of the picture in time order, at most 300."),
});

const EventSchema = z.object({
  kind: z
    .enum(ANALYZE_EVENT_KINDS)
    .describe(
      "`flash`: the whole picture jumps brighter or darker for at most a quarter of a second. `appear` / `disappear`: part of the picture gains / loses detail while the rest holds (an element enters or leaves, a caption shows or goes), over at most 2 s. `hold`: the picture does not change for at least 0.5 s. `hit`: a sudden rise of the sound (an effect, a beat, a word after a pause).",
    ),
  startFrame: z.int().describe("First frame (0-based). A `hit` is one frame."),
  endFrame: z.int().describe("The frame after the last one."),
  start: z.number().describe("`startFrame` ÷ fps, rounded down to the millisecond."),
  end: z.number().describe("`endFrame` ÷ fps, rounded down."),
  direction: z.enum(["up", "down"]).optional().describe("`flash`: `up` brighter, `down` darker."),
  amount: z.number().optional().describe("`flash`: change of the mean luma, 0 to 1. `hit`: rise of the sound over the 80 ms before, dB."),
  area: z.number().optional().describe("`appear` / `disappear`: share of the picture that changed, 0 to 1."),
  region: z
    .object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() })
    .optional()
    .describe("`appear` / `disappear`: box around what changed, as fractions of the picture's width and height (0 to 1, origin top left, in steps of one grid cell: 1/8 wide, 1/6 high). Where text or an element shows up."),
  level: z.number().optional().describe("`hit`: loudest level in the 100 ms after the onset, dBFS."),
  offset: z
    .number()
    .nullable()
    .optional()
    .describe("`hit`: seconds from the nearest big change of the picture within 0.2 s to the hit (negative: the hit comes first); null when none is near. A hit on a cut or an element is an effect; one with null is music or speech."),
});

const StatsSchema = z.object({
  shotCount: z.int(),
  cutsPerMinute: z.number().describe("`shotCount - 1` cuts over the length of the film in minutes, 2 decimals."),
  averageLength: z.number().describe("Seconds, rounded down."),
  medianLength: z.number().describe("Seconds, rounded down."),
  shortest: z.number().describe("Seconds, rounded down."),
  longest: z.number().describe("Seconds, rounded down."),
});

const LoudnessSchema = z.object({
  integrated: z.number().nullable().describe("Integrated loudness, LUFS; null for silence (nothing above the absolute gate)."),
  range: z.number().nullable().describe("Loudness range, LU: how much the loudness varies; null for silence."),
  truePeak: z.number().nullable().describe("Highest true peak, dBTP; null for digital silence."),
});

const TempoSchema = z.object({
  bpm: z.number(),
  meter: z.int().describe("Beats per bar."),
  confidence: z.number().describe("0 to 1."),
  low: z.boolean().describe("True under 0.5: the grid may be double time or half time or a bar off, or the sound has no steady beat (speech)."),
  residualMs: z.number().describe("Largest gap between the straight grid and a hit it matched, ms; under 15 on clean music."),
  beatCount: z.int(),
  downbeatCount: z.int(),
  alternatives: z.array(z.object({ tempo: z.enum(["double", "half"]), bpm: z.number() })).describe("The other tempi, best supported first; only when `low`."),
  detector: z.string().describe("Beat detector and version, as in a beats file."),
});

const PitchSchema = z.object({
  low: z.number().describe("10th percentile of the voiced frames, Hz."),
  median: z.number().describe("Median of the voiced frames, Hz."),
  high: z.number().describe("90th percentile of the voiced frames, Hz."),
  range: z.number().describe("`low` to `high` in semitones, 1 decimal: how much the voice moves."),
  frames: z.int().describe("Voiced frames the figures are read from (one every 20 ms)."),
});

const SentenceSchema = z.object({
  startFrame: z.int(),
  endFrame: z.int().describe("The frame after the one the sentence ends in."),
  start: z.number().describe("`startFrame` ÷ fps, rounded down to the millisecond."),
  end: z.number().describe("`endFrame` ÷ fps, rounded down."),
  text: z.string().describe("What was recognised, as the transcription writes it."),
  words: z.int().describe("Words with a letter or digit in them."),
  pace: z.number().nullable().describe("Words per second from the first word's start to the last word's end (pauses inside included), 2 decimals; null under 0.3 s."),
  pitch: PitchSchema.nullable().describe("Null when fewer than 8 voiced frames were found."),
  voice: z.number().nullable().describe("Level of the voice alone over the words, dBFS RMS, 1 decimal: the mix with the music under it taken off. Null when the music is as loud as the mix."),
  music: z.number().nullable().describe("Level of the music under the sentence, dBFS RMS, 1 decimal, read from the gaps between its words; null when there is none under it (below -50 dBFS) or no gap to read."),
  voiceOverMusic: z.number().nullable().describe("`voice` minus `music`, dB, 1 decimal: how far the voice sits over the music. Null when either is."),
});

const SpeechSchema = z.object({
  status: z.enum(["measured", "skipped"]).describe("`skipped` when the speech could not be recognised (see `reason`, or `speech: false` was asked): no sentences, and no effects."),
  reason: z.string().nullable().describe("Why the speech was skipped; null when measured."),
  provider: z.string().nullable().describe("Transcription provider the words came from; null when skipped."),
  model: z.string().nullable(),
  language: z.string().nullable().describe("Language the provider reported, when it did."),
  sentences: z.array(SentenceSchema),
  words: z.int().describe("Words in all the sentences."),
  speakingTime: z.number().describe("Seconds the sentences take together."),
  wordsPerSecond: z.number().nullable().describe("`words` over `speakingTime`, 2 decimals; null with no speech."),
  pitch: PitchSchema.nullable().describe("The pitch over all the sentences; null with too little voiced speech."),
  overMusic: z
    .object({ count: z.int(), median: z.number(), lowest: z.number() })
    .nullable()
    .describe("How far the voice sits over the music (dB) in the sentences that have music under them; null when none has."),
});

const EffectSchema = z.object({
  frame: z.int(),
  time: z.number().describe("`frame` ÷ fps, rounded down."),
  level: z.number().describe("Peak of the effect together with what plays under it, dBFS, 1 decimal."),
  overMusic: z.number().nullable().describe("The effect alone over the bed under it, dB, 1 decimal; null when nothing plays under it (below -50 dBFS)."),
});

const EffectsSchema = z.object({
  count: z.int(),
  perMinute: z.number().describe("`count` per minute of sound, 2 decimals."),
  onBeat: z.int().describe("Hits left out because they fall on the music's beat (counted only when the tempo is trustworthy)."),
  overMusic: z.object({ median: z.number(), loudest: z.number() }).nullable().describe("Over the effects that have music under them, dB; null when none has."),
  list: z.array(EffectSchema).describe("In time order, at most 100."),
});

const SectionSchema = z.object({
  startFrame: z.int(),
  endFrame: z.int(),
  start: z.number(),
  end: z.number(),
  level: z.number().describe("Mean level of the sound without the words (the whole mix when the speech was skipped), dBFS RMS, 1 decimal."),
  change: z.number().nullable().describe("`level` minus the section before it, dB; null for the first."),
  bars: z.int().nullable().describe("Length in bars when both ends sit on the tempo's downbeats; null otherwise."),
  speech: z.number().nullable().describe("Share of the section the sentences cover, 0 to 1; null when the speech was skipped."),
});

const AudioSchema = z.object({
  speech: SpeechSchema,
  effects: EffectsSchema.nullable().describe("Hits of the sound that are neither a word nor the music's own beat, with their level over the music. Null when the speech was skipped: without it a word cannot be told from an effect."),
  sections: z.array(SectionSchema).describe("Stretches where the level of the sound (without the words when the speech was recognised) holds: a step of 4 dB or more starts a new one, at least 4 s apart. One for a steady sound."),
});

const SheetSchema = z.object({
  kind: z
    .enum(ANALYZE_SHEETS)
    .describe("`contact`: a frame every half second (2 per second) plus the first frame of every shot, labelled with the time. `shots`: the middle frame of every shot, labelled `#<shot> <start>`. `diff` (`analyze.diff` only): our film beside the reference at matched times, ours on the left."),
  path: z.string().describe("Absolute path of the PNG."),
  width: z.int(),
  height: z.int(),
  columns: z.int(),
  rows: z.int(),
  tile: z.object({ width: z.int(), height: z.int() }).describe("Size of one tile in the image, px."),
  tiles: z.array(ReviewTileSchema).describe("In reading order."),
});

const AnalyzeStyleSuggestionSchema = StyleSuggestionSchema.extend({
  path: z.string().describe("Style path, as `style.set` takes it (`style show` lists every one), e.g. `colors.accent`."),
  why: z.string().describe("What in the film it comes from, with the numbers."),
  from: z.array(z.string()).describe("Paths of the result fields it is read from, e.g. `palette`, `curve.moves`, `audio.speech.overMusic.median`."),
  label: z
    .enum(ANALYZE_LABELS)
    .describe("ESTIMATED: read off measured fields by a heuristic (check the frames). DECISION: a taste rule over them, with nothing measured to match. Say it when you show the suggestion."),
});

/**
 * What `analyze` measured. Typed by hand: inferred from the Zod object inside the `methods` registry it is too long
 * for TypeScript to print (TS7056).
 */
export const AnalyzeResultSchema: z.ZodType<AnalyzeResultShape> = z.object({
  file: z.string().describe("Absolute path of the video analysed."),
  name: z.string().describe("Name of the analysis: its folder is `.frameshell/analysis/<name>/`."),
  dir: z.string().describe("Absolute folder of the analysis: the sheets, `frames/shot-<n>.jpg` and `analysis.json` (this result with the beat lists in `tempo.beats` and `tempo.downbeats`)."),
  fps: z.number(),
  width: z.int().describe("Size of the video's frames, px."),
  height: z.int(),
  frames: z.int(),
  duration: z.number().describe("Seconds: `frames` ÷ fps, rounded down."),
  threshold: z.number().describe("Scene score a frame needed to open a shot."),
  shots: z.array(ShotSchema),
  stats: StatsSchema,
  palette: z.array(ColorSchema).describe("Dominant colours of the whole film, up to 5, biggest first."),
  look: LookSchema.describe("How the whole film looks: brightness, contrast, saturation, warmth and an 8 x 6 colour grid."),
  rhythm: RhythmSchema.describe("How the film moves in time: shot-length spread, share of still frames, big changes, bursts."),
  cuts: CutsSchema.describe("Every big change of the picture told apart: `cut` (new scene), `jump` (same framing, time skipped), `punch-in` / `punch-out` (same shot scaled, with `scale`) or `change` (a flash, a caption). Finds the jump cuts and punches the scene score misses (`opensShot: false`). A hint to check on the frames it names."),
  events: z.array(EventSchema).describe("Flashes, appearing and disappearing elements, holds and sound hits, in time order. A hint to check on the sheets, not a guarantee."),
  curve: CurveSchema.describe("How much the picture changes over time (every cut is a spike) and the steady moves in it, each with the closest ease."),
  ink: InkSchema.describe("How much of the picture graphics and text cover over the whole film; each shot's own is in `shots[].ink`."),
  sync: SyncSchema.describe("Mouth against voice for a talking face, from the face scan of `people scan` when this file has one cached; otherwise `reason` says why it is skipped."),
  loudness: LoudnessSchema.nullable().describe("Null when the video has no sound."),
  tempo: TempoSchema.nullable().describe("Null when there is no sound, or no steady beat in it (see `warnings`)."),
  audio: AudioSchema.nullable().describe("What the sound does: `speech` (sentences with pace in words per second, pitch range, and the voice against the music under it), `effects` over the music and `sections` of steady level. All ESTIMATED: read from the mix by a heuristic, not from separated stems. Null when the video has no sound."),
  sheets: z.array(SheetSchema).describe("Every image written, in order; a kind with many tiles is split into several images."),
  suggestions: z
    .array(AnalyzeStyleSuggestionSchema)
    .describe(
      "Values for the project's `style.json` (ADR 0028) read from the film, at most one per path: `colors.bg` (the largest colour of the palette), `colors.ink` (the palette colour with the most contrast against it, 4.5:1 or more), " +
        "`colors.accent` (the most saturated colour of the palette that is not grey), `motion.personality` (from the median length of the eased moves, else from the pace of the cutting) and `sound.musicUnderVoice` (how far the voice sits over the music). " +
        "Never applied: show them to the person (take the grammar, never the content) and apply what they agree to with `style.apply` `{ analysis: <name>, paths: [...] }` (one journaled change; `revert` undoes it) or `style.set`. Empty when nothing fits.",
    ),
  warnings: z.array(z.string()).describe("What could not be measured (no sound, no beat, sound too long for the beat detector…); empty when none."),
  labels: LabelsSchema.describe("MEASURED (read from the frames or the sound), ESTIMATED (a heuristic's hint: check the frames it names) or DECISION (a choice of the run) for every value: the key is the path of a field (`shots[].ink`, `events`) and covers all inside it; the most specific key wins. Say these words when you report a number."),
});

/**
 * The label of every value of an `analyze` result, by field path (`[]` for an array): a key covers everything inside it
 * and a more specific key wins. A test walks a real result to keep this complete.
 */
export const ANALYZE_RESULT_LABELS: Readonly<Record<string, AnalyzeLabel>> = {
  file: "MEASURED",
  name: "DECISION",
  dir: "DECISION",
  fps: "MEASURED",
  width: "MEASURED",
  height: "MEASURED",
  frames: "MEASURED",
  duration: "MEASURED",
  threshold: "DECISION",
  shots: "MEASURED",
  "shots[].ink": "ESTIMATED",
  stats: "MEASURED",
  palette: "MEASURED",
  look: "MEASURED",
  rhythm: "MEASURED",
  cuts: "ESTIMATED",
  "cuts.list[].frame": "MEASURED",
  "cuts.list[].time": "MEASURED",
  "cuts.list[].score": "MEASURED",
  "cuts.list[].opensShot": "MEASURED",
  events: "ESTIMATED",
  curve: "MEASURED",
  "curve.step": "DECISION",
  "curve.moves[].ease": "ESTIMATED",
  "curve.moves[].fit": "ESTIMATED",
  ink: "ESTIMATED",
  sync: "MEASURED",
  "sync.offset": "ESTIMATED",
  loudness: "MEASURED",
  tempo: "MEASURED",
  "tempo.alternatives": "ESTIMATED",
  audio: "ESTIMATED",
  sheets: "MEASURED",
  suggestions: "DECISION",
  warnings: "MEASURED",
};

/** Facts of one of the two films `analyze.diff` compares. */
export interface AnalyzeDiffFilm {
  /** Absolute path. */
  file: string;
  fps: number;
  /** Size of the frames, px. */
  width: number;
  height: number;
  frames: number;
  /** Seconds: `frames` ÷ fps, rounded down. */
  duration: number;
}

/** How the two films were lined up in time. */
export interface AnalyzeDiffAlignment {
  /** Seconds to add to a time of our film to find the same moment of the reference (positive: the reference is later). */
  lag: number;
  /** `activity`: the lag of the best match of the two activity curves; `forced`: given by the caller; `none`: no clear match, 0 is used (see `warnings`). */
  source: "activity" | "forced" | "none";
  /** Pearson correlation of the two activity curves at `lag`, -1 to 1, 3 decimals; null when a curve is flat. */
  correlation: number | null;
  /** Most the search looked for either way, seconds. */
  maxLag: number;
}

/** How much one film moves. */
export interface AnalyzeDiffEnergy {
  /** Mean change between consecutive frames over the matched stretch, grey levels 0 to 255 on a 64 px wide picture, 2 decimals. */
  mean: number;
  /** 95th percentile of that change. */
  p95: number;
}

/** Activity of both films in one window of the matched stretch. */
export interface AnalyzeDiffWindow {
  /** Seconds of the start of the window in our film. */
  at: number;
  /** Mean change in our film in the window. */
  film: number;
  /** Mean change in the reference over the same window (`at + lag`). */
  reference: number;
}

/** One SSIM reading. */
export interface AnalyzeDiffSample {
  /** Seconds in our film. */
  at: number;
  /** Seconds in the reference: `at + lag`. */
  referenceAt: number;
  /** Structural similarity of the two frames, -1 to 1 (1 identical), 3 decimals. */
  ssim: number;
}

/** What `analyze.diff` measured. */
export interface AnalyzeDiffResultShape {
  /** Name of the comparison: its folder is `.frameshell/analysis/<name>/`. */
  name: string;
  /** Absolute folder: `diff.json`, the sheet. */
  dir: string;
  film: AnalyzeDiffFilm;
  reference: AnalyzeDiffFilm;
  alignment: AnalyzeDiffAlignment;
  energy: {
    /** Seconds each window covers. */
    step: number;
    film: AnalyzeDiffEnergy;
    reference: AnalyzeDiffEnergy;
    /** `film.mean` over `reference.mean`: above 1 our film moves more; null when the reference holds still. */
    ratio: number | null;
    windows: AnalyzeDiffWindow[];
  };
  diff: {
    /** Seconds between readings. */
    every: number;
    /** Size both films were scaled to for the comparison, px. */
    size: { width: number; height: number };
    samples: AnalyzeDiffSample[];
    /** Mean SSIM of the samples. */
    mean: number;
    /** Lowest SSIM and its time in our film. */
    min: number;
    minAt: number;
    /** Share of the samples under 0.5, 0 to 1: how much of the film looks clearly different. */
    below: number;
  };
  sheets: AnalyzeSheet[];
  warnings: string[];
  labels: Record<string, AnalyzeLabel>;
}

/** The label of every value of an `analyze.diff` result; see {@link ANALYZE_RESULT_LABELS}. */
export const ANALYZE_DIFF_LABELS: Readonly<Record<string, AnalyzeLabel>> = {
  name: "DECISION",
  dir: "DECISION",
  film: "MEASURED",
  reference: "MEASURED",
  alignment: "MEASURED",
  "alignment.lag": "ESTIMATED",
  "alignment.correlation": "ESTIMATED",
  "alignment.maxLag": "DECISION",
  energy: "MEASURED",
  "energy.step": "DECISION",
  diff: "MEASURED",
  "diff.every": "DECISION",
  "diff.size": "DECISION",
  sheets: "MEASURED",
  warnings: "MEASURED",
};

const DiffFilmSchema = z.object({
  file: z.string().describe("Absolute path."),
  fps: z.number(),
  width: z.int().describe("Size of the frames, px."),
  height: z.int(),
  frames: z.int(),
  duration: z.number().describe("Seconds: `frames` ÷ fps, rounded down."),
});

const DiffEnergySchema = z.object({
  mean: z.number().describe("Mean change between consecutive frames over the matched stretch, grey levels 0 to 255 on a 64 px wide picture, 2 decimals."),
  p95: z.number().describe("95th percentile of that change: the size of its big moves."),
});

/**
 * What `analyze.diff` measured. Typed by hand like {@link AnalyzeResultSchema}: inferred from the Zod object inside the
 * `methods` registry it is too long for TypeScript to print (TS7056).
 */
export const AnalyzeDiffResultSchema: z.ZodType<AnalyzeDiffResultShape> = z.object({
  name: z.string().describe("Name of the comparison: its folder is `.frameshell/analysis/<name>/`."),
  dir: z.string().describe("Absolute folder of the comparison: the sheet PNGs and `diff.json` (this result)."),
  film: DiffFilmSchema.describe("Our film."),
  reference: DiffFilmSchema.describe("The reference."),
  alignment: z
    .object({
      lag: z.number().describe("Seconds to add to a time of our film to find the same moment of the reference (positive: the reference is later), to 50 ms."),
      source: z.enum(["activity", "forced", "none"]).describe("`activity`: the lag of the best match of the two activity curves; `forced`: the caller's `lag`; `none`: no clear match, 0 is used."),
      correlation: z.number().nullable().describe("Pearson correlation of the two activity curves at `lag`, -1 to 1, 3 decimals: above 0.5 the two move alike; null when a curve is flat."),
      maxLag: z.number().describe("Most the search looked for either way, seconds."),
    })
    .describe("How the two films were lined up in time: the diff and the sheet read matching times, not the same times."),
  energy: z
    .object({
      step: z.number().describe("Seconds each window covers."),
      film: DiffEnergySchema,
      reference: DiffEnergySchema,
      ratio: z.number().nullable().describe("`film.mean` over `reference.mean`: above 1 our film moves more, below 1 less; null when the reference holds still."),
      windows: z
        .array(z.object({ at: z.number(), film: z.number(), reference: z.number() }))
        .describe("Activity of both in each window of the matched stretch, `at` in seconds of our film (the reference's is `at + alignment.lag`): where one moves and the other holds, or the other way round."),
    })
    .describe("How much each film moves, and where, over the stretch both have."),
  diff: z
    .object({
      every: z.number().describe("Seconds between readings."),
      size: z.object({ width: z.int(), height: z.int() }).describe("Size both frames were scaled to for the comparison (the reference is stretched to our film's shape), px."),
      samples: z.array(z.object({ at: z.number(), referenceAt: z.number(), ssim: z.number() })).describe("SSIM of our frame at `at` and the reference's at `referenceAt`, 3 decimals, 1 identical."),
      mean: z.number().describe("Mean SSIM of the samples."),
      min: z.number().describe("Lowest SSIM."),
      minAt: z.number().describe("Seconds of the lowest, in our film."),
      below: z.number().describe("Share of the samples under 0.5, 0 to 1: how much of the film looks clearly different. A different film made in the same style reads low everywhere; this is a distance to read, not a pass or fail."),
    })
    .describe("SSIM (structural similarity, ffmpeg's `ssim`) of the two films at matched times."),
  sheets: z.array(SheetSchema).describe("Our film beside the reference at matched times (ours left, the reference right): the lowest SSIM moments and evenly spread ones, in time order."),
  warnings: z.array(z.string()).describe("What was not clean (shapes differ, no clear alignment, a stretch too short…); empty when none."),
  labels: LabelsSchema.describe("MEASURED, ESTIMATED or DECISION for every value, by field path; see `analyze`."),
});

/** Label of the value at `path` (`shots[3].ink.mean` or `shots[].ink.mean`) under `table`: the most specific key covering it; null when none does. */
export function labelOf(table: Readonly<Record<string, AnalyzeLabel>>, path: string): AnalyzeLabel | null {
  const parts = path.replace(/\[\d*\]/g, "[]").split(".");
  for (let n = parts.length; n > 0; n--) {
    const key = parts.slice(0, n).join(".");
    const label = table[key] ?? table[key.replace(/\[\]$/, "")];
    if (label) return label;
  }
  return null;
}
