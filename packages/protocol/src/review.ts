import { SafeZoneSchema } from "@frameshell/schema";
import { z } from "zod";
import { type TimelineViewName, ViewedShape } from "./proposals.js";

// `review` (#457, epic #451): contact sheets and strips an agent looks at before it shows the person anything.

/** The sheets `review` can write, in the order it writes them. */
export const REVIEW_SHEETS = ["contact", "safe", "phone", "motion", "seam"] as const;

/** Name of a sheet in {@link REVIEW_SHEETS}. */
export const ReviewSheetKindSchema = z
  .enum(REVIEW_SHEETS)
  .describe(
    "`contact`: frames at critical times (clip starts and ends, cuts, markers, subtitle cues, the deepest zoom) and every `every` seconds. " +
      "`safe`: the same kind of frames (up to 36) with the platform's UI zones shaded red and a `!subtitle` mark on the frames where a caption crosses one; needs a `platform` (or the style guide's). " +
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
  flags: z
    .array(z.string())
    .optional()
    .describe("`safe` sheet: what crosses a platform zone in this frame (`subtitle`), also marked on the tile as `!subtitle`. Absent: nothing review can measure does."),
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

/** Edge of the frame a platform's UI covers. */
export const ZONE_EDGES = ["top", "right", "bottom", "left"] as const;

/** One of {@link ZONE_EDGES}. */
export type ZoneEdge = (typeof ZONE_EDGES)[number];

/** Text or a subject that crosses a platform zone, as far as review can measure it. */
export const ReviewSafeFlagSchema = z.object({
  subject: z.literal("subtitle").describe("What crosses: the captions of a subtitle track (box measured from the bundled face, the track's style and each cue's words)."),
  track: z.string().describe("Subtitle track id."),
  zone: z.enum(ZONE_EDGES).describe("Which zone the captions reach into."),
  cues: z.int().describe("How many cues reach into it."),
  first: z.number().describe("Seconds the first of them starts."),
  last: z.number().describe("Seconds the last of them starts."),
  reach: z.int().describe("Most pixels (of the film's frame) any of them reaches into the zone."),
});

/** See {@link ReviewSafeFlagSchema}. */
export type ReviewSafeFlag = z.output<typeof ReviewSafeFlagSchema>;

/** The safe zones of one platform as drawn on the `safe` sheet, with what crosses them. */
export const ReviewSafeZoneSchema = z.object({
  platform: SafeZoneSchema.shape.platform,
  measured: z.boolean().describe("The platform's numbers were measured on its app; false: taken from editing guides."),
  source: z.string().describe("Where the numbers come from."),
  insets: z
    .object({ top: z.int(), right: z.int(), bottom: z.int(), left: z.int() })
    .describe("Pixels of the film's frame each edge's zone covers (the platform's reference numbers scaled to the film's size)."),
  sheets: z.array(z.string()).describe("Absolute paths of the `safe` images of this platform."),
  flags: z.array(ReviewSafeFlagSchema).describe("Captions that cross a zone, by track and zone; empty when none do. Only the timeline's captions are known: a file has no flags."),
});

/** See {@link ReviewSafeZoneSchema}. */
export type ReviewSafeZone = z.output<typeof ReviewSafeZoneSchema>;

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
  /** One entry per platform of the `safe` sheet; empty without it. */
  safeZones: ReviewSafeZone[];
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
  safeZones: z.array(ReviewSafeZoneSchema).describe("One entry per platform of the `safe` sheet: its zones in the film's pixels and the captions that cross them; empty without the sheet."),
  warnings: z.array(z.string()).describe("What could not be shown (a seam on a one-frame film, nothing moving…); empty when none."),
});
