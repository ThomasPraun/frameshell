import { z } from "zod";
import { SCHEMA_VERSION, type ParseResult, formatIssues } from "./common.js";

/** Canonical `$schema` URL for a project's `requirements.json`. */
export const REQUIREMENTS_SCHEMA_URL = `https://frameshell.dev/schema/v${SCHEMA_VERSION}/requirements.json`;

/** Project-relative path of the file where the person states what the film must be (checked by `review`, #457). */
export const REQUIREMENTS_FILE = "requirements.json";

/** The craft checks `review` can raise a warning for (`metrics.craft`); `fail` and `waivers` name them. */
export const CRAFT_CHECKS = [
  "static",
  "frame-0",
  "blank",
  "reading",
  "peak",
  "phone-band",
  "silent",
  "sync",
  "loop-seam",
  "delivery",
  "safe-zone",
  "voice-bed",
  "sfx-repeat",
  "machine-gun",
  "chopped",
  "ending",
  "click",
  "masking",
  "edge-click",
  "harsh",
  "behind",
] as const;

/** One of {@link CRAFT_CHECKS}. */
export type CraftCheck = (typeof CRAFT_CHECKS)[number];

const CraftCheckSchema = z.enum(CRAFT_CHECKS);
const Seconds = (what: string) => z.number().positive().describe(`${what} Seconds.`);
const ClipId = z.string().min(1).describe("Clip id from `timeline.show`, e.g. `c_1a2b3c`.");

/** What the whole film must be. Every field is optional: only what is written is checked. */
export const FilmRequirementsSchema = z.strictObject({
  maxSeconds: Seconds("The film is at most this long.").optional(),
  minSeconds: Seconds("The film is at least this long.").optional(),
  maxStatic: Seconds("The picture never holds still for longer than this (`review` measures the whole frame, at most 90 samples of a timeline).").optional(),
  endCard: z
    .strictObject({ minSeconds: Seconds("The film ends on a picture that holds still (and is not blank) for at least this long.") })
    .optional()
    .describe("The film ends on a held card, measured on the last stretch of the range reviewed; skipped when the range stops short of the end."),
  loudness: z
    .strictObject({
      target: z.number().min(-70).max(0).optional().describe("Integrated loudness the file should have, LUFS (e.g. -14)."),
      tolerance: z.number().positive().max(12).default(1.5).describe("LU the file may be off `target` (default 1.5, the delivery check's)."),
      maxTruePeak: z.number().min(-20).max(3).optional().describe("The file's true peak stays at or under this, dBTP (e.g. -1)."),
    })
    .optional()
    .describe("Measured on an exported file (`review --file`), after the encode; a timeline has no loudness, so these are skipped for one."),
});

/** What the captions must be. */
export const CaptionRequirementsSchema = z.strictObject({
  minSize: z
    .number()
    .min(0.005)
    .max(0.2)
    .describe("Smallest caption text, as a share of the film's short side (0.026 is 28 px at 1080). Read from the subtitle tracks of a timeline."),
});

/** What one clip of the timeline must do. */
export const ClipRequirementSchema = z.strictObject({
  clip: ClipId,
  appearsBy: z
    .union([z.number().nonnegative(), z.string().min(1)])
    .optional()
    .describe("The clip starts at or before this time: seconds, or a marker id or label (optionally `hook+0.5`), as `marker.list` shows them."),
  before: ClipId.optional().describe("The clip starts before this other clip starts."),
  keepsMoving: z
    .strictObject({ maxStatic: Seconds("The picture does not hold still for longer than this while the clip plays (the whole frame, so a clip under another moving one passes).") })
    .optional(),
  staysInFrame: z
    .union([
      z.literal(true),
      z.strictObject({
        margin: z
          .number()
          .min(0)
          .max(0.25)
          .optional()
          .describe("Keep this share of the frame clear on every side: 0.05 is 5 % of the width left and right and of the height top and bottom. Default 0: only touching or crossing an edge fails."),
      }),
    ])
    .optional()
    .describe(
      "What the clip draws never leaves the film's frame while it plays, in the format reviewed (after its cover crop; inside the letterbox bars when the timeline has some): " +
        "a generated clip's alpha (a render with an alpha plane), a footage clip's faces (a cached `people scan`). `true`, or `{ margin }`. " +
        "A generated clip's alpha is read 160 px wide at up to 12 frames (4 a second): an element within about 1/160 of the width of an edge counts as touching it, " +
        "and an exit shorter than the gap between those frames can pass unseen.",
    ),
});

