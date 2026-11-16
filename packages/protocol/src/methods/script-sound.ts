import { z } from "zod";
import {
  MUSIC_BPM_RANGE,
  MUSIC_CHORD_PATTERN,
  MUSIC_LIMITS,
  MUSIC_LUFS,
  MUSIC_MAX_BARS,
  MUSIC_MAX_SECONDS,
  MUSIC_METER_RANGE,
  MUSIC_PEAK_DBFS,
  MUSIC_PRESET_DEFAULTS,
  MUSIC_TAIL_SECONDS,
  MusicPresetSchema,
  MusicSectionSchema,
  SFX_JITTER,
  SFX_LENGTH_RANGE,
  SFX_PITCH_RANGE,
  SFX_SEED_MAX,
  SFX_VARIANTS,
  SOUND_KEY_GAP_MS,
  SOUND_MAX_PER_FRAME,
  SOUND_MAX_PLACEMENTS,
  SOUND_MIN_GAP_MS,
  SOUND_RISER_END_BEFORE_MS,
  SOUND_ROLE_OFFSETS,
  SOUND_TIER_OFFSETS_DB,
  SOUND_TYPING_RATE,
  ScriptMetaSchema,
  ScriptSceneSchema,
  SfxKindSchema,
  ShootMetaSchema,
  SoundRoleSchema,
  SoundTierSchema,
  ShootSceneSchema,
  VOICEOVER_LINE_GAP_S,
  VOICEOVER_TEMPO_RANGE,
  VoiceoverLineSchema,
} from "@frameshell/schema";
import { TimeRefParam, TimelineIdSchema } from "../timeline.js";
import {
  type MethodSpec,
  CwdParam,
  JobSchema,
  ClipLocationSchema,
  SceneSpanSchema,
  SoundCueSchema,
  SoundCutsSchema,
  SoundTypingSchema,
} from "./shared.js";

