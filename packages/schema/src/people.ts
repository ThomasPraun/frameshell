import { z } from "zod";
import { SCHEMA_VERSION, type ParseResult, formatIssues } from "./common.js";
import { SpeakerIdSchema } from "./transcript.js";

/** Canonical `$schema` URL for a project's `people.json`. */
export const PEOPLE_SCHEMA_URL = `https://frameshell.dev/schema/v${SCHEMA_VERSION}/people.json`;

/** Project-relative path of the optional people file (ADR 0020). */
export const PEOPLE_FILE = "people.json";

/** Person id: `p_` + hex when the core generates it; hand-written ids such as `p_juan` are accepted. */
export const PersonIdSchema = z.string().regex(/^p_[A-Za-z0-9][A-Za-z0-9_-]*$/, "must look like `p_3fa2c1`");

const By = z
  .string()
  .min(1)
  .optional()
  .describe("Author that confirmed the link when it was an agent, e.g. `agent:claude:s1`. Shown in the app; absent for a person's own links.");

/** A transcript speaker (or a whole transcript) that is this person's voice. */
export const PersonSpeakerLinkSchema = z.strictObject({
  transcript: z.string().min(1).describe("Project-relative transcript file, e.g. `transcripts/ep1.words.json`."),
  speaker: SpeakerIdSchema.optional().describe(
    "Speaker id in that transcript. Absent: every word of the transcript (a person's own mic, a talking head never diarized).",
  ),
  by: By,
});

/** A multicam angle that is this person. */
export const PersonAngleLinkSchema = z.strictObject({
  timeline: z.string().min(1).describe("Timeline id; the file is `timelines/<id>.json`."),
  group: z.string().min(1).describe("Multicam group id in that timeline."),
  angle: z.string().min(1).describe("Angle id in that group."),
  by: By,
});

/**
 * One face sample confirmed as this person's: a reference to where the face
 * is, never a face print. A later scan finds the face at that point.
 */
export const PersonFaceAnchorSchema = z.strictObject({
  asset: z.string().min(1).describe("Project-relative video file, e.g. `assets/ep1.mp4`."),
  at: z.number().nonnegative().describe("Source seconds of the sample."),
  x: z.number().min(0).max(1).describe("Point of the face, fraction of the picture width (0 left, 1 right)."),
  y: z.number().min(0).max(1).describe("Point of the face, fraction of the picture height (0 top, 1 bottom)."),
  by: By,
});

/** Someone in the footage and everything linked to them. */
export const PersonSchema = z.strictObject({
  id: PersonIdSchema.describe("Stable; commands take it or the exact name."),
  name: z.string().trim().min(1).describe("Free text, unique ignoring case in the file."),
  speakers: z.array(PersonSpeakerLinkSchema).default([]),
  angles: z.array(PersonAngleLinkSchema).default([]),
  faces: z.array(PersonFaceAnchorSchema).default([]),
});

/** Key two names are compared by: trimmed, case-folded. */
export function personNameKey(name: string): string {
  return name.trim().normalize("NFC").toLowerCase();
}

/** Key of a speaker link: a transcript, and one of its speakers or `*` for all of it. */
export function speakerLinkKey(link: { transcript: string; speaker?: string | undefined }): string {
  return `${link.transcript}\0${link.speaker ?? "*"}`;
}

/** Key of an angle link. */
export function angleLinkKey(link: { timeline: string; group: string; angle: string }): string {
  return `${link.timeline}\0${link.group}\0${link.angle}`;
}

/** Key of a face anchor. */
export function faceAnchorKey(anchor: { asset: string; at: number; x: number; y: number }): string {
  return `${anchor.asset}\0${anchor.at}\0${anchor.x}\0${anchor.y}`;
}

/** Who holds the links of one transcript: the person linked to all of it, and those linked to its speakers. */
interface TranscriptOwners {
  whole?: number;
  speakers: Set<number>;
}

/**
 * Zod model of `people.json` (SPEC §5.7, ADR 0020). Ids and names are unique
 * (names ignoring case); a transcript speaker, an angle or an anchor belongs
 * to at most one person, and a link to a whole transcript excludes other
 * people's speakers of it. Names and references only: no voice or face prints.
 */
