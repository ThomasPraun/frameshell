import { CRAFT_CHECKS, SafeZoneSchema } from "@frameshell/schema";
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

/** What a run can be asked for: the sheets, and `metrics.json`. */
export const REVIEW_OUTPUTS = [...REVIEW_SHEETS, "metrics"] as const;

/** Name in {@link REVIEW_OUTPUTS}. */
export const ReviewOutputSchema = z
  .enum(REVIEW_OUTPUTS)
  .describe(
    `${ReviewSheetKindSchema.description} ` +
      "`metrics`: numbers instead of pictures, written to `metrics.json` and returned as `metrics`: the longest still stretch, the largest gap between visual events, near-blank frames, " +
      "whether frame 0 is empty, subtitle cues shorter than they take to read, the loudness of a file (integrated LUFS, loudness range, true peak, phone band 200 Hz to 6 kHz), " +
      "sounds against the picture events they belong to (`sync`), the jump from the last frame to the first (`seam`), a file against its export plan (`delivery`) and craft warnings.",
  );

/** Name in {@link REVIEW_OUTPUTS}. */
export type ReviewOutput = z.output<typeof ReviewOutputSchema>;

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

/** What `review` can tell crosses a platform zone. */
export const SAFE_SUBJECTS = ["subtitle", "graphic", "face"] as const;

/** Text or a subject that crosses a platform zone, as far as review can measure it. */
export const ReviewSafeFlagSchema = z.object({
  subject: z
    .enum(SAFE_SUBJECTS)
    .describe(
      "What crosses: `subtitle`, the captions of a subtitle track (box measured from the bundled face, the track's style and each cue's words); " +
        "`graphic`, what a generated clip draws (titles included: the box of its alpha at up to 12 frames of the clip, so a render without alpha is not measured); " +
        "`face`, a face box of a footage clip from its cached `people scan` (no scan, no flag).",
    ),
  track: z.string().describe("Subtitle track id; for a `graphic` or a `face`, the video track of the clip."),
  clip: z.string().optional().describe("Clip id of a `graphic` or a `face`."),
  zone: z.enum(ZONE_EDGES).describe("Which zone it reaches into."),
  cues: z.int().describe("How many cues (`subtitle`) or measured samples (`graphic`, `face`) reach into it."),
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
  flags: z.array(ReviewSafeFlagSchema).describe("Captions, graphics and faces that cross a zone, by subject, track, clip and zone; empty when none do. Only a timeline's are known: a file has no flags."),
});

/** See {@link ReviewSafeZoneSchema}. */
export type ReviewSafeZone = z.output<typeof ReviewSafeZoneSchema>;

/** A stretch of the film, seconds. */
export const ReviewSpanSchema = z.object({ from: z.number(), to: z.number(), seconds: z.number().describe("`to` minus `from`.") });

/** A stretch of the film, seconds. */
export type ReviewSpan = z.output<typeof ReviewSpanSchema>;

/** Checks that raise a craft warning in `metrics.craft`. */
export const REVIEW_CHECKS = CRAFT_CHECKS;

/** A craft warning: a thing a reviewer would flag, with a number behind it. Only `requirements.json` can make one a failure. */
export const ReviewCraftWarningSchema = z.object({
  check: z
    .enum(REVIEW_CHECKS)
    .describe(
      "`static`: nothing changes for over 3 s. `frame-0`: the first frame is empty (it is the thumbnail). `blank`: a near-blank picture after the first frame. " +
        "`reading`: a subtitle cue is on screen for less than it takes to read. `peak`: the true peak is above -1 dBTP. `phone-band`: the phone band is 6 LU or more under the whole mix. `silent`: over 15 s with no sound. " +
        "`sync`: a sound lands early or late against its picture event, or the sounds sit no nearer picture events than chance. `loop-seam`: with `loop`, the last frame repeats the first or jumps from it. " +
        "`delivery`: the file differs from the export plan. `safe-zone`: a graphic or a face reaches into a platform zone.",
    ),
  from: z.number().nullable().describe("Seconds the thing starts; null when it is about the whole film."),
  to: z.number().nullable(),
  message: z.string(),
  severity: z
    .enum(["warn", "fail"])
    .describe("`warn` unless the project's `requirements.json` lists the check in `fail` and no waiver covers the warning: then `fail`, and it counts in `requirements.failed`."),
});

