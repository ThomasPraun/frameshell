import { z } from "zod";

/** Seconds of silence between two words that `cleanup` takes as a pause when `pauses` is not given. */
export const CLEANUP_PAUSES_DEFAULT_S = 0.4;
/** Seconds of silence `cleanup` leaves on each side of a cut when `breath` is not given. */
export const CLEANUP_BREATH_DEFAULT_S = 0.1;
/** Candidates below this confidence are not proposed or applied unless `minConfidence` says otherwise. */
export const CLEANUP_MIN_CONFIDENCE_DEFAULT = 0.5;

/** Why `cleanup` proposes a cut. */
export const CLEANUP_KINDS = ["pause", "retake"] as const;

/** One cut `cleanup` proposes (and, unless `dryRun`, makes). */
export const CleanupCandidateSchema = z.object({
  id: z.string().describe("`p<n>` (pause) or `r<n>` (retake), numbered in timeline order. Stable while the timeline and the options stay the same; pass it in `skip`."),
  kind: z.enum(CLEANUP_KINDS).describe("`pause`: dead air between two kept words. `retake`: an earlier attempt of a phrase the speaker said again."),
  start: z.number().describe("Timeline seconds where the cut starts, on the frame grid."),
  end: z.number().describe("Timeline seconds where the cut ends, on the frame grid. The cut removes [start, end)."),
  duration: z.number().describe("Seconds removed (`end - start`)."),
  words: z
    .array(z.object({ id: z.string(), text: z.string() }))
    .describe("Transcript words the cut removes, in order (text as corrected by the person). Empty for a `pause`."),
  transcript: z.string().nullable().describe("Project-relative transcript file the `words` ids belong to; null when `words` is empty."),
  reason: z.string().describe("One sentence the person can read in a table, e.g. `0.8 s of silence between “hola” and “todos”`."),
  confidence: z.number().describe("0 (a guess) to 1 (sure). A pause: the share of the gap between the words that the audio shows quiet. A retake: grows with the phrase length."),
  clean: z.boolean().describe("Both edges lie inside quiet audio. False: an edge found no pause and may clip speech; look at it before applying."),
});

/** See {@link CleanupCandidateSchema}. */
export type CleanupCandidate = z.output<typeof CleanupCandidateSchema>;

/** A place `cleanup` looked at and left alone. */
export const CleanupSkippedSchema = z.object({
  kind: z.enum(CLEANUP_KINDS),
  at: z.number().describe("Timeline seconds of the first word involved."),
  reason: z.string(),
});

/** Result of `cleanup`. */
export const CleanupResultSchema = z.object({
  timeline: z.string().describe("Timeline id."),
  revision: z.int().describe("Revision after the cuts; the revision the plan was made from when nothing was cut."),
  dryRun: z.boolean(),
  applied: z.boolean().describe("True when the cuts were made (a review-mode proposal counts: it waits for the person)."),
  tx: z.string().nullable().describe("Transaction the cuts are in; null when nothing was cut."),
  candidates: z.array(CleanupCandidateSchema).describe("Every cut proposed, in timeline order; with `applied` the ones that were made."),
  removed: z.number().describe("Seconds the candidates take out (the timeline gets that much shorter when they are applied)."),
  skipped: z.array(CleanupSkippedSchema).describe("Gaps and phrases that looked like a candidate but were not (not quiet, in a word hiding speech, under the confidence floor…), in timeline order."),
  words: z.int().describe("Kept transcript words looked at."),
  warnings: z.array(z.string()),
});

/** See {@link CleanupResultSchema}. */
export type CleanupResult = z.output<typeof CleanupResultSchema>;
