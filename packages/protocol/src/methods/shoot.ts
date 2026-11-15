import { z } from "zod";
import { ShootSceneStatusSchema, TakeInfoSchema } from "../shoot.js";
import { SessionSoundSchema, ShootSessionIdSchema } from "@frameshell/schema";
import { type MethodSpec, CwdParam, JobSchema } from "./shared.js";

/** Daemon methods: shoot (Rodaje) sessions and takes. */
export const shootMethods = {
  "shoot.status": {
    description:
      "Where a shoot is (ADR 0023): every scene of the shoot script with its state (`none`, `deviations`, `done`), the " +
      "take chosen for it (the newest covering it unless picked with `shoot.choose`) and how many deviations wait; " +
      "every take with how it said each line and every deviation (missing, changed, added, moved, restart, pause, " +
      "speaker, length, free) with its `accepted` flag; `next`, the first scene in script order not done (never " +
      "enforced); and the cues. Takes are compared against their asset's transcript when asked (cached): a take " +
      "whose asset has no transcript says so in `problem`. Reacting to a newly analyzed take without being asked is " +
      "fine (placing b-roll of a scene that just became done); never accept deviations or record in the person's " +
      "place unless asked. Fails with ScriptNotFound, OutsideProject or InvalidProjectFile.",
    params: z.strictObject({
      cwd: CwdParam,
      script: z.string().min(1).describe("Shoot script, absolute or relative to `cwd` (then the project root), e.g. `scripts/launch.md`."),
    }),
    result: z.object({
      script: z.string().describe("Shoot script, project-relative."),
      file: z.string().describe("Shoot file, project-relative (`shoots/<slug>.json`); it may not exist yet."),
      timeline: z.string().describe("Timeline the first cut goes into."),
      scenes: z.array(ShootSceneStatusSchema).describe("In script order."),
      takes: z.array(TakeInfoSchema).describe("Oldest first, discarded ones included."),
      next: z.string().nullable().describe("Slug of the first scene not done; null when every scene is done."),
      cues: z
        .array(
          z.object({
            scene: z.string(),
            line: z.int().describe("1-based file line."),
            label: z.string(),
            text: z.string().nullable(),
            free: z.boolean(),
            time: z
              .number()
              .nullable()
              .describe("Timeline seconds of the cue in the assembled timeline (`shoot.assemble`), from the words around it; null until its scene is assembled."),
          }),
        )
        .describe("Every cue of the script in order, for placing visuals (`[VISUAL: …]` becomes a clip or overlay at `time`)."),
      warnings: z.array(z.string()).describe("`script check` warnings of the script, and takes that point at a missing asset or scene."),
      transcription: z
        .object({
          provider: z.string().describe("`transcription.provider` of the project, else `whisper-cpp`."),
          ready: z.boolean().describe("True when that provider loads here, so takes get their words."),
          problem: z
            .string()
            .nullable()
            .describe(
              "Why it does not (not installed, plugin failed to load, project not trusted) and how to fix it; null when ready. " +
                "Takes cut meanwhile fail and are transcribed again once a plugin is installed.",
            ),
        })
        .describe("Whether takes can be transcribed in this project; check it before recording."),
    }),
  },
  "shoot.add": {
    mutating: true,
    description:
      "Link an existing media file as a take of a shoot script (ADR 0023), starting at `scene` (default the first). " +
      "It is compared against the script once the file has a transcript (`transcribe` it first, with `--speakers` " +
      "when several people speak). The id is generated (`k_` + 6 hex). Undo with `shoot.discard`. Fails with " +
      "ScriptNotFound, AssetNotFound, OutsideProject, InvalidOperation (unknown scene) or InvalidProjectFile.",
    params: z.strictObject({
      cwd: CwdParam,
      script: z.string().min(1).describe("Shoot script, e.g. `scripts/launch.md`."),
      asset: z.string().min(1).describe("Media file inside the project, absolute or relative to `cwd`, e.g. `assets/hook-2.mp4`."),
      scene: z.string().min(1).optional().describe("Slug of the scene the take starts at; default the first scene."),
      recordedAt: z.string().min(1).optional().describe("ISO 8601 time it was recorded; default now. Newer takes are chosen by default."),
    }),
    result: z.object({ file: z.string().describe("Shoot file written, project-relative."), take: TakeInfoSchema }),
  },
  "shoot.assemble": {
    mutating: true,
    description:
      "Build the first cut of a shoot (ADR 0023) in its timeline (`timeline` of `shoot.status`, created when missing): per " +
      "scene, in script order, the chosen take from its first to its last line, restarts and pauses over 1.5 s cut out, " +
      "0.15 s handles, edges snapped into pauses (`snap: false` keeps them exact), each clip linked to its scene " +
      "(`scriptRef`) and carrying its take (`take`). A scene already assembled is replaced in place and what follows " +
      "moves by the change in length; a scene whose take did not change is left alone. Only clips carrying one of the " +
      "shoot's takes are removed: clips, overlays and subtitles anyone else placed stay. One transaction (label " +
      "`Assemble <scene>`, or `Assemble <script>` for several), undone with `revert`; held as a proposal in review mode. " +
      "Then place the visuals from the cues' `time` in `shoot.status`. Fails with ScriptNotFound, InvalidProjectFile or " +
      "the timeline operations' errors.",
    params: z.strictObject({
      cwd: CwdParam,
      script: z.string().min(1).describe("Shoot script, e.g. `scripts/launch.md`."),
      scenes: z.array(z.string().min(1)).min(1).optional().describe("Scene slugs to (re)assemble; default every scene."),
      snap: z.boolean().default(true).describe("Snap clip edges into audio pauses (ADR 0003)."),
    }),
    result: z.object({
      timeline: z.string().describe("Timeline id written."),
      created: z.boolean().describe("True when the timeline file was created by this call."),
      tx: z.string().nullable().describe("Transaction id, for `revert`; null when nothing changed."),
      scenes: z
        .array(
          z.object({
            slug: z.string(),
            take: z.string().nullable(),
            action: z
              .enum(["placed", "unchanged", "removed", "none", "waiting"])
              .describe(
                "`placed`: new clips. `unchanged`: already as planned. `removed`: old clips taken out, no take covers it now. `none`: nothing to place. " +
                  "`waiting`: its take was recorded in the app and its session still records; it becomes shots of the session's program track when the session ends.",
              ),
            clips: z.array(z.string()).describe("Clip ids of the scene now."),
          }),
        )
        .describe("Scenes assembled, in script order."),
      warnings: z.array(z.string()),
    }),
  },
  "shoot.discard": {
    mutating: true,
    description:
      "Set a take aside: it stays listed but is never chosen, and a scene that had it picked goes back to the newest " +
      "take. `restore: true` brings it back (the inverse). Fails with InvalidOperation (unknown take), ScriptNotFound or InvalidProjectFile.",
    params: z.strictObject({
      cwd: CwdParam,
      script: z.string().min(1).describe("Shoot script."),
      take: z.string().min(1).describe("Take id, e.g. `k_3fa2c1`."),
      restore: z.boolean().default(false).describe("Undo an earlier discard."),
    }),
    result: z.object({ file: z.string(), take: z.string(), discarded: z.boolean() }),
  },
  "shoot.accept": {
    mutating: true,
    description:
      "Let deviations of a take pass (ADR 0023): the given ids, or every current one when `deviations` is left out " +
      "(the whole take). An accepted deviation stays accepted while its script line and heard words stay the same. " +
      "`undo: true` takes the acceptance back (the inverse). Accept only what the person asked for. Fails with " +
      "InvalidOperation (unknown take, a deviation id the take does not have now, or a take not analyzed yet), ScriptNotFound or InvalidProjectFile.",
    params: z.strictObject({
      cwd: CwdParam,
      script: z.string().min(1).describe("Shoot script."),
      take: z.string().min(1).describe("Take id."),
      deviations: z.array(z.string().min(1)).min(1).optional().describe("Deviation ids from `shoot.status`; default all of the take's."),
      undo: z.boolean().default(false).describe("Take the acceptance back."),
    }),
    result: z.object({ file: z.string(), take: z.string(), deviations: z.array(z.string()).describe("Ids whose acceptance changed.") }),
  },
  "shoot.choose": {
    mutating: true,
    description:
      "Pick the take that goes into the cut for a scene, or `take: null` to go back to the default (the newest take " +
      "covering it). Choosing again with the previous value is the inverse. Fails with InvalidOperation (unknown " +
      "scene or take, a discarded take, or one that does not cover the scene), ScriptNotFound or InvalidProjectFile.",
    params: z.strictObject({
      cwd: CwdParam,
      script: z.string().min(1).describe("Shoot script."),
      scene: z.string().min(1).describe("Scene slug."),
      take: z.string().min(1).nullable().describe("Take id, or null for the default."),
    }),
    result: z.object({ file: z.string(), scene: z.string(), take: z.string().nullable(), previous: z.string().nullable().describe("What was picked before; null = the default.") }),
  },
  "shoot.session.cut": {
    mutating: true,
    internal: true,
    description:
      "The app's Cut (ADR 0024 decision 4): add a take that is the range `start`..`end` of a session still recording, then " +
      "queue a `shoot` job that cuts that range of each sound file to 16 kHz mono PCM, transcribes it with the project's " +
      "model and compares it with the script (`shoot.changed` `analyzed`). Sound files are read as they grow (`<file>.part`).",
    params: z.strictObject({
      cwd: CwdParam,
      script: z.string().min(1).describe("Shoot script."),
      scene: z.string().min(1).describe("Scene the take starts at: the one the Shoot view shows as current."),
      session: ShootSessionIdSchema,
      start: z.number().nonnegative().describe("Session-clock second of `T`."),
      end: z.number().positive().describe("Session-clock second of `C`."),
      sounds: z.array(SessionSoundSchema).min(1).describe("Microphone first, then system audio."),
      recordedAt: z.string().min(1).optional().describe("ISO 8601 time of `T`; default now."),
    }),
    result: z.object({ file: z.string(), take: TakeInfoSchema, job: JobSchema }),
  },
  "shoot.session.end": {
    mutating: true,
    internal: true,
    description:
      "End a session that has takes (ADR 0024 decisions 1 and 4), its files final: wait for its takes' `shoot` jobs (and run " +
      "again, on the final files, those of takes left without words), write the takes' words as the transcripts of its sound files, make the session one multicam group (as `multicam.create` with " +
      "`offsets`) on the shoot's timeline, created when missing, without the first covering shot, and assemble the shoot, so " +
      "the session's chosen takes become shots of the group's program track.",
    params: z.strictObject({
      cwd: CwdParam,
      script: z.string().min(1).describe("Shoot script whose takes the session holds."),
      session: ShootSessionIdSchema,
      assets: z.array(z.string().min(1)).describe("Picture files (camera, screen), as `multicam.create` takes them; empty: no group."),
      names: z.array(z.string().min(1)).optional(),
      mics: z.array(z.string().min(1)).optional(),
      micNames: z.array(z.string().min(1)).optional(),
      soundOf: z.array(z.string().min(1)).optional(),
      offsets: z.array(z.number().nonnegative()).describe("One per file, pictures then mics."),
      screens: z.array(z.int().min(1)).optional(),
      name: z.string().min(1).optional(),
    }),
    result: z.object({
      timeline: z.string().describe("Timeline the group went to: the shoot's."),
      group: z.string().nullable().describe("New group; null when nothing had a picture."),
      transcripts: z.array(z.string()).describe("Transcript files written, project-relative."),
      tx: z.string().nullable().describe("Transaction of the assembly; null when nothing changed."),
      warnings: z.array(z.string()),
    }),
  },
} as const satisfies Record<string, MethodSpec>;
