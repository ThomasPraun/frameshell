import { z } from "zod";
import { GRADE_LOOKS, GradeSchema, lookNames } from "@frameshell/schema";

// `grade.analyze` (ADR 0031): measured levels of a clip's picture and a bounded correction suggestion, never applied.

/** What kind of clip `grade.analyze` and `grade.compare` were asked about: footage or a photo, a generated clip (a plugin's render), a nested timeline (compare only). */
export const GradeClipKindSchema = z.enum(["media", "generated", "timeline"]);

/** Most frames one `grade.analyze` over a range measures. */
export const GRADE_ANALYZE_MAX_SAMPLES = 32;
/** Frames `grade.analyze` measures over a range when `samples` is not given. */
export const GRADE_ANALYZE_DEFAULT_SAMPLES = 8;

/** Levels of a picture, measured by ffmpeg `signalstats` on the clip's source before its grade (a generated clip's draft render). Every figure is the mean over the frames measured, except `min` and `max`. */
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
  asset: z.string().nullable().describe("Project-relative source file measured; null for a generated clip, which has none: its render is measured."),
  kind: GradeClipKindSchema.describe("`media` or `generated`: what the clip is. A generated clip's levels are of its draft render, the picture before its own grade."),
  mode: z.enum(["frame", "range"]).describe("`frame`: one frame (`at`, or a still). `range`: `frames` frames spread over `from` to `to`."),
  from: z.number().describe("Timeline seconds the measure starts (`at` in frame mode), 3 decimals."),
  to: z.number().describe("Timeline seconds the measure ends (`at` in frame mode), 3 decimals."),
  frames: z.int().min(1).describe("Frames measured."),
  samples: z.array(GradeSampleSchema).describe("One per frame measured, in time order: spots a clip whose exposure changes."),
  levels: GradeLevelsSchema,
  current: GradeSchema.nullable().describe("The clip's stored `grade`, as `timeline.show` reports it; null for none. The measure ignores it: it is of the source (the render, for a generated clip)."),
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

// `grade.compare` (ADR 0031): one frame of a clip under several looks next to a neutral baseline, as one image.

/** Most looks one `grade.compare` renders. */
export const GRADE_COMPARE_MAX_LOOKS = 16;
/** Tile width of a `grade.compare` sheet when none is given, px. */
export const GRADE_COMPARE_DEFAULT_TILE_WIDTH = 480;
/** Narrowest tile of a `grade.compare` sheet, px. */
export const GRADE_COMPARE_MIN_TILE_WIDTH = 160;
/** Widest tile of a `grade.compare` sheet, px: 18 tiles of a vertical film stay under about 5,000 px a side. */
export const GRADE_COMPARE_MAX_TILE_WIDTH = 960;
/** Longest look name, characters. */
export const GRADE_LOOK_NAME_MAX = 40;

/**
 * One candidate of `grade.compare`: a whole grade (the fields of `clip.set` `grade`) and the name its tile shows. `look`
 * names a built-in look ({@link GradeLooksResultSchema}) whose numbers it starts from; the fields given override them.
 */
export const GradeLookSchema = GradeSchema.extend({
  name: z
    .string()
    .trim()
    .min(1)
    .max(GRADE_LOOK_NAME_MAX)
    .optional()
    .describe(`Label of the tile, at most ${GRADE_LOOK_NAME_MAX} characters, e.g. \`warm\`. Default the built-in look's name (\`look\`), else \`look <n>\`.`),
  look: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(`A built-in look to start from (${lookNames.join(", ")}; \`grade.looks\` lists them with their numbers): its numbers fill the fields left out, the fields given win.`),
}).describe(
  "A whole grade drawn in place of the clip's own, not merged with it: fields left out are neutral (exposure 0, temperature 0, tint 0, contrast 1, saturation 1, no LUT), or the numbers of the built-in `look` when one is named.",
);

/** One built-in look of `grade.looks`. */
export const GradeBuiltInLookSchema = z.object({
  name: z.string().describe("The word to give `clip set --grade-look` and a `grade.compare` look's `look`, e.g. `warm`."),
  summary: z.string().describe("One line of what the look does to a picture."),
  grade: GradeSchema.describe("Every correction number the look sets, in the fields of `clip.set` `grade` (no LUT). A clip that takes the look keeps its own copy of them."),
});

/** Result of `grade.looks`. */
export const GradeLooksResultSchema = z.object({
  looks: z.array(GradeBuiltInLookSchema).describe(`The built-in looks (${GRADE_LOOKS.length}), in a fixed order.`),
});

/** Result of `grade.looks`. */
export type GradeLooksResultShape = z.infer<typeof GradeLooksResultSchema>;

/** One tile of a `grade.compare` sheet. */
export const GradeCompareTileSchema = z.object({
  label: z.string().describe("Text drawn on the tile: its number in reading order and its name, e.g. `3 warm`."),
  kind: z.enum(["neutral", "current", "look"]).describe("`neutral`: the clip with no grade. `current`: its stored grade. `look`: one of `looks`, in their order."),
  grade: GradeSchema.nullable().describe("The grade drawn, without the look's name; null for none."),
  flags: z
    .string()
    .describe(
      "`clip set` flags that give the clip this tile's grade: `--clear-grade` for `neutral`; for a look its fields plus the neutral value of each field the clip's grade sets and the look leaves out; empty when the clip has it already.",
    ),
});

/** Result of `grade.compare`. */
export const GradeCompareResultSchema = z.object({
  timeline: z.string().describe("Timeline id."),
  clip: z.string().describe("The compared clip."),
  asset: z.string().nullable().describe("Project-relative source file of a media clip; null for a generated or nested clip."),
  kind: GradeClipKindSchema.describe("`media`, `generated` (a plugin's render) or `timeline` (a nested timeline)."),
  frame: z.int().describe("Timeline frame rendered."),
  at: z.number().describe("Start of that frame, timeline seconds, 3 decimals."),
  path: z.string().describe("Absolute path of the PNG written."),
  width: z.int().describe("Width of the image, px."),
  height: z.int().describe("Height of the image, px."),
  columns: z.int().describe("Tiles per row."),
  rows: z.int().describe("Rows of tiles."),
  tiles: z.array(GradeCompareTileSchema).describe("In reading order: left to right, then top to bottom."),
  warnings: z.array(z.string()),
});

/** Result of `grade.compare`. */
export type GradeCompareResultShape = z.infer<typeof GradeCompareResultSchema>;
/** One look of `grade.compare`. */
export type GradeLook = z.infer<typeof GradeLookSchema>;
