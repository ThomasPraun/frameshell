import { z } from "zod";
import {
  FacePointSchema,
  PeopleScanResultSchema,
  PeopleSuggestionSchema,
  PersonInfoSchema,
  PersonTargetParams,
} from "../people.js";
import { PeopleTuneResultSchema } from "../people-tune.js";
import { TimelineIdSchema } from "../timeline.js";
import { type MethodSpec, CwdParam } from "./shared.js";

/** Daemon methods: people, face scans and speaker suggestions. */
export const peopleMethods = {
  "people.list": {
    description:
      "The project's people (ADR 0020, `people.json`): who is who across transcripts, multicam angles and faces. Each " +
      "person has an id (`p_3fa2c1`), a unique name and links: `speakers` (a transcript and one of its speaker ids, or " +
      "every word of it), `angles` (timeline, group, angle) and `faces` (anchors: video, second, point of the face). A " +
      "link whose target is gone (transcript, speaker, timeline, group, angle or video) has `missing: true` and a " +
      "`reason`; it is ignored, never removed (a later run may bring it back). `dismissed` holds suggestion ids " +
      "answered \"no\". Empty `people` when the project has no `people.json`: everything works without it. Fails " +
      "with InvalidProjectFile when the file is invalid.",
    params: z.strictObject({ cwd: CwdParam }),
    result: z.object({
      dir: z.string().describe("Project root."),
      people: z.array(PersonInfoSchema).describe("In file order."),
      dismissed: z.array(z.string()),
    }),
  },
  "people.add": {
    mutating: true,
    description:
      "Add a person to `people.json` (created when missing) with no links yet; link voices, angles and faces with " +
      "`people.link`. `name` is free text, unique ignoring case. The id is generated (`p_` + 6 hex). Example: " +
      "`{ name: \"Juan\" }`. Fails with InvalidOperation (reason `name taken`, naming who has it) or InvalidProjectFile.",
    params: z.strictObject({ cwd: CwdParam, name: z.string().trim().min(1).describe("Display name, e.g. `Juan`.") }),
    result: z.object({ dir: z.string().describe("Project root."), person: PersonInfoSchema }),
  },
  "people.rename": {
    mutating: true,
    description:
      "Rename a person. Every transcript speaker linked to them gets the new name in its transcript's `speakers` " +
      "list too, so subtitles, export and anyone reading a words file see it (`transcripts` lists the files " +
      "written). Linked transcripts that are missing or invalid are listed in `skipped` and left alone; angle names " +
      "are not rewritten (that is a timeline edit: use `multicam.angle`). `person` is an id or the exact name. " +
      "Example: `{ person: \"Juan\", name: \"Juan Pérez\" }`. Fails with InvalidOperation (reason `unknown person` or " +
      "`name taken`) or InvalidProjectFile.",
    params: z.strictObject({
      cwd: CwdParam,
      person: z.string().min(1).describe("Person id (`p_3fa2c1`) or exact name (ignoring case)."),
      name: z.string().trim().min(1).describe("New display name, unique ignoring case."),
    }),
    result: z.object({
      dir: z.string().describe("Project root."),
      person: PersonInfoSchema,
      previous: z.string().describe("The name before."),
      transcripts: z.array(z.string()).describe("Transcript files whose speaker name was set to the new name."),
      skipped: z
        .array(z.object({ transcript: z.string(), reason: z.string() }))
        .describe("Linked transcripts the name could not be written to, and why. Empty when all went well."),
    }),
  },
  "people.remove": {
    mutating: true,
    description:
      "Remove a person and all their links from `people.json`. Transcript speaker names already written stay as " +
      "they are. `removed` is the person as they were, links included, so a mistake is undone by `people.add` and " +
      "`people.link` again. `person` is an id or the exact name. Fails with InvalidOperation (reason `unknown " +
      "person`) or InvalidProjectFile.",
    params: z.strictObject({ cwd: CwdParam, person: z.string().min(1).describe("Person id or exact name.") }),
    result: z.object({ dir: z.string().describe("Project root."), removed: PersonInfoSchema }),
  },
  "people.link": {
    mutating: true,
    description:
      "Link something to a person: pass exactly one of `speaker` (a transcript speaker, or a whole transcript with " +
      "no `speaker`), `angle` (timeline, group, angle id) or `face` (an anchor: video, source second, and the point " +
      "of the face as fractions of the picture, default the center). The target must exist now. A speaker, angle or " +
      "anchor belongs to at most one person; a whole transcript excludes other people's speakers of it. Linking a " +
      "transcript speaker writes the person's name into that transcript's `speakers` entry (`transcripts`), so " +
      "subtitles and export show it; angle names are not rewritten. Linking what is already theirs changes nothing " +
      "(`linked: false`). Called by an agent, the link records it in `by`. Example: `{ person: \"Juan\", speaker: " +
      "{ transcript: \"transcripts/ep1.words.json\", speaker: \"s1\" } }`. Fails with InvalidOperation (reason " +
      "`unknown person`, `bad target`, `target missing` or `already linked`, naming the owner) or InvalidProjectFile.",
    params: z
      .strictObject({
        cwd: CwdParam,
        person: z.string().min(1).describe("Person id or exact name."),
        ...PersonTargetParams,
      })
      .refine((params) => [params.speaker, params.angle, params.face].filter((target) => target !== undefined).length === 1, {
        message: "pass exactly one of `speaker`, `angle` or `face`",
      }),
    result: z.object({
      dir: z.string().describe("Project root."),
      person: PersonInfoSchema,
      linked: z.boolean().describe("False when the link already existed."),
      transcripts: z.array(z.string()).describe("Transcript files whose speaker name was set to the person's name."),
    }),
  },
  "people.unlink": {
    mutating: true,
    description:
      "Remove one link from a person: pass exactly one of `speaker`, `angle` or `face`, as `people.link` took it " +
      "(a face by its asset, `at`, `x` and `y`). Works when the target is gone. The name already written into a " +
      "transcript stays. Fails with InvalidOperation (reason `unknown person`, `bad target` or `not linked`, " +
      "listing the person's links) or InvalidProjectFile.",
    params: z
      .strictObject({
        cwd: CwdParam,
        person: z.string().min(1).describe("Person id or exact name."),
        ...PersonTargetParams,
      })
      .refine((params) => [params.speaker, params.angle, params.face].filter((target) => target !== undefined).length === 1, {
        message: "pass exactly one of `speaker`, `angle` or `face`",
      }),
    result: z.object({ dir: z.string().describe("Project root."), person: PersonInfoSchema }),
  },
  "people.scan": {
    description:
      "Find the faces in video assets so people can be recognized (ADR 0020), locally on CPU: 2 frames per second, the YuNet " +
      "detector then the SFace recognizer (ONNX Runtime; the first run downloads about 39 MB of models from OpenCV's model " +
      "zoo), the same face joined over time into tracks, one 128-number face print per track per second for faces of at " +
      "least 32 px. Never run on import: ask for it. Default: every video in `assets/` (still pictures are skipped). " +
      "The result is cached per file content in `.frameshell/people/` (regenerable, swept by `gc`, never read by " +
      "`people.json`): a video already scanned is not decoded again unless `force: true`. Nothing is linked to anyone; " +
      "`people.link` does that. Takes about 5 minutes per hour of footage with one face; progress " +
      "arrives as `progress` notifications. It runs as a background job of kind `people` (`job.list`), so it goes on if " +
      "the caller disconnects. Example: `{ assets: [\"assets/ep1.mp4\"] }`. Fails with AssetNotFound, InvalidOperation " +
      "(reason `bad target`: an asset outside the project), or the Binary* errors when ffmpeg, ONNX Runtime or a model " +
      "cannot be fetched.",
    params: z.strictObject({
      cwd: CwdParam,
      assets: z
        .array(z.string().min(1))
        .min(1)
        .optional()
        .describe("Videos to scan: project-relative (`assets/ep1.mp4`) or absolute. Default: every video in `assets/`."),
      force: z.boolean().optional().describe("Scan again even when the content's scan is cached. Default false."),
    }),
    result: PeopleScanResultSchema,
  },
  "people.ranges": {
    description:
      "When a person speaks or is on screen on a timeline (ADR 0020): merged `spans` `{ start, end }` in timeline seconds, " +
      "sorted, pauses under 0.5 s bridged, with their `total`. `kind` `speaks` (default): the words of the person's linked " +
      "transcript speakers placed by the clips that play their video or audio (in, out, speed and cuts honoured; nested " +
      "timelines flattened; a mic's words through the shots) plus the speaking turns of their linked multicam angles inside " +
      "the program track's shots. `onscreen`: the shots that show one of their angles, plus their faces (`people.scan`; the " +
      "faces their face anchors name, and the faces clustered with those) placed by the video clips that show each video, " +
      "0.25 s either side of each face sample. Clips covered by a layer above are not subtracted; on a program track only " +
      "the shot's angles count. Spans are timeline seconds NOW: to cut several out with `ripple`, go from the " +
      "last span to the first so earlier spans keep their times. Links whose target is gone are skipped with a `warnings` " +
      "line. Read-only. Fails with InvalidOperation (reason `unknown person`), InvalidProjectFile or TimelineNotFound.",
    params: z.strictObject({
      cwd: CwdParam,
      person: z.string().min(1).describe("Person id or exact name."),
      kind: z.enum(["speaks", "onscreen"]).default("speaks").describe("`speaks` (default) or `onscreen`."),
      timeline: TimelineIdSchema,
    }),
    result: z.object({
      dir: z.string().describe("Project root."),
      person: z.object({ id: z.string(), name: z.string() }),
      kind: z.enum(["speaks", "onscreen"]),
      timeline: z.string(),
      spans: z.array(z.object({ start: z.number(), end: z.number() })).describe("Timeline seconds, sorted, disjoint."),
      total: z.number().describe("Seconds covered by `spans`."),
      warnings: z.array(z.string()),
    }),
  },
  "people.suggest": {
    description:
      "Links Frameshell suggests and nobody confirmed yet (ADR 0020); nothing is linked until `people.confirm`. Kind " +
      "`speaker`: a transcript speaker linked to nobody whose voice sounds like one person's linked speakers (voice " +
      "prints: CAM++ embeddings of each speaker's longest stretches alone, computed locally on first use, a few " +
      "seconds per transcript, then cached in `.frameshell/people/voices/`; the speaker model is downloaded once); at " +
      "most one per speaker. Faces come from `people.scan` (cached scans only; this never scans): face tracks of every " +
      "video are clustered by face print, and a face anchor makes its cluster the person's. Kind `face`: a face on " +
      "screen for 10 s or more that nobody has, with the person it looks like or none (ask \"Who is this?\" and show " +
      "the frame at `face.anchor`). Kind `face-speaker`: in a video with a diarized transcript, the face on screen for " +
      "60% or more of a speaker's time (and the only one): the voice and the face are one person, joined to the person " +
      "either side already has, or a new one. Kind `angle`: a multicam angle (not a screen) linked to nobody: the person " +
      "named like it ignoring case, or a new person with its name, plus the angle's voice (its `speaker`, else the " +
      "speaker holding 80% of its sound's words, else the whole transcript of a mic of its own) and, when videos were " +
      "scanned, the face most on screen in that angle; one confirmation links all of it. Kind `script` (shoots, ADR 0024): a " +
      "transcript speaker, or a whole transcript without speakers (your own mic), that says 80% or more of its words in a " +
      "shoot script's lines of one `**Name:**` (at least 5 words, takes compared with their transcripts): the person of " +
      "that name, or a new one with it; then `speaker` deviations of those takes name that person. Suggestions answered \"no\" (`dismissed`) are left out. `hints` say what " +
      "keeps voices or faces from being matched: no person has a linked speaker yet, a transcript has no speakers (run " +
      "`transcribe.speakers`), is stale, a speaker says too little, a video has no face scan (run `people.scan`), or a " +
      "face anchor names no face. Confirm only what the person agreed to or what is certain.",
    params: z.strictObject({
      cwd: CwdParam,
      download: z
        .boolean()
        .default(true)
        .describe(
          "Download the voice model (CAM++ and ONNX Runtime Web, about 60 MB, once) when voices must be compared and it " +
            "is missing. Default true. False: voices are left out instead and `voiceDownload` says what it would fetch.",
        ),
    }),
    result: z.object({
      dir: z.string().describe("Project root."),
      suggestions: z.array(PeopleSuggestionSchema),
      hints: z.array(z.string()).describe("Why some voices or faces could not be compared, with the command that fixes it. Empty when none."),
      voiceDownload: z
        .object({ bytes: z.int().nonnegative().describe("Bytes still to download.") })
        .optional()
        .describe("Only with `download: false`: voices were left out because the voice model is not downloaded yet."),
    }),
  },
  "people.tune": {
    description:
      "Tuning report for the suggestion thresholds (ADR 0020 decision 15), read-only: it replays voice and face matching " +
      "on what people confirmed and says how each threshold would have done. Truth is `people.json`: every linked " +
      "speaker with a cached voice print, and every face track a face anchor names. Voices: each linked speaker is " +
      "matched, as `people.suggest` does, against each person's voice made of their other prints; the result has the " +
      "same-person and different-person score spreads, and for every `SPEAKER_MATCH` and `SPEAKER_MARGIN` tried the " +
      "suggestions made, how many were correct or wrong, precision and recall. Faces: the clusters at every " +
      "`FACE_CLUSTER_MATCH` tried (purity, clusters mixing two people, people split in pieces), and each cluster at the " +
      "current cut matched to a person for every `FACE_PERSON_MATCH` and `FACE_PERSON_MARGIN`. `timings` are in ms. " +
      "Nothing is changed, scanned, queued or downloaded: voice prints not cached (`people.suggest` makes them) and videos " +
      "without a face scan (`people.scan`) are left out and named in `hints`. `voice` or `faces` is null when fewer than " +
      "two people can be compared. Results are scores only: no recording leaves the project. Fails with " +
      "InvalidProjectFile when `people.json` is invalid.",
    params: z.strictObject({ cwd: CwdParam }),
    result: PeopleTuneResultSchema,
  },
  "people.confirm": {
    mutating: true,
    description:
      "Answer suggestions from `people.suggest` by id: yes applies each one's links (as `people.link`: a speaker's " +
      "person's name is written into the transcript, a face is linked as a face anchor at `face.anchor`; called by an " +
      "agent, the link records it in `by`), `reject: true` adds the ids to `dismissed` in `people.json` so they are not " +
      "suggested again. A suggestion without `person` (a new face, or a voice and face nobody has) needs `person`: an " +
      "existing person, or a new name, which adds that person (an `angle` suggestion without `person` adds a person named like the angle, a `script` one a person named like its `**Name:**`). Ids are checked against the current suggestions first: " +
      "one no longer suggested, or one needing `person` without it, fails the call before anything changes. Undo a yes " +
      "with `people.unlink` (and `people.remove` for a person it added). Example: `{ suggestions: [\"sg_9c04e1d2\"] }`, " +
      "`{ suggestions: [\"sg_51aa07c3\"], person: \"Ana\" }`. Fails with InvalidOperation (reason `unknown suggestion`, " +
      "`needs person`, or a `people.add` or `people.link` reason) or InvalidProjectFile.",
    params: z.strictObject({
      cwd: CwdParam,
      suggestions: z
        .array(z.string().regex(/^sg_[0-9a-f]{8}$/, "must look like `sg_9c04e1d2`"))
        .min(1)
        .describe("Suggestion ids from `people.suggest`."),
      reject: z.boolean().default(false).describe("True dismisses them instead of linking. Default false."),
      person: z
        .string()
        .trim()
        .min(1)
        .optional()
        .describe("For suggestions that name no person: who it is, by id or exact name; a name nobody has adds that person. Ignored by the others."),
    }),
    result: z.object({
      dir: z.string().describe("Project root."),
      confirmed: z
        .array(
          z.object({
            id: z.string(),
            person: z.object({ id: z.string(), name: z.string() }),
            added: z.boolean().describe("True when the person was added by this confirmation (`person` named nobody)."),
            speaker: z.object({ transcript: z.string(), speaker: z.string().optional() }).optional().describe("The speaker linked, when the suggestion linked one (no `speaker`: the whole transcript)."),
            angle: z.object({ timeline: z.string(), group: z.string(), angle: z.string() }).optional().describe("The angle linked, when the suggestion linked one."),
            face: FacePointSchema.optional().describe("The face anchor linked, when the suggestion linked one."),
            linked: z.boolean().describe("False when every link already existed."),
            transcripts: z.array(z.string()).describe("Transcript files whose speaker name was set to the person's name."),
          }),
        )
        .describe("Links applied, in request order. Empty with `reject`."),
      dismissed: z.array(z.string()).describe("Ids added to `dismissed`. Empty without `reject`."),
    }),
  },
} as const satisfies Record<string, MethodSpec>;
