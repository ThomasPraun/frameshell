import { z } from "zod";
import { ShootSessionIdSchema, TakeIdSchema } from "@frameshell/schema";

// Shoot (ADR 0023): takes of a shoot script compared word by word, kept in `shoots/<script slug>.json`.

/** What `shoot.changed` reports. */
export const SHOOT_CHANGES = ["add", "discard", "restore", "accept", "unaccept", "choose", "analyzed", "failed", "ended"] as const;

const AtSchema = z
  .object({ start: z.number(), end: z.number() })
  .nullable()
  .describe("Seconds in the take's file (on the session clock for a take recorded in the app); null when nothing was heard.");

/** One difference between a take and its shoot script. */
export const DeviationSchema = z.object({
  id: z.string().describe("Stable while the script line and the heard words stay the same; pass it to `shoot.accept`."),
  kind: z
    .enum(["missing", "changed", "added", "moved", "restart", "pause", "speaker", "length", "free"])
    .describe(
      "`missing`: script words not heard. `changed`: other words heard in their place (also a close spelling). `added`: heard words " +
        "the script lacks, also before the first and after the last line. `moved`: a line said out of order. `restart`: an earlier " +
        "attempt of a line the take repeats. `pause`: over 1.5 s of silence inside a line. `speaker`: someone else said the line. " +
        "`length`: the scene is more than 25% off its expected length. `free`: a `[FREE: …]` slot with under 5 s of speech.",
    ),
  scene: z.string().nullable().describe("Scene slug; null for speech outside every scene."),
  line: z.int().nullable().describe("1-based file line of the script line; null for `length` and for speech outside every scene."),
  expected: z.string().describe("What the script says there (the cue's note for `free`, `<n> s` for `length`, the name for `speaker`)."),
  heard: z.string().describe("What the take says there."),
  words: z.object({ from: z.int(), to: z.int() }).nullable().describe("Indexes into the line's `words` (`script.check`), inclusive."),
  at: AtSchema,
  maybeTranscription: z.boolean().describe("True when it may be the transcription's mistake (a number, a close spelling, one short word); still reported."),
  accepted: z.boolean().describe("Let pass with `shoot.accept`."),
  acceptedBy: z.string().nullable().describe("Author that accepted it; null when not accepted."),
});

/** A take as `shoot.status` reports it. */
export const TakeInfoSchema = z.object({
  id: TakeIdSchema,
  asset: z.string().describe("Project-relative media file."),
  scene: z.string().describe("Scene the take was said to start at."),
  recordedAt: z.string().describe("ISO 8601."),
  discarded: z.boolean(),
  by: z.string().nullable().describe("Author that linked it."),
  transcript: z
    .string()
    .nullable()
    .describe("Transcript file compared, project-relative (for a take recorded in the app while its session runs, its words under `.frameshell/shoot/takes/`); null when the asset has none."),
  session: z
    .object({
      id: ShootSessionIdSchema,
      start: z.number().describe("Session-clock second the take starts."),
      end: z.number().describe("Session-clock second it ends."),
      group: z.string().nullable().describe("Multicam group of the session; null while it records."),
    })
    .nullable()
    .describe("A take recorded in the app: its range of a shoot session (ADR 0024); null for a whole imported file."),
  state: z
    .enum(["analyzed", "transcribing", "no-transcript", "stale-transcript", "unreadable"])
    .describe(
      "`analyzed`: compared. `transcribing`: a take recorded in the app is being transcribed (job kind `shoot`). " +
        "`no-transcript`: run `frameshell transcribe <asset>` first. `stale-transcript`: the file changed since " +
        "it was transcribed; transcribe again. `unreadable`: the transcript is broken (`problem` says why).",
    ),
  problem: z.string().nullable().describe("Why it is not analyzed, with the command that fixes it; null when analyzed."),
  scenes: z.array(z.string()).describe("Slugs of the scenes it covers any line of, in script order."),
  lines: z
    .array(
      z.object({
        scene: z.string(),
        line: z.int().describe("1-based file line."),
        status: z.enum(["said", "partial", "missing", "moved", "outside"]).describe("`outside`: not in the part of the script the take covers."),
        at: AtSchema,
      }),
    )
    .describe("Every spoken line of the script and how this take said it; empty until analyzed."),
  deviations: z.array(DeviationSchema).describe("In script order; empty until analyzed."),
});

/** A scene as `shoot.status` reports it. */
export const ShootSceneStatusSchema = z.object({
  slug: z.string(),
  title: z.string(),
  ref: z.string().describe("`scriptRef` of the scene."),
  state: z
    .enum(["none", "deviations", "done"])
    .describe("`none`: no take covers it. `deviations`: its chosen take misses lines or has deviations not accepted. `done`: covered whole, all accepted."),
  chosen: TakeIdSchema.nullable().describe("Take that goes into the cut; null when none covers the scene."),
  picked: z.boolean().describe("True when the person picked `chosen` (`shoot.choose`); false when it is the newest take covering the scene."),
  takes: z.array(TakeIdSchema).describe("Takes covering any of its lines, oldest first; discarded ones left out."),
  pending: z.int().describe("Deviations of the chosen take in this scene not accepted yet."),
});

/** Params of `shoot.changed`. */
export const ShootChangedSchema = z.object({
  project: z.string().describe("Absolute project root, as returned by `events.subscribe`."),
  script: z.string().describe("Shoot script, project-relative."),
  change: z
    .enum(SHOOT_CHANGES)
    .describe(
      "A take was added (also cut in the app), discarded or restored, deviations were accepted or unaccepted, a take was chosen, " +
        "a take was compared for the first time since it or the script changed, a take recorded in the app could not be transcribed " +
        "(`failed`), or a session recorded in the app ended (`ended`).",
    ),
  take: TakeIdSchema.optional().describe("Take it happened to; absent for `choose` back to the default."),
});