/** See {@link ReviewCraftWarningSchema}. */
export type ReviewCraftWarning = z.output<typeof ReviewCraftWarningSchema>;

/** A subtitle cue on screen for less time than its words take to read. */
export const ReviewShortCueSchema = z.object({
  track: z.string().describe("Subtitle track id."),
  from: z.number().describe("Seconds the cue appears."),
  to: z.number().describe("Seconds it goes."),
  words: z.int(),
  floor: z.number().describe("Least seconds for that many words: 0.4 for one or two, else 0.75 x (0.5 + 0.3 per word)."),
});

/** See {@link ReviewShortCueSchema}. */
export type ReviewShortCue = z.output<typeof ReviewShortCueSchema>;

/** Loudness of a file's sound, measured on the decoded file (after any AAC encode), over the whole file whatever the range. */
export const ReviewLoudnessSchema = z.object({
  integrated: z.number().nullable().describe("Integrated loudness, LUFS; null for silence."),
  range: z.number().nullable().describe("Loudness range, LU; null for silence."),
  truePeak: z.number().nullable().describe("True peak, dBTP; null for digital silence."),
  phoneBand: z.number().nullable().describe("Integrated loudness of the 200 Hz to 6 kHz band, LUFS: what a phone speaker plays. Null for silence."),
});

/** See {@link ReviewLoudnessSchema}. */
export type ReviewLoudness = z.output<typeof ReviewLoudnessSchema>;

/** One sound of the sync check against the picture event it belongs to. */
export const ReviewSyncOffsetSchema = z.object({
  at: z.number().describe("Seconds the sound starts (its onset or, for a generated take, its anchor)."),
  kind: z.string().nullable().describe("Generated effect kind (`click`, `pop`, `thump`...); null for a hit found in a file's sound."),
  picture: z.number().nullable().describe("Seconds of the nearest visual event within 0.12 s; null when there is none."),
  offset: z.number().nullable().describe("Sound minus picture, seconds: positive = the sound is late. Null with no picture event."),
  verdict: z.enum(["on", "early", "late", "none"]).describe("`early`: over 45 ms before the picture; `late`: over 75 ms after it; `none`: no picture event near."),
});

/** Sync of sounds to picture events. */
export const ReviewSyncSchema = z.object({
  source: z.enum(["takes", "file"]).describe("`takes`: generated sounds placed on the timeline (`sound.place`), known to the frame; `file`: hits found in the file's sound."),
  sounds: z.int().describe("Sounds scored."),
  excluded: z.int().describe("Sounds left out: whooshes, risers and ticks do not land on an event by design."),
  spacing: z.number().describe("Seconds between the samples of the picture: the finest offset that can be told."),
  hits: z.int().describe("Scored sounds within 45 ms (plus half a sample) of a visual event."),
  near: z.number().nullable().describe("Share of the scored sounds with a visual event within 0.1 s; null with no sounds."),
  chance: z.number().nullable().describe("The same share when the sounds are moved by fixed offsets (0.3 to 1.1 s either way): what random placement scores. Null with no sounds."),
  offsets: z.array(ReviewSyncOffsetSchema).describe("Every scored sound (at most 60, in time order)."),
  silentCuts: z.array(z.number()).describe("Seconds of cuts of the timeline with no sound within 0.12 s (at most 20); empty for a file."),
});

/** See {@link ReviewSyncSchema}. */
export type ReviewSync = z.output<typeof ReviewSyncSchema>;

