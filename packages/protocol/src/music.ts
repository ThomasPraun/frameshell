import { z } from "zod";

// `music.fit` (#485, ADR 0037): back-time a music clip so its final hit lands on a cut.

/** Most the speed of a fitted clip may change, as a fraction of its speed: ±1.7 % (ADR 0037 decision 3). */
export const MUSIC_FIT_MAX_VARISPEED = 0.017;

/** Confidence under which a detected final hit is reported but never used to change the speed (ADR 0037 decision 7). */
export const MUSIC_FIT_MIN_CONFIDENCE = 0.5;

/** One thing a fit does, so a dry run can be read and a step dropped with `skip`. */
export const MusicFitStepSchema = z.object({
  id: z
    .enum(["place", "intro", "speed", "fade", "duck", "shape"])
    .describe(
      "`place`: move the clip. `intro`: drop the start of the track (`in` later). `speed`: varispeed (`exact`). `fade`: the 5 ms fade in of the clip's start (`audio.fadeInMs`), written unless the clip already has a fade in. `duck`: run `track.duck` again on the clip's track. " +
        "`shape`: run `music.shape` again with the settings stored on the clip (`audio.shape`).",
    ),
  detail: z.string().describe("One sentence the person can read, e.g. `start 4.2 s -> 6 s`."),
  skippable: z.boolean().describe("True when `skip` may name this id."),
});

/** One strong hit near the end of the track, as a choice for `hit`. */
export const MusicFitHitCandidateSchema = z.object({
  at: z.number().describe("Source seconds of the hit."),
  rise: z.number().describe("dB the level jumps by at the hit."),
  level: z.number().describe("dB of the hit against the loud part of the track (0 = as loud as it, positive = louder; a final crash is usually above it)."),
});

/** The final hit a fit lands on the cut. */
export const MusicFitHitSchema = z.object({
  at: z.number().describe("Source seconds of the hit that lands on `end`."),
  source: z.enum(["given", "detected"]).describe("`given`: `hit` was passed. `detected`: found on the track's energy."),
  confidence: z
    .number()
    .describe(
      "0 to 1: 1 for a given hit. A detected one grows with how sharp the jump is, how much the sound falls away after it and how close it is to the end of the played part. Under 0.5 it never changes the speed.",
    ),
  rise: z.number().nullable().describe("dB the level jumps by there; null for a given hit."),
  candidates: z.array(MusicFitHitCandidateSchema).describe("The last strong hits of the played part, latest last, to pick another with `hit`; empty for a given hit."),
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
  hit: MusicFitHitSchema,
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
      parameters: z
        .enum(["stored", "defaults"])
        .describe("`stored`: the depth, attack, release, threshold and gap of the `track.duck` that wrote the clip's keys (kept in its `audio.duck`). `defaults`: the clip has none stored (ducked before they were)."),
    })
    .nullable()
    .describe("Set when the clip carries `auto: \"duck\"` keys, which sit on the clip's own clock and no longer fit the voice after a move or a speed change; null otherwise."),
  steps: z.array(MusicFitStepSchema).describe("What the fit does or did, in order."),
  warnings: z.array(z.string()),
});

/** See {@link MusicFitResultSchema}. */
export type MusicFitResult = z.output<typeof MusicFitResultSchema>;

// `music.candidates` (#485 slice 3, ADR 0037 decision 4): several tracks under the same picture at one loudness.

/** Most candidates one call places: the ear stops telling them apart. */
export const MUSIC_CANDIDATES_MAX = 7;

/** One candidate track, placed or (dry run) planned. */
export const MusicCandidateSchema = z.object({
  rank: z.int().describe("1 = the first choice: the one left unmuted. With `end` the order is the fit's (see `ranking`), else the order of `assets`."),
  asset: z.string().describe("Project-relative music file."),
  name: z.string().describe("Name of its audio track, `Music <rank>`."),
  track: z.string().nullable().describe("Its audio track id; null in a dry run."),
  clip: z.string().nullable().describe("Its clip id; null in a dry run."),
  muted: z.boolean().describe("True for every rank but the first: unmute one with `track.set`, and `track.remove --force` the others."),
  loudness: z.number().describe("Integrated loudness of the whole file, LUFS (EBU R128)."),
  truePeak: z.number().nullable().describe("True peak of the file, dBTP; null for digital silence."),
  gain: z.number().describe("Static clip gain, dB, that brings the file to `loudness.target` (0.1 dB steps)."),
  place: MusicFitPlaceSchema.describe("Where the clip plays: `start`, `in` and `end` on the timeline and the file."),
  hit: MusicFitHitSchema.nullable().describe("Only with `end`: the final hit that lands on it, as `music.fit` finds it."),
  landsAt: z.number().nullable().describe("Only with `end`: timeline seconds where the hit plays."),
  introCut: z.number().describe("Source seconds dropped from the start of the file because it is longer than the picture before the hit; 0 when none."),
  silentBefore: z.number().describe("Seconds between the start and the first sound when the file is shorter than the picture before the hit; 0 when none."),
  warnings: z.array(z.string()),
});

