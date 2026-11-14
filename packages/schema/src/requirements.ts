import { z } from "zod";
import { SCHEMA_VERSION, type ParseResult, formatIssues } from "./common.js";

/** Canonical `$schema` URL for a project's `requirements.json`. */
export const REQUIREMENTS_SCHEMA_URL = `https://frameshell.dev/schema/v${SCHEMA_VERSION}/requirements.json`;

/** Project-relative path of the file where the person states what the film must be (checked by `review`, #457). */
export const REQUIREMENTS_FILE = "requirements.json";

/** The craft checks `review` can raise a warning for (`metrics.craft`); `fail` and `waivers` name them. */
export const CRAFT_CHECKS = ["static", "frame-0", "blank", "reading", "peak", "phone-band", "silent", "sync", "loop-seam", "delivery", "safe-zone"] as const;

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
});

/** A craft warning the person accepts, with why. A waived warning is still reported (`metrics.waived`), never dropped. */
export const WaiverSchema = z.strictObject({
  check: CraftCheckSchema.describe("The craft check to waive, as `metrics.craft` names it (`static`, `reading`, `safe-zone`...)."),
  clip: ClipId.optional().describe("Waive only warnings whose time overlaps this clip. Absent: every warning of the check, including those about the whole film."),
  reason: z.string().trim().min(1).describe("Why the warning is accepted: shown beside the waived warning."),
});

/**
 * Zod model of `requirements.json` (#457): the expectations of the film that `review` checks and the craft
 * warnings that are failures here or accepted. Craft warnings are warnings unless `fail` names their check; a
 * failing one is lifted by a waiver. An assertion that does not hold is a failure. Hand- or agent-written with
 * `file.write`; `review` never changes it.
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

/** Validated `requirements.json`. */
export type RequirementsFile = z.output<typeof RequirementsFileSchema>;

/** Validate unknown input as a requirements file. Never throws. */
export function parseRequirementsFile(input: unknown): ParseResult<RequirementsFile> {
  const result = RequirementsFileSchema.safeParse(input);
  return result.success ? { ok: true, value: result.data } : { ok: false, error: formatIssues(result.error) };
}