/** The seam of a loop: how far the last frame is from the first. */
export const ReviewSeamSchema = z.object({
  first: z.number().describe("Seconds of the first frame compared."),
  last: z.number().describe("Seconds of the last frame compared."),
  jump: z.number().describe("Mean absolute grey difference between them at 160 px, 0 to 255 (the measure of the render's loop check): a hard cut reads 40 to 80."),
  verdict: z
    .enum(["duplicate", "continuous", "cut"])
    .describe("`duplicate`: under 0.5 while the picture moves elsewhere, so the loop holds two frames; `continuous`: under 10; `cut`: 10 or more, a visible jump."),
});

/** See {@link ReviewSeamSchema}. */
export type ReviewSeam = z.output<typeof ReviewSeamSchema>;

/** One thing the delivery check compared. */
export const ReviewDeliveryCheckSchema = z.object({
  field: z.enum(["width", "height", "fps", "duration", "codec", "audio", "loudness"]),
  expected: z.union([z.string(), z.number()]).describe("What the export plan says."),
  actual: z.union([z.string(), z.number()]).nullable().describe("What the file has; null when it has none."),
  ok: z.boolean(),
});

/** An exported file against the export plan. */
export const ReviewDeliverySchema = z.object({
  timeline: z.string(),
  preset: z.string(),
  format: z.string(),
  bytes: z.int().describe("Size of the file."),
  checks: z.array(ReviewDeliveryCheckSchema),
});

/** See {@link ReviewDeliverySchema}. */
export type ReviewDelivery = z.output<typeof ReviewDeliverySchema>;

/** What a check finds, before `requirements.json` sets its severity. */
export type ReviewFinding = Omit<ReviewCraftWarning, "severity">;

/** A craft warning a waiver of `requirements.json` covers: kept in the report with the reason, out of `craft`. */
export const ReviewWaivedWarningSchema = ReviewCraftWarningSchema.omit({ severity: true }).extend({
  reason: z.string().describe("The waiver's reason."),
  clip: z.string().optional().describe("The clip the waiver names; absent for a waiver of the whole check."),
});

/** See {@link ReviewWaivedWarningSchema}. */
export type ReviewWaivedWarning = z.output<typeof ReviewWaivedWarningSchema>;

/** One expectation of `requirements.json` against the film. */
export const ReviewRequirementCheckSchema = z.object({
  id: z
    .string()
    .describe(
      "What was checked: `film.maxSeconds`, `film.minSeconds`, `film.maxStatic`, `film.endCard`, `film.loudness.target`, `film.loudness.maxTruePeak`, `captions.minSize`, " +
        "`clip.appearsBy`, `clip.before` or `clip.keepsMoving`.",
    ),
  clip: z.string().optional().describe("The clip a `clip.*` check is about."),
  status: z.enum(["pass", "fail", "skipped"]).describe("`skipped`: it cannot be measured on this review (a file has no clips, a timeline has no loudness, the range stops short of the end...); the message says why."),
  expected: z.union([z.string(), z.number()]).describe("What the file asks for."),
  actual: z.union([z.string(), z.number()]).nullable().describe("What the review measured; null when skipped."),
  message: z.string(),
});

/** See {@link ReviewRequirementCheckSchema}. */
export type ReviewRequirementCheck = z.output<typeof ReviewRequirementCheckSchema>;

/** A waiver of `requirements.json` and how many warnings it covered in this run. */
export const ReviewWaiverUseSchema = z.object({
  check: z.enum(REVIEW_CHECKS),
  clip: z.string().optional(),
  reason: z.string(),
  matched: z.int().describe("Warnings of this run it covers; 0: it is not needed (any more) or names a clip this review cannot place."),
});

/** `requirements.json` judged against a run. */
export const ReviewRequirementsSchema = z.object({
  file: z.string().describe("Project-relative path of the file."),
  checks: z.array(ReviewRequirementCheckSchema),
  waivers: z.array(ReviewWaiverUseSchema),
  failed: z.int().describe("Checks that failed plus craft warnings of severity `fail`: non-zero makes `frameshell review` exit 1."),
});

/** See {@link ReviewRequirementsSchema}. */
export type ReviewRequirements = z.output<typeof ReviewRequirementsSchema>;

