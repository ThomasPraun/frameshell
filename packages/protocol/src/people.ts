import { z } from "zod";
import { PersonAngleLinkSchema, PersonFaceAnchorSchema, PersonIdSchema, PersonSchema, PersonSpeakerLinkSchema, SpeakerIdSchema } from "@frameshell/schema";

// People (ADR 0020): who is who across transcripts, multicam angles and faces, kept in `people.json`.

const Missing = {
  missing: z.boolean().describe("True when what the link points at is gone (file, speaker, timeline, group, angle). It stays in the file and is ignored."),
  reason: z.string().optional().describe("Why it is missing, when it is."),
};

/** A person's transcript speaker link as `people.list` reports it. */
export const PersonSpeakerInfoSchema = PersonSpeakerLinkSchema.extend(Missing);

/** A person's angle link as `people.list` reports it. */
export const PersonAngleInfoSchema = PersonAngleLinkSchema.extend(Missing);

/** A person's face anchor as `people.list` reports it. */
export const PersonFaceInfoSchema = PersonFaceAnchorSchema.extend(Missing);

/** One person with each link marked `missing` when its target is gone. */
export const PersonInfoSchema = PersonSchema.extend({
  speakers: z.array(PersonSpeakerInfoSchema),
  angles: z.array(PersonAngleInfoSchema),
  faces: z.array(PersonFaceInfoSchema),
});

/** See {@link PersonInfoSchema}. */
export type PersonInfo = z.output<typeof PersonInfoSchema>;

/** What a link or unlink names: a transcript speaker, a multicam angle or a face anchor (exactly one per call). */
export const PersonTargetParams = {
  speaker: z
    .strictObject({
      transcript: z.string().min(1).describe("Transcript file: project-relative (`transcripts/ep1.words.json`) or absolute."),
      speaker: SpeakerIdSchema.optional().describe("Speaker id in it, e.g. `s1`. Omit for every word of the transcript (a person's own mic)."),
    })
    .optional()
    .describe("A transcript speaker: the person's voice in one transcript."),
  angle: z
    .strictObject({
      timeline: z.string().min(1).describe("Timeline id, e.g. `main`."),
      group: z.string().min(1).describe("Multicam group id."),
      angle: z.string().min(1).describe("Angle id in that group."),
    })
    .optional()
    .describe("A multicam angle that is this person."),
  face: z
    .strictObject({
      asset: z.string().min(1).describe("Video file: project-relative (`assets/ep1.mp4`) or absolute."),
      at: z.number().nonnegative().describe("Source seconds where the face shows."),
      x: z.number().min(0).max(1).default(0.5).describe("Point of the face, fraction of the picture width. Default 0.5."),
      y: z.number().min(0).max(1).default(0.5).describe("Point of the face, fraction of the picture height. Default 0.5."),
    })
    .optional()
    .describe("A face anchor: where the person's face is in a video, one sample."),
};

/** Notification `people.changed` payload kinds. */
export const PEOPLE_CHANGES = ["add", "rename", "remove", "link", "unlink", "dismiss"] as const;

/** A face sample: the fields of a face anchor without `by`. */
export const FacePointSchema = PersonFaceAnchorSchema.pick({ asset: true, at: true, x: true, y: true });

/** A face as suggestions name it: a cluster of face tracks and the sample a confirmation anchors. */
export const SuggestedFaceSchema = z.object({
  cluster: z.string().describe("Face cluster id `fc_…`, for display: it changes when scans change."),
  anchor: FacePointSchema.describe(
    "The cluster's most central face sample: the face anchor a confirmation links. Show the frame at `at` to a person.",
  ),
  seconds: z.number().describe("Seconds the face is on screen across the scanned videos."),
});

/** One suggested link (ADR 0020 decision 5); applied only by `people.confirm`. */
export const PeopleSuggestionSchema = z.object({
  id: z.string().describe("`sg_` + 8 hex, the same for the same kind and targets on every run: pass it to `people.confirm`."),
  kind: z
    .enum(["speaker", "face", "face-speaker"])
    .describe(
      "`speaker`: a transcript speaker linked to nobody sounds like a person's linked voices. `face`: a face on screen for " +
        "10 s or more that nobody has: who it looks like, or nobody yet (\"Who is this?\"). `face-speaker`: in one video, " +
        "the face on screen for most of a speaker's time: the voice and the face are one person.",
    ),
  person: z
    .object({ id: PersonIdSchema, name: z.string() })
    .optional()
    .describe("The person to link to. Absent: nobody yet, so `people.confirm` needs `person` (a new name creates them)."),
  speaker: z
    .object({
      transcript: z.string().describe("Project-relative transcript file."),
      speaker: SpeakerIdSchema,
      name: z.string().describe("Its name in the transcript now."),
    })
    .optional()
    .describe("The transcript speaker to link (`speaker`, `face-speaker`)."),
  face: SuggestedFaceSchema.optional().describe("The face to link (`face`, `face-speaker`)."),
  links: z
    .array(z.enum(["speaker", "face"]))
    .describe("What confirming links: `speaker`, `face` or both (`face-speaker` with a new person); the other side is linked already."),
  score: z
    .number()
    .optional()
    .describe(
      "2 decimals. `speaker`: voice similarity (cosine of voice prints, about 0.7 and up). `face`: face similarity to the " +
        "person (cosine of face prints); absent when it names nobody. `face-speaker`: share of the speaker's time the face is on screen (0.6 and up).",
    ),
  reason: z.string().describe("One line for a person, e.g. `s2 (Speaker 2) in transcripts/ep2.words.json sounds like Juan (0.78).`"),
});

/** See {@link PeopleSuggestionSchema}. */
export type PeopleSuggestion = z.output<typeof PeopleSuggestionSchema>;

/** Params of `people.changed`. */
export const PeopleChangedSchema = z.object({
  project: z.string().describe("Absolute project root, as returned by `events.subscribe`."),
  change: z
    .enum(PEOPLE_CHANGES)
    .describe("What happened: a person was added, renamed or removed, a link was added or removed, or a suggestion was dismissed."),
  person: PersonIdSchema.optional().describe("Id of the person it happened to (`dismiss`: the person the suggestion named; absent when it named nobody)."),
});

/** One video of a `people.scan` result. */
export const PeopleScanAssetSchema = z.object({
  asset: z.string().describe("Project-relative, `/`-separated."),
  cached: z.boolean().describe("True when the scan of this content was already cached and nothing was decoded."),
  samples: z.int().nonnegative().describe("Frames looked at (2 per second of the video)."),
  tracks: z.int().nonnegative().describe("Faces followed over time: one track per person per stretch they stay on screen."),
  embeddings: z.int().nonnegative().describe("Face prints stored, at most one per track per second; faces under 32 px have none."),
});

/** Result of `people.scan`. */
export const PeopleScanResultSchema = z.object({
  dir: z.string().describe("Project root."),
  assets: z.array(PeopleScanAssetSchema).describe("Every video scanned or found cached, in the order asked (default: name order)."),
  warnings: z.array(z.string()).describe("Assets left out (no moving picture) and videos where no face was found."),
});