/** Result of `music.candidates`. */
export const MusicCandidatesResultSchema = z.object({
  timeline: z.string().describe("Timeline id."),
  revision: z.int().describe("Revision after the change; the revision it was planned from when nothing was written."),
  dryRun: z.boolean(),
  applied: z.boolean().describe("True when the tracks were added (a review-mode proposal counts: it waits for the person)."),
  tx: z.string().nullable().describe("Transaction the change is in; null when nothing was written."),
  end: z.number().nullable().describe("Timeline seconds every final hit was asked to land on; null without `end`."),
  loudness: z.object({
    target: z.number().describe("LUFS every candidate was brought to."),
    source: z.enum(["given", "quietest"]).describe("`given`: `loudness` was passed. `quietest`: the quietest file's own loudness, so no candidate is made louder than it is."),
  }),
  ranking: z.string().describe("How `rank` was chosen, in one sentence."),
  candidates: z.array(MusicCandidateSchema).describe("Best first."),
  skipped: z.array(z.object({ asset: z.string(), reason: z.string() })).describe("Files left out, and why (silent, no sound, no final hit, cannot be decoded)."),
  warnings: z.array(z.string()),
});

// `music.shape` (#485 slice 4, ADR 0037 decision 6): the music steps down before a hit and fades at the ending.

/** One thing a shaping does. */
export const MusicShapeStepSchema = z.object({
  id: z.enum(["fade", "shape", "duck"]).describe("`fade`: the 5 ms fade in of the clip's start (`audio.fadeInMs`), written first unless the clip already has a fade in. `shape`: write the `music` keys. `duck`: run `track.duck` again on the clip's track, since the keys replace its duck keys."),
  detail: z.string().describe("One sentence the person can read."),
});

/** Result of `music.shape`. */
export const MusicShapeResultSchema = z.object({
  timeline: z.string().describe("Timeline id."),
  revision: z.int().describe("Revision after the change; the revision it was planned from when nothing was written."),
  dryRun: z.boolean(),
  applied: z.boolean().describe("True when the clip was changed (a review-mode proposal counts: it waits for the person)."),
  tx: z.string().nullable().describe("Transaction the change is in; null when nothing was written."),
  clip: z.string().describe("The music clip."),
  track: z.string().describe("Its audio track."),
  asset: z.string().describe("Project-relative music file."),
  cleared: z.boolean().describe("True when the call removed the clip's music keys (`clear`)."),
  drops: z.array(z.number()).describe("Timeline seconds of the hits the music steps down before, resolved and sorted; hits outside the clip are left out (a warning says so)."),
  ending: z.number().nullable().describe("Timeline seconds the closing fade begins; null when none."),
  settings: z
    .object({
      drops: z.array(z.number()).optional(),
      lead: z.number().describe("Seconds before a hit that the step down is complete."),
      depth: z.number().describe("dB the music steps down by."),
      hold: z.number().describe("Seconds after a hit that the music stays down."),
      release: z.number().describe("Seconds the level takes to come back."),
      ending: z.number().optional(),
      fade: z.number().describe("Seconds of the closing fade."),
    })
    .nullable()
    .describe("What was written to the clip's `audio.shape`; null for `clear`."),
  curve: z
    .array(z.object({ time: z.number().describe("Timeline seconds."), dip: z.number().describe("dB under the clip's level.") }))
    .describe("The dip over time the keys follow: straight lines between these points, 0 before the first and after the last. Empty for `clear`."),
  duck: z
    .object({
      under: z.array(z.string()).describe("Tracks listened to for speech."),
      rerun: z.boolean().describe("True when duck ran again in the same transaction."),
      parameters: z.enum(["stored", "defaults"]).describe("`stored`: the parameters of the duck that wrote the clip's keys (its `audio.duck`). `defaults`: none stored."),
    })
    .nullable()
    .describe("Set when the clip carried `auto: \"duck\"` keys, which the new keys replace; null otherwise."),
  steps: z.array(MusicShapeStepSchema).describe("What the call does or did, in order."),
  warnings: z.array(z.string()),
});

/** See {@link MusicShapeResultSchema}. */
export type MusicShapeResult = z.output<typeof MusicShapeResultSchema>;

/** See {@link MusicCandidatesResultSchema}. */
export type MusicCandidatesResult = z.output<typeof MusicCandidatesResultSchema>;
/** See {@link MusicCandidateSchema}. */
export type MusicCandidate = z.output<typeof MusicCandidateSchema>;