export const PeopleFileSchema = z
  .strictObject({
    $schema: z.string().optional(),
    schemaVersion: z.literal(SCHEMA_VERSION),
    people: z.array(PersonSchema).default([]),
    dismissed: z.array(z.string().min(1)).default([]).describe('Ids of suggestions answered "no", so they are not asked again.'),
  })
  .superRefine((file, ctx) => {
    const ids = new Set<string>();
    const names = new Map<string, string>();
    const speakers = new Map<string, number>();
    const transcripts = new Map<string, TranscriptOwners>();
    const angles = new Map<string, number>();
    const faces = new Map<string, number>();
    const issue = (message: string, path: (string | number)[]) => ctx.addIssue({ code: "custom", message, path });
    const claim = (owners: Map<string, number>, key: string, person: number, path: (string | number)[], what: string) => {
      const owner = owners.get(key);
      if (owner === undefined) owners.set(key, person);
      else issue(`${what} is already linked to ${file.people[owner]!.name}`, path);
    };
    file.people.forEach((person, p) => {
      if (ids.has(person.id)) issue(`duplicate id "${person.id}"`, ["people", p, "id"]);
      ids.add(person.id);
      const key = personNameKey(person.name);
      const taken = names.get(key);
      if (taken !== undefined) issue(`name "${person.name}" is already taken by "${taken}" (names are unique ignoring case)`, ["people", p, "name"]);
      else names.set(key, person.name);
      person.speakers.forEach((link, l) => {
        const path = ["people", p, "speakers", l];
        claim(speakers, speakerLinkKey(link), p, path, link.speaker ? `speaker ${link.speaker} of ${link.transcript}` : `all of ${link.transcript}`);
        const owners = transcripts.get(link.transcript) ?? { speakers: new Set<number>() };
        transcripts.set(link.transcript, owners);
        const others = (link.speaker === undefined ? [...owners.speakers] : owners.whole === undefined ? [] : [owners.whole]).filter((owner) => owner !== p);
        if (others.length > 0) issue(`${link.transcript} is already linked to ${file.people[others[0]!]!.name}`, path);
        if (link.speaker === undefined) owners.whole = p;
        else owners.speakers.add(p);
      });
      person.angles.forEach((link, l) =>
        claim(angles, angleLinkKey(link), p, ["people", p, "angles", l], `angle ${link.angle} of group ${link.group} in timeline ${link.timeline}`),
      );
      person.faces.forEach((anchor, f) =>
        claim(faces, faceAnchorKey(anchor), p, ["people", p, "faces", f], `the face at ${anchor.asset} ${anchor.at} s (${anchor.x}, ${anchor.y})`),
      );
    });
  });

/** Validated `people.json` content. */
export type PeopleFile = z.output<typeof PeopleFileSchema>;

/** One person of a {@link PeopleFile}. */
export type Person = PeopleFile["people"][number];

/** A transcript speaker link of a {@link Person}. */
export type PersonSpeakerLink = Person["speakers"][number];

/** A multicam angle link of a {@link Person}. */
export type PersonAngleLink = Person["angles"][number];

/** A face anchor of a {@link Person}. */
export type PersonFaceAnchor = Person["faces"][number];

/** A file with nobody in it, as the daemon writes it first. */
export function createPeopleFile(): PeopleFile {
  return { $schema: PEOPLE_SCHEMA_URL, schemaVersion: SCHEMA_VERSION, people: [], dismissed: [] };
}

/** The person `ref` names: an id, else a name (ignoring case); undefined when none. */
export function findPerson(file: Pick<PeopleFile, "people">, ref: string): Person | undefined {
  return file.people.find((person) => person.id === ref) ?? file.people.find((person) => personNameKey(person.name) === personNameKey(ref));
}

/** Validate unknown input as `people.json`. Never throws. */
export function parsePeopleFile(input: unknown): ParseResult<PeopleFile> {
  const result = PeopleFileSchema.safeParse(input);
  return result.success ? { ok: true, value: result.data } : { ok: false, error: formatIssues(result.error) };
}