/** The numbers of a run: what a picture sheet cannot tell. Measured on the film's grey frames (draft size) and its sound. */
export const ReviewMetricsSchema = z.object({
  picture: z.object({
    samples: z.int().describe("Frames the picture was measured on: a file at up to 15 a second, a timeline at most 90 over the range, so a short flash between two samples can be missed."),
    spacing: z.number().describe("Seconds between samples."),
    longestStatic: ReviewSpanSchema.nullable().describe("The longest stretch where the picture changes by less than 0.35 grey levels between samples; null when nothing is still."),
    staticRuns: z.array(ReviewSpanSchema).describe("Every still stretch over 3 s."),
    events: z.int().describe("Visual events: peaks of change above the larger of 1 grey level and 2.5 times the median change."),
    largestGap: ReviewSpanSchema.nullable().describe("The largest gap between visual events, the start and the end of the range counted as ends; null for one sample."),
    blank: z.array(ReviewSpanSchema).describe("Stretches of near-blank pictures (luma standard deviation under 4 grey levels), from the first to the last such sample."),
    firstFrameEmpty: z.boolean().nullable().describe("Frame 0 is near-blank; null when the range does not start at 0."),
  }),
  subtitles: z
    .object({ cues: z.int(), shortCues: z.array(ReviewShortCueSchema) })
    .nullable()
    .describe("Cues of the timeline's subtitle tracks; null for a file or a timeline with none."),
  loudness: ReviewLoudnessSchema.nullable().describe("Of a file's sound; null for a timeline (export it, then review the file) or a file with no sound."),
  sync: ReviewSyncSchema.nullable().describe("Sounds against the picture events they belong to, with what random placement would score; null when there are no sounds to compare."),
  seam: ReviewSeamSchema.nullable().describe("Last frame against the first; null for a film of one frame."),
  delivery: ReviewDeliverySchema.nullable().describe("The file against the export plan; null unless a `file` is reviewed with a `preset`."),
  craft: z.array(ReviewCraftWarningSchema).describe("Things to fix or defend, in film order, waived ones left out; empty when none."),
  waived: z.array(ReviewWaivedWarningSchema).describe("Craft warnings a waiver of `requirements.json` covers, with its reason: accepted, not gone; empty when none."),
  requirements: ReviewRequirementsSchema.nullable().describe("`requirements.json` judged: its checks, its waivers and what failed; null when the project has none."),
});

/** See {@link ReviewMetricsSchema}. */
export type ReviewMetrics = z.output<typeof ReviewMetricsSchema>;

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
  /** Absolute folder the sheets, `metrics.json` and `review.json` (this result without `view`, `proposal` and `metrics`) are in. */
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
  /** The numbers, also written to `metrics.json` in `dir`; null when `metrics` is not among the outputs asked for. */
  metrics: ReviewMetrics | null;
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
  dir: z.string().describe("Absolute folder the sheets, `metrics.json` and `review.json` (this result without `view`, `proposal` and `metrics`) are in."),
  range: z.object({ from: z.number(), to: z.number() }).describe("Seconds reviewed."),
  fps: z.number().describe("Frame rate of the film."),
  width: z.int().describe("Size of the film's frames, px."),
  height: z.int(),
  sheets: z.array(ReviewSheetSchema).describe("Every image written, in order; a kind with many tiles is split into several images."),
  peaks: z.array(ReviewPeakSchema).describe("The fastest moments, fastest first (up to 5); empty without the `motion` sheet or when nothing moves."),
  safeZones: z.array(ReviewSafeZoneSchema).describe("One entry per platform of the `safe` sheet: its zones in the film's pixels and the captions that cross them; empty without the sheet."),
  metrics: ReviewMetricsSchema.nullable().describe("The numbers, also written to `metrics.json` in `dir`; null when `metrics` is not among the outputs asked for."),
  warnings: z.array(z.string()).describe("What could not be shown (a seam on a one-frame film, nothing moving…); empty when none."),
});
