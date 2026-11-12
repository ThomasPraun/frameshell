import { z } from "zod";
import { type ReviewSheet, ReviewTileSchema } from "./review.js";

// `analyze` (#471, epic #451): measure a reference video's grammar (rhythm, colour, look, events, loudness, tempo) so an agent makes "like this" from numbers.

/** Folder of analyses, project-relative: regenerable, gitignored with the rest of `.frameshell/`. One subfolder per analysed video. */
export const ANALYSIS_DIR = ".frameshell/analysis";

/** Name of the manifest `analyze` writes in its folder: the result plus the beat lists. */
export const ANALYSIS_MANIFEST = "analysis.json";

/** The sheets `analyze` can write. */
export const ANALYZE_SHEETS = ["contact", "shots"] as const;

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
  /** Flashes, appearing and disappearing elements, holds and sound hits, in time order. */
  events: AnalyzeEvent[];
  /** Null when the video has no sound. */
  loudness: AnalyzeLoudness | null;
  /** Null when there is no sound, or no steady beat in it (see `warnings`). */
  tempo: AnalyzeTempo | null;
  sheets: AnalyzeSheet[];
  warnings: string[];
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
  changeCount: z.int().describe("Big changes of the picture (6 grey levels of mean change between two frames, or a cut): cuts, flashes, jumps of the layout."),
  changesPerMinute: z.number().describe("`changeCount` per minute of film, 2 decimals."),
  largestGap: z.number().describe("Longest stretch between two big changes, or between an end of the film and the nearest one, seconds."),
  meanActivity: z.number().describe("Mean change between consecutive frames, grey levels 0 to 255 on a 64 px wide picture, 2 decimals."),
  bursts: z.array(BurstSchema).describe("Stretches with 3 or more big changes within 1.5 s: a montage burst, a flurry of effects."),
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

const SheetSchema = z.object({
  kind: z
    .enum(ANALYZE_SHEETS)
    .describe("`contact`: a frame every half second (2 per second) plus the first frame of every shot, labelled with the time. `shots`: the middle frame of every shot, labelled `#<shot> <start>`."),
  path: z.string().describe("Absolute path of the PNG."),
  width: z.int(),
  height: z.int(),
  columns: z.int(),
  rows: z.int(),
  tile: z.object({ width: z.int(), height: z.int() }).describe("Size of one tile in the image, px."),
  tiles: z.array(ReviewTileSchema).describe("In reading order."),
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
  events: z.array(EventSchema).describe("Flashes, appearing and disappearing elements, holds and sound hits, in time order. A hint to check on the sheets, not a guarantee."),
  loudness: LoudnessSchema.nullable().describe("Null when the video has no sound."),
  tempo: TempoSchema.nullable().describe("Null when there is no sound, or no steady beat in it (see `warnings`)."),
  sheets: z.array(SheetSchema).describe("Every image written, in order; a kind with many tiles is split into several images."),
  warnings: z.array(z.string()).describe("What could not be measured (no sound, no beat, sound too long for the beat detector…); empty when none."),
});
