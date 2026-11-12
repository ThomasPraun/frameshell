import { z } from "zod";
import { type ReviewSheet, ReviewTileSchema } from "./review.js";

// `analyze` (#471, epic #451): measure a reference video's grammar (rhythm, colour, loudness, tempo) so an agent makes "like this" from numbers.

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
  loudness: LoudnessSchema.nullable().describe("Null when the video has no sound."),
  tempo: TempoSchema.nullable().describe("Null when there is no sound, or no steady beat in it (see `warnings`)."),
  sheets: z.array(SheetSchema).describe("Every image written, in order; a kind with many tiles is split into several images."),
  warnings: z.array(z.string()).describe("What could not be measured (no sound, no beat, sound too long for the beat detector…); empty when none."),
});
