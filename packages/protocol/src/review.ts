import { z } from "zod";
import { type TimelineViewName, ViewedShape } from "./proposals.js";

// `review` (#457, epic #451): contact sheets and strips an agent looks at before it shows the person anything.

/** The sheets `review` can write, in the order it writes them. */
export const REVIEW_SHEETS = ["contact", "phone", "motion", "seam"] as const;

/** Name of a sheet in {@link REVIEW_SHEETS}. */
export const ReviewSheetKindSchema = z
  .enum(REVIEW_SHEETS)
  .describe(
    "`contact`: frames at critical times (clip starts and ends, cuts, markers, subtitle cues, the deepest zoom) and every `every` seconds. " +
      "`phone`: one frame per second, 360 px wide. `motion`: the two fastest moments as 12 consecutive frames each. " +
      "`seam`: the last 6 and the first 6 frames, to judge a loop.",
  );

/** Name of a sheet in {@link REVIEW_SHEETS}. */
export type ReviewSheetKind = z.output<typeof ReviewSheetKindSchema>;

/** Why a tile of a sheet shows the frame it does. */
export const REVIEW_TAGS = ["start", "end", "cut", "marker", "cue", "zoom", "grid", "second", "peak", "head", "tail"] as const;

/** Review runs `.frameshell/review/` keeps: older numbered folders are deleted by the next run. */
export const REVIEW_KEEP = 10;

/** One tile of a sheet, left to right then top to bottom. */
export const ReviewTileSchema = z.object({
  at: z.number().describe("Seconds of the frame shown (timeline seconds, or file seconds when reviewing a file)."),
  frame: z.int().describe("Frame index (0-based) at the timeline's or the file's frame rate."),
  tag: z.enum(REVIEW_TAGS).describe("Why this frame: a clip `start`/`end`, a `cut`, a `marker`, a subtitle `cue`, the deepest `zoom`, the `grid`, a `second` of the phone sheet, a motion `peak`, or the `head`/`tail` of a loop seam."),
  label: z.string().describe("Text drawn on the tile: the time in seconds and, for all but the grid, the tag."),
  row: z.int().describe("0-based."),
  column: z.int().describe("0-based."),
});

/** One image `review` wrote. */
export const ReviewSheetSchema = z.object({
  kind: ReviewSheetKindSchema,
  path: z.string().describe("Absolute path of the PNG."),
  width: z.int(),
  height: z.int(),
  columns: z.int(),
  rows: z.int(),
  tile: z.object({ width: z.int(), height: z.int() }).describe("Size of one tile in the image, px."),
  tiles: z.array(ReviewTileSchema).describe("In reading order."),
});

/** One image `review` wrote. */
export type ReviewSheet = z.output<typeof ReviewSheetSchema>;

/** A fast moment of the picture. */
export const ReviewPeakSchema = z.object({
  at: z.number().describe("Seconds of the middle of the change."),
  energy: z.number().describe("Mean absolute difference of two grey frames at 320 px wide, 0 to 255: how much of the picture moved."),
  strip: z.string().nullable().describe("The `motion` sheet that shows it (absolute path); null for the peaks below the top two."),
});

/** A fast moment of the picture. */
export type ReviewPeak = z.output<typeof ReviewPeakSchema>;

/** What `review` wrote. */
export interface ReviewResultShape {
  /** Which timeline the result shows. */
  view: TimelineViewName;
  /** The project's open proposal; null when none. */
  proposal: { tx: string; state: "building" | "ready" } | null;
  source: "timeline" | "file";
  /** Timeline reviewed; null for a file. */
  timeline: string | null;
  /** Absolute path of the file reviewed; null for a timeline. */
  file: string | null;
  /** `<n>` of the folder. */
  run: number;
  /** Absolute folder the sheets and `review.json` (this result without `view` and `proposal`) are in. */
  dir: string;
  /** Seconds reviewed. */
  range: { from: number; to: number };
  /** Frame rate of the film. */
  fps: number;
  /** Size of the film's frames, px. */
  width: number;
  height: number;
  /** Every image written, in order; a kind with many tiles is split into several images. */
  sheets: ReviewSheet[];
  /** The fastest moments, fastest first (up to 5); empty without the `motion` sheet or when nothing moves. */
  peaks: ReviewPeak[];
  /** What could not be shown (a seam on a one-frame film, nothing moving…); empty when none. */
  warnings: string[];
}

/**
 * What `review` wrote. Typed by hand: inferred inside the `methods` registry it is too long for TypeScript to print
 * (TS7056), as the registry has grown.
 */
export const ReviewResultSchema: z.ZodType<ReviewResultShape> = z.object({
  ...ViewedShape,
  source: z.enum(["timeline", "file"]),
  timeline: z.string().nullable().describe("Timeline reviewed; null for a file."),
  file: z.string().nullable().describe("Absolute path of the file reviewed; null for a timeline."),
  run: z.int().describe("`<n>` of the folder."),
  dir: z.string().describe("Absolute folder the sheets and `review.json` (this result without `view` and `proposal`) are in."),
  range: z.object({ from: z.number(), to: z.number() }).describe("Seconds reviewed."),
  fps: z.number().describe("Frame rate of the film."),
  width: z.int().describe("Size of the film's frames, px."),
  height: z.int(),
  sheets: z.array(ReviewSheetSchema).describe("Every image written, in order; a kind with many tiles is split into several images."),
  peaks: z.array(ReviewPeakSchema).describe("The fastest moments, fastest first (up to 5); empty without the `motion` sheet or when nothing moves."),
  warnings: z.array(z.string()).describe("What could not be shown (a seam on a one-frame film, nothing moving…); empty when none."),
});
