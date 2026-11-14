import { z } from "zod";
import { GradeSchema } from "@frameshell/schema";

// `grade.analyze` (#384, ADR 0031): measured levels of a clip's picture and a bounded correction suggestion, never applied.

/** Most frames one `grade.analyze` over a range measures. */
export const GRADE_ANALYZE_MAX_SAMPLES = 32;
/** Frames `grade.analyze` measures over a range when `samples` is not given. */
export const GRADE_ANALYZE_DEFAULT_SAMPLES = 8;

/** Levels of a picture, measured by ffmpeg `signalstats` on the clip's source before its grade. Every figure is the mean over the frames measured, except `min` and `max`. */
export const GradeLevelsSchema = z.object({
  luma: z
    .object({
      min: z.number().describe("Darkest pixel of any frame, 0 black to 1 white (video levels: studio black 16 reads 0)."),
      low: z.number().describe("10th percentile: the shadows."),
      mean: z.number().describe("Average brightness."),
      high: z.number().describe("90th percentile: the highlights."),
      max: z.number().describe("Brightest pixel of any frame."),
    })
    .describe("Brightness of the encoded picture (Rec.709 luma), 0 to 1, 3 decimals."),
  saturation: z
    .number()
    .describe("Mean colour strength per pixel (ffmpeg SATAVG over 224), 0 grey to 1; footage is usually 0.05 to 0.25. 3 decimals. Not the HSV saturation `analyze` reports: the two are not comparable."),
  warmth: z
    .number()
    .describe("Mean red minus mean blue in video-level Rec.709, -1 to 1: above 0 the picture leans warm (red), below 0 cool (blue). 3 decimals. Not `analyze`'s warmth (full-range RGB): do not compare the numbers."),
  tint: z.number().describe("Mean green minus the mean of red and blue, -1 to 1: above 0 the picture leans green, below 0 magenta. 3 decimals."),
});

/** One frame measured. */
export const GradeSampleSchema = z.object({
  at: z.number().describe("Timeline seconds of the frame, 3 decimals."),
  luma: z.number().describe("Its mean brightness, 0 to 1, 3 decimals."),
});

/** The correction `grade.analyze` suggests: numbers of `clip.set` `grade` that differ from neutral, absolute (they replace the clip's own: a field the clip sets and the source does not need comes back neutral), never a LUT. */
export const GradeSuggestionSchema = GradeSchema.omit({ lut: true, lutMix: true });

/** Result of `grade.analyze`. */
export const GradeAnalyzeResultSchema = z.object({
  timeline: z.string().describe("Timeline id."),
  clip: z.string().describe("The analyzed clip, as asked."),
  asset: z.string().describe("Project-relative source file measured."),
  mode: z.enum(["frame", "range"]).describe("`frame`: one frame (`at`, or a still). `range`: `frames` frames spread over `from` to `to`."),
  from: z.number().describe("Timeline seconds the measure starts (`at` in frame mode), 3 decimals."),
  to: z.number().describe("Timeline seconds the measure ends (`at` in frame mode), 3 decimals."),
  frames: z.int().min(1).describe("Frames measured."),
  samples: z.array(GradeSampleSchema).describe("One per frame measured, in time order: spots a clip whose exposure changes."),
  levels: GradeLevelsSchema,
  current: GradeSchema.nullable().describe("The clip's stored `grade`, as `timeline.show` reports it; null for none. The measure ignores it: it is of the source."),
  suggestion: GradeSuggestionSchema.describe(
    "Correction that moves the measured picture towards the targets, in the fields of `clip.set` `grade`; empty when the picture is within them and the clip has no correction of its own. " +
      "Absolute numbers for the source, so they replace the clip's own correction (a field it sets that the source does not need is given back as neutral: exposure 0, temperature 0, tint 0, contrast 1, saturation 1; its LUT stays). Bounded: at most 1 stop of exposure, 0.4 of white balance, contrast 0.8 to 1.25, saturation 0.85 to 1.2.",
  ),
  reasons: z.array(z.string()).describe("One line per suggested field, or why there is none."),
  flags: z.string().describe("`suggestion` as `clip set` flags, e.g. `--grade-exposure 0.4 --grade-contrast 1.1`; empty when there is no suggestion."),
  warnings: z.array(z.string()),
});

/** Result of `grade.analyze`. */
export type GradeAnalyzeResultShape = z.infer<typeof GradeAnalyzeResultSchema>;
