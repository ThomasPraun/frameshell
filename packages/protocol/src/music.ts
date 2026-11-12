import { z } from "zod";

// `music.fit` (#485, ADR 0037): back-time a music clip so its final hit lands on a cut.

/** Most the speed of a fitted clip may change, as a fraction of its speed: ±1.7 % (ADR 0037 decision 3). */
export const MUSIC_FIT_MAX_VARISPEED = 0.017;

/** Confidence under which a detected final hit is reported but never used to change the speed (ADR 0037 decision 7). */
export const MUSIC_FIT_MIN_CONFIDENCE = 0.5;

/** One thing a fit does, so a dry run can be read and a step dropped with `skip`. */
export const MusicFitStepSchema = z.object({
  id: z
    .enum(["place", "intro", "speed", "duck"])
    .describe("`place`: move the clip. `intro`: drop the start of the track (`in` later). `speed`: varispeed (`exact`). `duck`: run `track.duck` again on the clip's track."),
  detail: z.string().describe("One sentence the person can read, e.g. `start 4.2 s -> 6 s`."),
  skippable: z.boolean().describe("True when `skip` may name this id."),
});

/** One strong hit near the end of the track, as a choice for `hit`. */
export const MusicFitHitCandidateSchema = z.object({
  at: z.number().describe("Source seconds of the hit."),
  rise: z.number().describe("dB the level jumps by at the hit."),
  level: z.number().describe("dB of the hit against the loud part of the track (0 = as loud as it, positive = louder; a final crash is usually above it)."),
});

/** Where a clip stood, or will stand. */
export const MusicFitPlaceSchema = z.object({
  start: z.number().describe("Timeline seconds of the first frame."),
  in: z.number().describe("Source seconds of the first frame."),
  speed: z.number().describe("Playback rate; 1 = normal."),
  end: z.number().describe("Timeline seconds just after the last frame."),
});

/** Result of `music.fit`. */
export const MusicFitResultSchema = z.object({
  timeline: z.string().describe("Timeline id."),
  revision: z.int().describe("Revision after the fit; the revision it was planned from when nothing was written."),
  dryRun: z.boolean(),
  applied: z.boolean().describe("True when the clip was changed (a review-mode proposal counts: it waits for the person)."),
  tx: z.string().nullable().describe("Transaction the change is in; null when nothing was written."),
  clip: z.string().describe("The music clip."),
  track: z.string().describe("Its audio track."),
  asset: z.string().describe("Project-relative music file."),
  mode: z.enum(["slide", "exact"]).describe("`slide`: the clip moved, its speed kept. `exact`: its start kept and its speed changed a little."),
  end: z.number().describe("Timeline seconds the final hit was asked to land on (`end`, resolved and snapped to the frame grid)."),
  hit: z.object({
    at: z.number().describe("Source seconds of the hit that lands on `end`."),
    source: z.enum(["given", "detected"]).describe("`given`: `hit` was passed. `detected`: found on the track's energy."),
    confidence: z
      .number()
      .describe(
        "0 to 1: 1 for a given hit. A detected one grows with how sharp the jump is, how much the sound falls away after it and how close it is to the end of the played part. Under 0.5 it never changes the speed.",
      ),
    rise: z.number().nullable().describe("dB the level jumps by there; null for a given hit."),
    candidates: z.array(MusicFitHitCandidateSchema).describe("The last strong hits of the played part, latest last, to pick another with `hit`; empty for a given hit."),
  }),
  before: MusicFitPlaceSchema,
  after: MusicFitPlaceSchema,
  landsAt: z.number().describe("Timeline seconds where the hit now plays (3 decimals)."),
  offsetMs: z.number().describe("`landsAt - end` in milliseconds: at most half a frame when sliding, about 0 with `exact`."),
  speedChangePercent: z.number().nullable().describe("`exact` only: how much faster (+) or slower (-) the clip plays than before, in percent; null when its speed did not change."),
  introCut: z.number().describe("Source seconds dropped from the start of the track because it is longer than the picture before the hit (`in` moved later); 0 when none."),
  silentBefore: z
    .number()
    .describe("Seconds between `from` (default 0) and the first sound when the track is shorter than the picture before the hit; the track is never looped or spliced. 0 when none."),
  tail: z.number().describe("Seconds the music plays after the hit, to the clip's end."),
  duck: z
    .object({
      under: z.array(z.string()).describe("Tracks listened to for speech."),
      rerun: z.boolean().describe("True when duck ran again in the same transaction."),
    })
    .nullable()
    .describe("Set when the clip carries `auto: \"duck\"` keys, which sit on the clip's own clock and no longer fit the voice after a move or a speed change; null otherwise."),
  steps: z.array(MusicFitStepSchema).describe("What the fit does or did, in order."),
  warnings: z.array(z.string()),
});

/** See {@link MusicFitResultSchema}. */
export type MusicFitResult = z.output<typeof MusicFitResultSchema>;
