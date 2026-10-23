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
export const PEOPLE_CHANGES = ["add", "rename", "remove", "link", "unlink"] as const;

/** Params of `people.changed`. */
export const PeopleChangedSchema = z.object({
  project: z.string().describe("Absolute project root, as returned by `events.subscribe`."),
  change: z.enum(PEOPLE_CHANGES).describe("What happened: a person was added, renamed or removed, or a link was added or removed."),
  person: PersonIdSchema.describe("Id of the person it happened to."),
});