/** Daemon methods: scripts, voiceover and sound. */
export const scriptSoundMethods = {
  "script.outline": {
    description:
      "Outline a Markdown script (SPEC §5.5): frontmatter (`title`, `target_duration` in seconds, `aspect`) and its " +
      "scenes, one per `## ` heading, each with the `ref` to put in a clip's `scriptRef` (`scripts/launch.md#intro`, set " +
      "with `clip.set`) and the clips of every timeline already linked to it. Scenes with empty `clips` still need " +
      "footage or a composition. Top-level `clips` are linked to the whole script (`scriptRef` is the path without " +
      "`#anchor`), e.g. music or a full take; they cover no scene. `unresolved` lists clips pointing into this file at an anchor no scene has (renamed " +
      "or removed heading). A scene that names transcript words with `<!-- words: talk.words.json w_000010..w_000042 -->` under its heading (word ids repeat across transcripts: name the file; a bare range matching several transcripts is not placed) " +
      "has `wordRange`, and `span`: the timeline seconds those words occupy, per timeline, so you can place or re-place its clips; " +
      "unknown ids, an ambiguous range or a reversed range become `warnings`. " +
      "Never fails on content: bad frontmatter, duplicate headings or bad word ranges become `warnings`. Fails with " +
      "ScriptNotFound (data lists the scripts there are) or OutsideProject.",
    params: z.strictObject({
      cwd: CwdParam,
      file: z
        .string()
        .min(1)
        .describe("Markdown file inside the project, absolute or relative to `cwd` (then the project root), e.g. `scripts/launch.md`."),
    }),
    result: z.object({
      path: z.string().describe("Script file, project-relative and `/`-separated."),
      meta: ScriptMetaSchema,
      clips: z
        .array(ClipLocationSchema)
        .describe("Clips whose `scriptRef` is `path` without `#anchor` (the whole script), any timeline; empty when none."),
      scenes: z
        .array(
          ScriptSceneSchema.extend({
            ref: z.string().describe("`scriptRef` value for this scene: `<path>#<slug>`."),
            clips: z.array(ClipLocationSchema).describe("Clips whose `scriptRef` is `ref`, any timeline; empty when none."),
            span: z
              .array(SceneSpanSchema)
              .describe(
                "Where the scene's `wordRange` sits on each timeline that places any of those words (first to last placed word, " +
                  "through clips cut inside the range); empty when `wordRange` is null, unresolved, or no timeline places its words.",
              ),
          }),
        )
        .describe("In file order."),
      unresolved: z
        .array(ClipLocationSchema.extend({ scriptRef: z.string() }))
        .describe("Clips referencing this file at an anchor with no scene; fix with `clip.set` `scriptRef`."),
      warnings: z.array(z.string()).describe("Frontmatter problems, duplicate headings, bad word ranges, unreadable timelines or transcripts skipped."),
    }),
  },
  "script.check": {
    description:
      "Check a shoot script (ADR 0023): a script in `scripts/` with `shoot: true` that says, line by line, what each " +
      "person says on camera. Write it from the person's own script (any format), which stays untouched: name it in " +
      "`source` with `source_hash` (first 12 hex digits of its SHA-256). Returns the frontmatter, the speakers (each " +
      "with the `people.json` person of the same name, ignoring case), and per scene (`## ` heading; a closing timing " +
      "`(0:05–0:40)` is its `expected` length in seconds and is not part of the anchor) its lines: each non-blank text " +
      "line, its speaker (`**Name:**` holds until the next name), its spoken `words` and its cues (`[LABEL: text]`, " +
      "never spoken; `[FREE: …]` is unscripted speech checked only for presence and length). `source.stale` is true " +
      "when the original changed since: write the shoot script again from it. Never fails on content: unknown " +
      "speakers, a stale or missing source, empty scenes, leftover placeholders (`<…>`, `{{…}}`, `[TODO: …]`) and " +
      "frontmatter problems become `warnings`; clean when `warnings` is empty. Fails with ScriptNotFound (data lists " +
      "the scripts there are) or OutsideProject.",
    params: z.strictObject({
      cwd: CwdParam,
      file: z
        .string()
        .min(1)
        .describe("Markdown file inside the project, absolute or relative to `cwd` (then the project root), e.g. `scripts/launch.md`."),
    }),
    result: z.object({
      path: z.string().describe("Script file, project-relative and `/`-separated."),
      meta: ScriptMetaSchema,
      shoot: ShootMetaSchema,
      source: z
        .object({
          path: z.string().describe("Absolute path the frontmatter `source` resolves to (relative ones from the project root)."),
          found: z.boolean().describe("Whether the file exists and could be read."),
          hash: z.string().nullable().describe("First 12 hex digits of its SHA-256 now; null when not found."),
          stale: z.boolean().nullable().describe("True when `hash` differs from `source_hash`; null when either is unknown."),
        })
        .nullable()
        .describe("The person's original; null without a frontmatter `source`."),
      speakers: z
        .array(
          z.object({
            name: z.string().describe("Name as first written in the script."),
            person: z.string().nullable().describe("Id of the `people.json` person with this name (ignoring case); null when none."),
            lines: z.int().describe("Lines this speaker says."),
          }),
        )
        .describe("In order of first use; empty when the script names nobody (one speaker)."),
      scenes: z
        .array(ShootSceneSchema.extend({ ref: z.string().describe("`scriptRef` value for this scene: `<path>#<slug>`.") }))
        .describe("In file order."),
      warnings: z.array(z.string()).describe("Everything to fix before recording; empty when the script is clean."),
    }),
  },
  "voiceover.generate": {
    mutating: true,
    description:
      "Generate the voiceover of a voiceover script (ADR 0034): one spoken take per line, written to " +
      "`assets/voiceover/<script slug>/<line id>.wav` and imported (ingest queued) with one `asset.import`. A voiceover " +
      "script is a script in `scripts/` with `voiceover: true` in its frontmatter (also `language`, `provider`, `voice`), " +
      "read like a shoot script: one line per non-blank text line, `## ` scenes, `[LABEL: …]` cues never read. A " +
      "respelling `{display|spoken}` shows `display` and says `spoken` (`{Frameshell|freim shel}`); with `language: es` or " +
      "`en`, numbers with digits are spelled out for the voice and kept as digits in `display`. Line ids are " +
      "`<scene slug>-<n>` (`hook-1`). Each take is cached by its spoken text, provider (and its version), voice and " +
      "language: a line whose take is current is not generated again (`cached`), and one whose text moved to another " +
      "line id is copied (`copied`). Head and tail silence are trimmed with a little air kept. Each line also reports " +
      "its `phrases`: where the take falls silent for 60 ms or more (5 ms RMS, 38 dB under its peak), as ranges of the " +
      "take in seconds, the cuts of phrase clips (`clip add --in from --out to`); `phraseFade` is the 12 ms fade #470 asks for at each phrase edge, " +
      "which `voiceover.place` applies as the clips' audio fades. A person corrects the phrases by trimming the clips. With `verify` (default) each line's take is also " +
      "transcribed by the project's transcription provider and compared with the line's spoken text: `check` lists the " +
      "misreads, and `verification` says whether that ran. It is skipped, never a failure, when the project is not " +
      "trusted, has no transcription plugin or the transcription fails; the takes stay as they are. Nothing is placed " +
      "on a timeline. A paid provider (its cost estimate is above 0, or it gives no estimate and does not declare itself " +
      "free) generates nothing without `yes: true` and fails with ConfirmationRequired, whose data carries the cost " +
      "(`null` when unknown) and a `confirmation` token of what was priced (provider, voice, the lines to say and the cost): show it to the person and pass `yes` only after they confirm it, never on your own. " +
      "A client that showed the person the cost passes the token back as `confirmation`: when the lines or the cost changed since " +
      "(the script was edited, a take appeared, the provider's price moved) a paid run fails with ConfirmationStale, " +
      "carrying the current ask, and generates nothing; ask the person again. The " +
      "provider `command` is the TTS program the person set up on this machine (global `config.json` only); it is free. A second charge is prevented by the takes marked on disk and one run at a time per " +
      "project (a retry finds them `cached`); `idempotencyKey` only replays a result where a client sends one. A running " +
      "generation is not stopped by the caller disconnecting. Progress arrives as `progress` notifications. Fails with ScriptNotFound, " +
      "SpeechProviderNotFound (data lists the providers there are; `command` is missing until set up on the machine), ProjectNotTrusted (a plugin provider in an untrusted " +
      "project), ConfirmationStale (`confirmation` no longer matches the run), InvalidParams (no provider or voice named, unknown voice or line id; the message lists the valid " +
      "ones), InvalidOperation (a take file exists that this method did not write: it is never overwritten) or " +
      "SpeechFailed (the provider failed; takes finished before it are kept, imported and reused by the next call).",
    params: z.strictObject({
      cwd: CwdParam,
      script: z
        .string()
        .min(1)
        .describe("Voiceover script inside the project, absolute or relative to `cwd` (then the project root), e.g. `scripts/launch-vo.md`."),
      lines: z
        .array(z.string().min(1))
        .min(1)
        .optional()
        .describe("Line ids to generate (`hook-1`, `problem-2`); default every line of the script."),
      provider: z
        .string()
        .min(1)
        .optional()
        .describe("Speech provider id. Default: the script's frontmatter `provider`."),
      voice: z
        .string()
        .min(1)
        .optional()
        .describe("Voice id of the provider. Default: the script's frontmatter `voice`, else the provider's default voice."),
      yes: z
        .boolean()
        .default(false)
        .describe("The person confirmed the cost of a paid provider. Never set it without their explicit confirmation."),
      confirmation: z
        .string()
        .min(1)
        .optional()
        .describe(
          "The `confirmation` token of the ConfirmationRequired the person saw. A paid run whose lines or cost no longer match it " +
            "fails with ConfirmationStale instead of charging more than was confirmed. Without it `yes` confirms whatever the run costs.",
        ),
      verify: z
        .boolean()
        .default(true)
        .describe(
          "Transcribe each line's take with the project's transcription provider and compare it with the line (the misread " +
            "check). Takes a moment per line and may download the transcription model on first use; `false` skips it.",
        ),
    }),
    result: z.object({
      script: z.string().describe("Script file, project-relative and `/`-separated."),
      dir: z.string().describe("Folder of the takes, project-relative: `assets/voiceover/<script slug>`."),
      provider: z.string().describe("Speech provider used."),
      voice: z.string().describe("Voice used."),
      lines: z
        .array(
          VoiceoverLineSchema.omit({ cues: true, speaker: true, words: true }).extend({
            file: z.string().describe("The take, project-relative: `assets/voiceover/<script slug>/<id>.wav`."),
            state: z
              .enum(["generated", "cached", "copied"])
              .describe("`generated`: the provider said it now. `cached`: the file already held this take. `copied`: taken from the file of another line id with the same take."),
            duration: z.number().describe("Seconds of the take after trimming."),
            trimmed: z.object({ head: z.number(), tail: z.number() }).describe("Seconds of silence removed from the start and the end; 0 for `cached` and `copied`."),
            phrases: z
              .array(
                z.object({
                  from: z.number().describe("Start, seconds of the take."),
                  to: z.number().describe("End, seconds of the take."),
                  heard: z.string().nullable().describe("The words heard in this range; null when the line was not checked."),
                }),
              )
              .describe("The take split at its silences, in order (at least one): the ranges of the phrase clips."),
            check: z
              .object({
                status: z
                  .enum(["clean", "doubtful", "misread"])
                  .describe("`clean`: heard as written. `doubtful`: only differences the transcription may have made (numbers, close spellings, a respelled name). `misread`: the voice said something else."),
                heard: z.string().describe("Everything heard in the take."),
                misreads: z
                  .array(
                    z.object({
                      kind: z.enum(["missing", "changed", "added", "moved", "restart", "pause"]).describe("`missing`: not said. `changed`: said as other words. `added`: extra words. `moved`/`restart`: words repeated or out of place. `pause`: a silence of 1.5 s or more inside the line."),
                      expected: z.string().describe("What the spoken text has there."),
                      heard: z.string().describe("What was heard there; empty for `missing`."),
                      at: z.object({ start: z.number(), end: z.number() }).nullable().describe("Seconds of the take; null when nothing was heard."),
                      maybeTranscription: z.boolean().describe("The difference may be the transcription's, not the voice's."),
                    }),
                  )
                  .describe("Every difference, in order; empty when `clean`."),
              })
              .nullable()
              .describe("The misread check of this line; null when it did not run (see `verification`)."),
          }),
        )
        .describe("The lines asked for, in script order."),
      phraseFade: z.number().describe("The 12 ms fade at each phrase edge that #470 asks for, in seconds; `voiceover.place` applies it as each clip's `audio.fadeInMs`/`fadeOutMs`."),
      verification: z
        .object({
          status: z.enum(["checked", "skipped"]).describe("`skipped`: the misread check did not run; `reason` says why."),
          provider: z.string().nullable().describe("Transcription provider asked; null when not asked."),
          model: z.string().nullable().describe("Model it used, when known."),
          reason: z.string().nullable().describe("Why it was skipped (`verify: false`, an untrusted project, no transcription plugin, a failed transcription); null when checked."),
          misread: z.number().int().describe("Lines whose `check` is `misread`."),
          doubtful: z.number().int().describe("Lines whose `check` is `doubtful`."),
        })
        .describe("Whether the misread check ran. In an untrusted project it is skipped: the takes are generated and left unchecked."),
      imported: z
        .array(z.object({ asset: z.string().describe("Project-relative take."), job: JobSchema }))
        .describe("Takes this call wrote (`generated`, `copied`), imported together; follow their ingest with `job.list`."),
      cost: z
        .object({ amount: z.number(), currency: z.string() })
        .nullable()
        .describe("Estimated cost of the takes generated by this call; null when the provider is free or nothing was generated."),
      warnings: z.array(z.string()).describe("Script problems (budget over a scene's timing, digits without `language`…) and provider notes."),
    }),
  },
  "voiceover.cancel": {
    internal: true,
    description:
      "Stop the `voiceover.generate` running in the project (the app's Cancel button, ADR 0034): the line being said is " +
      "abandoned, takes finished before it stay written and imported (they may have been paid for), and the stopped call fails " +
      "with SpeechFailed whose data has `canceled: true` and the `written` takes. A run that is only waiting its turn behind " +
      "another is not stopped, and a run in its misread check ends with the check skipped. Safe to repeat; `canceled` is false when " +
      "nothing was running.",
    params: z.strictObject({ cwd: CwdParam }),
    result: z.object({ canceled: z.boolean().describe("A running generation was told to stop; false when none ran in this project.") }),
  },
  "voiceover.place": {
    mutating: true,
    description:
      "Place the takes of a voiceover script (ADR 0034) on a timeline as phrase clips, in one transaction `Voiceover: …` " +
      "(one proposal in review mode; `revert` undoes it whole). Run `voiceover.generate` first: each line's take is read from " +
      "`assets/voiceover/<script slug>/<line id>.wav` (a line with no take fails and is named), cut at its silences into " +
      "phrases (the ranges `voiceover.generate` reports) and every phrase becomes a media clip of the take (`in`/`out` on " +
      "whole frames, `scriptRef` `<script>#<scene>`) on an audio track: `track`, else the one named `Voiceover`, made when absent. " +
      "The phrases of a line keep the spacing the take has. Where a line goes: `at` maps a line id (`hook-1`) or one phrase of it " +
      "(`hook-1.2`, counting from 1) to a time, given as seconds, a marker id or label (`hook`, `hook+0.5`) or a beat or bar of the timeline's " +
      "grid (`beat:9`, `bar:3`), resolved by the same TimeRef rules as every time argument; the clip starts on the frame nearest it, " +
      "so the first sound follows by 20 ms of air kept in the phrase. A line (or phrase) with no `at` follows the one before it by " +
      `\`gap\` seconds (default ${VOICEOVER_LINE_GAP_S}); the first one starts at \`start\`, else right after the track's last clip, else 0. ` +
      "Voice never overlaps itself: a phrase that would start before the previous one ends, or on a clip already on the track, fails " +
      "and names both, so move the anchor or drop it. Anchors must run in script order: an `at` earlier than the phrase before it " +
      "fails the same way even when nothing else is there. A line whose take is already on a timeline clip fails naming the clips unless " +
      "`replace` is true, which removes those clips first (use it after `voiceover.generate` changed a take: the old phrase " +
      "ranges no longer fit it). `dryRun` plans without writing. Every phrase clip gets the 12 ms phrase fade at both ends as sample-accurate " +
      "audio fades (`audio.fadeInMs`/`fadeOutMs`, as `clip.set` `audioFadeInMs`/`audioFadeOutMs` sets them), on top of the 20 ms before and 30 ms after " +
      "its sound each phrase keeps. A take said from older text than the line has now " +
      "is placed with a warning. `tempo` sets the speed of single phrases (keys as in `at`; " +
      `${VOICEOVER_TEMPO_RANGE.min} to ${VOICEOVER_TEMPO_RANGE.max}, 1 = as spoken): the phrase clip gets that \`speed\` (pitch kept in preview and export), so it ` +
      "lasts (out - in) / speed on the timeline; each placed phrase reports its `speed` and effective `duration`, the pause the take has before " +
      "the next phrase of a line keeps its length, and the line's `end` follows the sped phrases. Tempo is per phrase, never a whole take. " +
      "Fails with ScriptNotFound, " +
      "InvalidParams (unknown line id, `at` or `tempo` key or phrase number, a tempo out of range), InvalidOperation (not a voiceover script, a line with no take, an unknown " +
      "marker, a `track` that is not an audio track, overlap, clips already placed) or TimelineNotFound.",
    params: z.strictObject({
      cwd: CwdParam,
      timeline: TimelineIdSchema,
      script: z
        .string()
        .min(1)
        .describe("Voiceover script inside the project, absolute or relative to `cwd` (then the project root), e.g. `scripts/launch-vo.md`."),
      lines: z
        .array(z.string().min(1))
        .min(1)
        .optional()
        .describe("Line ids to place (`hook-1`), default every line of the script, in script order."),
      at: z
        .record(z.string().min(1), TimeRefParam("Timeline time of the first sound of the line or phrase."))
        .optional()
        .describe("Where lines or phrases go: keys are line ids (`hook-1`, the same as `hook-1.1`) or one phrase (`hook-1.2`); lines and phrases left out follow the one before."),
      tempo: z
        .record(z.string().min(1), z.number().min(VOICEOVER_TEMPO_RANGE.min).max(VOICEOVER_TEMPO_RANGE.max))
        .optional()
        .describe(
          `Speed of single phrases, ${VOICEOVER_TEMPO_RANGE.min} to ${VOICEOVER_TEMPO_RANGE.max} (1 = as spoken, 1.1 = 10 % faster, pitch kept): keys are one phrase (\`hook-1.2\`) or a line id (\`hook-1\`), which is its phrase 1 only, not the whole line. Phrases left out play at 1.`,
        ),
      start: TimeRefParam("Timeline time of the first line when it has no `at`. Default: right after the last clip of the voice track, else 0.").optional(),
      gap: z
        .number()
        .min(0)
        .max(30)
        .default(VOICEOVER_LINE_GAP_S)
        .describe(`Seconds of air between a line and the next one that has no \`at\`. Default ${VOICEOVER_LINE_GAP_S}.`),
      track: z.string().min(1).optional().describe("Audio track for the voice, from `track.list`. Default: the audio track named `Voiceover`, made when absent."),
      replace: z
        .boolean()
        .default(false)
        .describe("Remove the clips that already play these lines' takes (on any track of the timeline) before placing. Default false: they make the call fail."),
      dryRun: z.boolean().default(false).describe("Plan and report without changing the timeline."),
    }),
    result: z.object({
      timeline: z.string().describe("Timeline id."),
      revision: z.int().describe("Revision after the last change; the one before the call when nothing was written."),
      dryRun: z.boolean().describe("Nothing was written."),
      tx: z.string().nullable().describe("Transaction holding the change (`revert` with it); null on a dry run."),
      track: z
        .object({ id: z.string().nullable().describe("Null for a track a dry run would make."), name: z.string().nullable(), created: z.boolean().describe("This call made the track (a dry run: would make).") })
        .describe("The audio track the phrases went on."),
      script: z.string().describe("Script file, project-relative."),
      lines: z
        .array(
          z.object({
            id: z.string().describe("Line id."),
            start: z.number().describe("Timeline second of its first clip."),
            end: z.number().describe("Timeline second just after its last clip."),
            anchor: z.enum(["at", "start", "follows"]).describe("`at`: given by `at`. `start`: the first line, put at `start` or after the track's last clip. `follows`: after the previous line plus `gap`."),
          }),
        )
        .describe("The lines placed, in order."),
      placed: z
        .array(
          z.object({
            line: z.string().describe("Line id."),
            phrase: z.int().describe("Phrase number inside the line, from 1."),
            clip: z.string().nullable().describe("Id of the new clip; null on a dry run."),
            file: z.string().describe("The take, project-relative."),
            in: z.number().describe("Source seconds of the take where the clip starts, on the frame grid."),
            out: z.number().describe("Source seconds where it ends."),
            start: z.number().describe("Timeline second the clip starts, on the frame grid."),
            end: z.number().describe("Timeline second just after its last frame."),
            speed: z.number().describe("Tempo of the clip: 1 as spoken (`tempo` of the call, else 1)."),
            duration: z.number().describe("Effective length in seconds on the timeline, (out - in) / speed, to the millisecond; `end - start` is that rounded to whole frames."),
            anchor: z.enum(["at", "start", "follows", "spacing"]).describe("`spacing`: a later phrase of a line, at the spacing the take has; the others as in `lines`."),
          }),
        )
        .describe("The phrase clips, in time order."),
      replaced: z.array(z.string()).describe("Ids of the clips removed by `replace`."),
      warnings: z.array(z.string()).describe("Takes older than their line, phrases shorter than a frame that were left out, and the engine's own warnings."),
    }),
  },
  "sound.sfx": {
    mutating: true,
    description:
      "Generate a sound effect (ADR 0038): synthesized offline from a seed, no network and no third-party samples. Kinds: " +
      "`click`, `tick`, `pop`, `whoosh` (stereo, swells to a peak at 45 % of its length), `riser` (a build that ends at its " +
      "peak), `thump`, `impact`, `shutter`, `glitch` (a stutter of short tones), `braaam` (a low brass blast), `swell` (a quiet build that " +
      "peaks near its end), `bell` (a soft bell), `notify` (a ping near 2 kHz) and `sting` (a chirp falling into a low hum, for a logo); " +
      "`variant` 1 to 3 is a different recipe of the kind. The same kind, variant, seed " +
      "(and `pitch`, `length` when given) always give the same file, so a set of sounds made with one `seed` shares a " +
      "timbre; vary `variant` and `seed` between uses (the same whoosh on every cut is the tell of a bad edit). Without " +
      "`pitch` the take gets a seeded pitch between 0.9 and 1.3 and a level within 1.5 dB. The take is a 48 kHz 16-bit WAV " +
      "written to `assets/sound/<kind>-<key>.wav` and imported (ingest queued) with one `asset.import`; the peak sits at " +
      "-3 dBFS give or take the jitter. A RIFF chunk inside the file holds its cache key and `peakAt`, the second of the " +
      "take that must land on the picture (the transient of a hit, the peak of a whoosh or swell, the end of a riser, where a sting's chirp lands): place a " +
      "take so that `peakAt` falls on the cue plus an offset by role (ms, negative = before the picture: tap -60, knock " +
      "-40, click -11, pop +30, whoosh peak +37, swell peak +42; a riser ends 75 ms before the hit). A take " +
      "that is already current is not written again (`cached`); nothing is placed on a timeline. When the project " +
      "keeps a `credits.json` ledger, the take is recorded in it with licence `own` (`credited`); without a ledger " +
      "nothing is written there. Fails with InvalidParams (a `length` for a kind that has none, or out of range) or " +
      "InvalidOperation (a file of that name exists that this method did not write: it is never overwritten).",
    params: z.strictObject({
      cwd: CwdParam,
      kind: SfxKindSchema.describe("What the sound is."),
      variant: z.number().int().min(1).max(SFX_VARIANTS).default(1).describe(`Recipe of the kind, 1 to ${SFX_VARIANTS}.`),
      seed: z
        .number()
        .int()
        .min(0)
        .max(SFX_SEED_MAX)
        .default(0)
        .describe("Family seed: the same seed gives the same file and a consistent timbre across kinds. Change it for another take of the same sound."),
      pitch: z
        .number()
        .min(SFX_PITCH_RANGE.min)
        .max(SFX_PITCH_RANGE.max)
        .optional()
        .describe(`Multiplier of every frequency. Default: a seeded value from ${SFX_JITTER.pitch.min} to ${SFX_JITTER.pitch.max}.`),
      length: z
        .number()
        .positive()
        .optional()
        .describe(
          `Seconds, only for ${Object.entries(SFX_LENGTH_RANGE)
            .map(([kind, range]) => `\`${kind}\` (${range.min} to ${range.max})`)
            .join(" and ")}; the other kinds have a fixed length. Default: the variant's own.`,
        ),
    }),
    result: z.object({
      kind: SfxKindSchema,
      variant: z.number().int(),
      seed: z.number().int(),
      pitch: z.number().describe("The pitch multiplier used, jitter included."),
      file: z.string().describe("The take, project-relative: `assets/sound/<kind>-<key>.wav`."),
      state: z.enum(["generated", "cached"]).describe("`generated`: written now. `cached`: the file already held this exact take."),
      duration: z.number().describe("Seconds."),
      channels: z.number().int().describe("2 for a whoosh, 1 otherwise."),
      peakAt: z.number().describe("Seconds from the start of the take to the instant that must land on the cue."),
      peakDb: z.number().describe("Sample peak, dBFS."),
      rmsDb: z.number().describe("RMS over the whole take, dBFS."),
      imported: z
        .array(z.object({ asset: z.string().describe("Project-relative take."), job: JobSchema }))
        .describe("The take when this call wrote it, imported; empty when `cached`. Follow its ingest with `job.list`."),
      credited: z.boolean().describe("The project's `credits.json` holds an `own` entry for the take. False when the project keeps no ledger."),
    }),
  },
  "sound.place": {
    mutating: true,
    description:
      "Place generated sound effects (ADR 0038) on a timeline, in one transaction `Sound: …` (one proposal in review mode; " +
      "`revert` undoes it whole). Each sound is made like `sound.sfx` (reused when the same take exists, else written to " +
      "`assets/sound/` and imported) and put on an audio track so that the instant of the take that must meet the picture " +
      "(`peakAt`: the transient of a hit, the peak of a whoosh, the end of a riser) falls on its cue plus an offset by role " +
      `(ms, negative = before the picture: ${Object.entries(SOUND_ROLE_OFFSETS).map(([role, ms]) => `${role} ${ms}`).join(", ")}; ` +
      `a riser ends ${SOUND_RISER_END_BEFORE_MS} ms before the cue). Without \`role\` a kind takes its own (click, shutter and glitch \`click\`, tick \`tap\`, ` +
      "pop, thump, bell and notify `pop`, whoosh `whoosh`, swell `swell`, impact, braaam and sting `knock`); `offset` (ms) replaces the table. A clip starts on a frame, so a sound lands within half " +
      "a frame of where asked, and it plays whole frames (a sound shorter than one frame is skipped, with a reason). " +
      "Three ways to say where: `cues` (each with `at`: seconds, a marker id or label, optionally `hook+0.5`), `cuts` (the edit point at the start of every clip after the first of a video " +
      "or audio `track`, or only the numbered ones in `which`) and `typing` (a run of keys between `from` and `to`, " +
      `${SOUND_TYPING_RATE.default} keys a second by default, at most ${SOUND_TYPING_RATE.max}, spaced at least ${SOUND_KEY_GAP_MS} ms apart (a warning when whole frames bring two keys closer), with a seeded ±10 % timing jitter ` +
      "and rotating takes). Sounds go on the audio track named `SFX` (made when absent) or on `track`; sounds that overlap in time " +
      "go on further tracks `SFX 2`, `SFX 3`… The clip `gain` (dB) is minus the style's `sound.sfxUnderVoice` (20 by default) " +
      `plus the tier: ${Object.entries(SOUND_TIER_OFFSETS_DB).map(([tier, db]) => `${tier} ${db}`).join(", ")} dB (\`gain\` replaces it). ` +
      "Without `variant` the takes of one kind rotate through variants 1 to 3 along the timeline, so the same whoosh is never twice in a row. " +
      "Taste is a warning, never a refusal: the call warns (`warnings`) when more than " +
      `${SOUND_MAX_PER_FRAME} sounds land on one frame, when two sounds of one kind are closer than their minimum gap ` +
      `(${Object.entries(SOUND_MIN_GAP_MS).map(([kind, ms]) => `${kind} ${ms} ms`).join(", ")}) and when one take plays twice in a row, counting sounds already on the timeline. ` +
      "Example: `{ cues: [{ at: \"hook\", kind: \"whoosh\" }, { at: 6.2, kind: \"click\", seed: 3 }] }`. " +
      `At most ${SOUND_MAX_PLACEMENTS} sounds per call. Fails with InvalidParams (nothing to place), InvalidOperation (an unknown ` +
      "marker, a `track` that is not an audio track, a hand-made file in the way of a take) or TimelineNotFound.",
    params: z.strictObject({
      cwd: CwdParam,
      timeline: TimelineIdSchema,
      cues: z.array(SoundCueSchema).min(1).optional().describe("Sounds at given times; each is one sound."),
      cuts: SoundCutsSchema.optional().describe("Sounds on the edit points of a track."),
      typing: SoundTypingSchema.optional().describe("A run of key sounds between two times."),
      track: z
        .string()
        .min(1)
        .optional()
        .describe("Audio track for the sounds, from `track.list`. Default: the audio track named `SFX`, made when absent."),
    }),
    result: z.object({
      timeline: z.string().describe("Timeline id."),
      revision: z.int().describe("Revision after the last change; the one before the call when nothing was placed."),
      tx: z.string().nullable().describe("Transaction holding the change (`revert` with it); null when nothing was placed."),
      tracks: z
        .array(z.object({ id: z.string(), name: z.string().nullable(), created: z.boolean().describe("This call made the track.") }))
        .describe("The audio tracks the sounds went on, first lane first."),
      placed: z
        .array(
          z.object({
            clip: z.string().describe("Id of the new clip."),
            track: z.string(),
            file: z.string().describe("The take, project-relative: `assets/sound/<kind>-<key>.wav`."),
            state: z.enum(["generated", "cached"]).describe("`generated`: this call wrote the take. `cached`: it already existed."),
            kind: SfxKindSchema,
            role: SoundRoleSchema.nullable().describe("Role whose offset applied; null for a riser's own rule or an `offset` given."),
            tier: SoundTierSchema,
            from: z.enum(["cue", "cut", "typing"]).describe("Which part of the call asked for it."),
            cue: z.number().describe("Timeline second the sound belongs to."),
            offset: z.number().describe("Milliseconds from the cue to the take's anchor that were used."),
            start: z.number().describe("Timeline second the clip starts, on the frame grid."),
            in: z.number().describe("Source seconds cut off the head of the take; above 0 only when it would start before the timeline does."),
            anchorAt: z.number().describe("Timeline second where the take's anchor falls after rounding to frames."),
            gain: z.number().describe("Clip gain, dB."),
          }),
        )
        .describe("The clips made, in time order."),
      skipped: z
        .array(z.object({ cue: z.number(), kind: SfxKindSchema, reason: z.string() }))
        .describe("Sounds asked for and not placed, with why (shorter than one frame, would start before the timeline)."),
      generated: z.int().describe("Takes this call wrote (the others were reused)."),
      warnings: z.array(z.string()).describe("Crowded frames, short gaps, a take twice in a row, trimmed heads, and the engine's own warnings."),
    }),
  },
  "sound.music": {
    mutating: true,
    description:
      "Generate a music bed (ADR 0038): a seeded 16-step sequencer synthesized offline, no network and no third-party samples. " +
      `Presets: \`synthwave\` (${MUSIC_PRESET_DEFAULTS.synthwave.bpm} BPM, ${MUSIC_PRESET_DEFAULTS.synthwave.chords.join("-")}, saw chords, ` +
      `four on the floor), \`lofi\` (${MUSIC_PRESET_DEFAULTS.lofi.bpm} BPM, ${MUSIC_PRESET_DEFAULTS.lofi.chords.join("-")}, electric piano, swung ` +
      `hats, vinyl, dark), \`minimal\` (${MUSIC_PRESET_DEFAULTS.minimal.bpm} BPM, FM mallet stabs, plucked bass, metallic hats, no pads). ` +
      "The track has whole bars (`bars`, or as many as fit `length` seconds, or with `place` and neither, as many as fit from " +
      "`at` to the end of the timeline) made of `sections`: `intro`, `full`, `dark` (stripped: pad, sub, soft kick, for under a " +
      "voice or a dense picture), `build` (a climbing motif, a clap roll and a riser that ends 75 ms before the next part), " +
      "`gap` (one stop-time hit, then silence so the next downbeat lands hard), `drop` (everything, a crash and a big kick on " +
      "its first beat), `outro` (half time). Without `sections` it is intro, full, build and drop (from 8 bars), outro. A " +
      "section's `at` (a time on the timeline) starts it on the nearest bar, so a drop can land on a marker. Every track ends " +
      "on a final hit, the first chord with a crash and a big kick on the downbeat after its last bar, that rings for " +
      `${MUSIC_TAIL_SECONDS} s; \`accents\` add a crash and a big kick on the nearest beat (a logo, a call to action). The same ` +
      "arguments always give the same file. The take is a 48 kHz 24-bit stereo WAV at " +
      `${MUSIC_LUFS} LUFS with its sample peak at most ${MUSIC_PEAK_DBFS} dBFS, written to \`assets/sound/music-<preset>-<key>.wav\` and imported; ` +
      "beside it the call writes its exact beat grid `beats/<name>.beats.json` (`detector: \"exact\"`, confidence 1, the " +
      "downbeat at 0, the final hit and accents as `onsets`), so nothing measures it and later calls' `beat:`/`bar:` times, `--snap-to " +
      "beat` and `music.fit` can use it at once (this call's own `at`, section and accent times take `beat:`/`bar:` too, read on the timeline's grid before the new bed exists, and with no `tempo` they are refused). With `place` (default) the call also puts the take on the timeline in one " +
      "transaction `Music: …` (one proposal in review mode; `revert` undoes it): a clip starting at `at` (default 0) on the " +
      "audio track named `Music` (made when absent; `Music 2`… when the time is taken) or on `track`, with `gain` minus the " +
      "style's `sound.musicUnderVoice` (12 dB by default), and when the timeline has no `tempo` yet, `tempo` set to follow " +
      "the new clip; an existing tempo is kept, with a warning. `place: false` only writes and imports the take. When the " +
      "project keeps a `credits.json`, the take is recorded as `own` work. Fails with InvalidParams (no length to go by, " +
      "bars and sections that disagree, too long) or InvalidOperation (an unknown marker, a `track` that is not an audio " +
      "track or is taken at that time, a hand-made file in the way of the take).",
    params: z.strictObject({
      cwd: CwdParam,
      timeline: TimelineIdSchema,
      preset: MusicPresetSchema.describe("Genre: instruments, groove, default tempo and chords."),
      bpm: z
        .number()
        .min(MUSIC_BPM_RANGE.min)
        .max(MUSIC_BPM_RANGE.max)
        .optional()
        .describe(`Tempo, ${MUSIC_BPM_RANGE.min} to ${MUSIC_BPM_RANGE.max} BPM. Default: the preset's.`),
      meter: z.int().min(MUSIC_METER_RANGE.min).max(MUSIC_METER_RANGE.max).default(4).describe("Beats per bar. Default 4."),
      bars: z.int().min(1).max(MUSIC_MAX_BARS).optional().describe("Length in bars, before the final hit and its ring."),
      length: z
        .number()
        .positive()
        .max(MUSIC_MAX_SECONDS)
        .optional()
        .describe("Length in seconds: the track gets the whole bars whose end (the final hit) is nearest to it. Not with `bars`."),
      sections: z
        .array(
          z.strictObject({
            kind: MusicSectionSchema,
            bars: z.int().min(1).max(MUSIC_MAX_BARS).optional().describe("Bars of this part. Default: up to the next part's `at`, or to the end for the last."),
            at: TimeRefParam("Timeline time this part starts at, moved to the nearest bar of the track. Default: right after the part before.").optional(),
          }),
        )
        .min(1)
        .max(MUSIC_LIMITS.sections)
        .optional()
        .describe("The parts in order; the first starts the track. Default: intro, full, build, drop, outro by length."),
      chords: z
        .array(z.string().regex(MUSIC_CHORD_PATTERN, "a root (`A`, `C#`, `Bb`) and a quality (`m`, `7`, `maj7`, `m7`, `9`, `m9`, `13`, `sus4`…)"))
        .min(1)
        .max(MUSIC_LIMITS.chords)
        .optional()
        .describe("One chord per bar, repeating, e.g. `[\"Am\", \"F\", \"C\", \"G\"]`; the melody uses the minor pentatonic of the first. Default: the preset's."),
      accents: z
        .array(TimeRefParam("Timeline time of an accent, moved to the nearest beat."))
        .min(1)
        .max(MUSIC_LIMITS.accents)
        .optional()
        .describe("Times that get a crash and a big kick (a logo, a call to action)."),
      seed: z.number().int().min(0).max(SFX_SEED_MAX).default(0).describe("Seed of the melody, grooves and noise: change it for another track with the same settings."),
      place: z.boolean().default(true).describe("Put the take on the timeline (default). False: only write and import it."),
      at: TimeRefParam("Timeline time the track starts at. Default 0.").default(0),
      track: z.string().min(1).optional().describe("Audio track for the clip, from `track.list`. Default: the audio track named `Music`, made when absent."),
      gain: z.number().min(-60).max(12).optional().describe("Clip gain in dB, replacing minus the style's `sound.musicUnderVoice`."),
    }),
    result: z.object({
      file: z.string().describe("The take, project-relative: `assets/sound/music-<preset>-<key>.wav`."),
      state: z.enum(["generated", "cached"]).describe("`generated`: written now. `cached`: the file already held this exact take."),
      preset: MusicPresetSchema,
      bpm: z.number(),
      meter: z.int(),
      bars: z.int().describe("Bars before the final hit."),
      seed: z.int(),
      chords: z.array(z.string()).describe("The chords played, one per bar, repeating."),
      sections: z
        .array(z.object({ kind: MusicSectionSchema, bars: z.int(), start: z.number().describe("Seconds into the take.") }))
        .describe("The parts as played."),
      duration: z.number().describe("Seconds of the take, the ring after the final hit included."),
      hitAt: z.number().describe("Seconds into the take of the final hit: the downbeat after the last bar. `music.fit` lands it on a cut."),
      lufs: z.number().describe("Integrated loudness, LUFS."),
      peakDb: z.number().describe("Sample peak, dBFS."),
      beats: z
        .object({
          file: z.string().describe("The beat grid, project-relative: `beats/<name>.beats.json`."),
          state: z.enum(["written", "kept"]).describe("`kept`: an exact grid for this take was already there (its `edits` too)."),
          count: z.int().describe("Beats in the grid, the final hit included."),
        })
        .describe("The exact beat grid of the take."),
      imported: z
        .array(z.object({ asset: z.string().describe("Project-relative take."), job: JobSchema }))
        .describe("The take when this call wrote it, imported; empty when `cached`. Follow its ingest with `job.list`."),
      credited: z.boolean().describe("The project's `credits.json` holds an `own` entry for the take. False when the project keeps no ledger."),
      timeline: z.string().nullable().describe("Timeline id; null with `place: false`."),
      revision: z.int().nullable().describe("Revision after the change; null with `place: false`."),
      tx: z.string().nullable().describe("Transaction holding the change (`revert` with it); null with `place: false`."),
      track: z
        .object({ id: z.string(), name: z.string().nullable(), created: z.boolean().describe("This call made the track.") })
        .nullable()
        .describe("Audio track of the new clip; null with `place: false`."),
      clip: z.string().nullable().describe("Id of the new clip; null with `place: false`."),
      start: z.number().nullable().describe("Timeline second the clip starts, on the frame grid."),
      gain: z.number().nullable().describe("Clip gain, dB."),
      tempo: z
        .enum(["set", "kept"])
        .nullable()
        .describe("`set`: the timeline's tempo now follows the new clip. `kept`: the timeline already had a tempo, left as it was. Null with `place: false`."),
      warnings: z.array(z.string()),
    }),
  },
} as const satisfies Record<string, MethodSpec>;