/** `staysInFrame` of a clip requirement as the margin it keeps: 0 for `true`. */
export function staysInFrameMargin(value: ClipRequirement["staysInFrame"]): number | null {
  if (value === undefined) return null;
  return value === true ? 0 : (value.margin ?? 0);
}

/** One entry of `clips` in `requirements.json`. */
export type ClipRequirement = z.output<typeof ClipRequirementSchema>;

/**
 * `clips` with one entry per clip, in the order the clips first appear: a clip's repeated entries merged, later
 * fields winning. How `review` judges them and how the `requirements` config document keys them.
 */
export function clipRequirements(clips: readonly ClipRequirement[]): ClipRequirement[] {
  const byClip = new Map<string, ClipRequirement>();
  for (const entry of clips) {
    const fields = Object.fromEntries(Object.entries(entry).filter(([, value]) => value !== undefined));
    byClip.set(entry.clip, { ...byClip.get(entry.clip), ...fields } as ClipRequirement);
  }
  return [...byClip.values()];
}

/** A craft warning the person accepts, with why. A waived warning is still reported (`metrics.waived`), never dropped. */
export const WaiverSchema = z.strictObject({
  check: CraftCheckSchema.describe("The craft check to waive, as `metrics.craft` names it (`static`, `reading`, `safe-zone`...)."),
  clip: ClipId.optional().describe(
    "Waive only warnings whose time overlaps this clip; a warning about one clip (`behind`: the word's clip) only when it is this clip. Absent: every warning of the check, including those about the whole film.",
  ),
  reason: z.string().trim().min(1).describe("Why the warning is accepted: shown beside the waived warning."),
});

/**
 * Zod model of `requirements.json` (#457): the expectations of the film that `review` checks and the craft
 * warnings that are failures here or accepted. Craft warnings are warnings unless `fail` names their check; a
 * failing one is lifted by a waiver. An assertion that does not hold is a failure. Written through the config journal
 * (ADR 0036): `review.require`, `review.waive`, a journaled `file.write` or a hand edit; `review` never changes it.
 */
export const RequirementsFileSchema = z.strictObject({
  $schema: z.string().optional(),
  schemaVersion: z.literal(SCHEMA_VERSION),
  film: FilmRequirementsSchema.default({}),
  captions: CaptionRequirementsSchema.optional(),
  clips: z.array(ClipRequirementSchema).default([]).describe("Per-clip expectations, checked on a timeline."),
  fail: z.array(CraftCheckSchema).default([]).describe("Craft checks that are failures in this project: their warnings count in `requirements.failed` and make `frameshell review` exit 1, unless waived."),
  waivers: z.array(WaiverSchema).default([]),
});

/**
 * What `review.require` sets without a clip, one value each: the fields of `film`, the caption size and the `fail`
 * list. Each is one key of the `requirements` config document (ADR 0036).
 */
export const REQUIREMENT_PATHS = ["film.maxSeconds", "film.minSeconds", "film.maxStatic", "film.endCard", "film.loudness", "captions.minSize", "fail"] as const;

/** What `review.require` sets for one clip: the assertions of a `clips` entry, one key each. */
export const CLIP_REQUIREMENT_FIELDS = ["appearsBy", "before", "keepsMoving", "staysInFrame"] as const;

/** Validated `requirements.json`. */
export type RequirementsFile = z.output<typeof RequirementsFileSchema>;

/** Validate unknown input as a requirements file. Never throws. */
export function parseRequirementsFile(input: unknown): ParseResult<RequirementsFile> {
  const result = RequirementsFileSchema.safeParse(input);
  return result.success ? { ok: true, value: result.data } : { ok: false, error: formatIssues(result.error) };
}
