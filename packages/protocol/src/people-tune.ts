import { z } from "zod";

// `people.tune` (ADR 0020 decision 15): how the suggestion thresholds do on the people the owner confirmed.

/** Spread of a set of similarity scores (cosine, -1..1), 4 decimals. */
export const TuneDistributionSchema = z.object({
  count: z.int().positive(),
  min: z.number(),
  p10: z.number(),
  median: z.number(),
  p90: z.number(),
  max: z.number(),
  mean: z.number(),
});

/** See {@link TuneDistributionSchema}. */
export type TuneDistribution = z.output<typeof TuneDistributionSchema>;

/** One line of a threshold sweep: what a (match, margin) pair would have suggested over the labelled material. */
export const TuneSweepRowSchema = z.object({
  match: z.number().describe("Lowest similarity suggested."),
  margin: z.number().describe("How far the best person must be ahead of the second best."),
  suggested: z.int().nonnegative().describe("Suggestions made."),
  correct: z.int().nonnegative().describe("Suggestions naming the labelled person."),
  wrong: z.int().nonnegative().describe("Suggestions naming someone else (or anyone, when the labelled person had no other print to match against)."),
  precision: z.number().nullable().describe("correct / suggested; null when nothing was suggested."),
  recall: z.number().nullable().describe("correct / the cases a correct suggestion was possible for; null when there are none."),
});

/** See {@link TuneSweepRowSchema}. */
export type TuneSweepRow = z.output<typeof TuneSweepRowSchema>;

/** A suggestion the current constants get wrong. */
export const TuneWrongSchema = z.object({
  subject: z.string().describe("What was matched: a transcript speaker, or a face cluster's anchored tracks."),
  expected: z.string().describe("Its labelled person's name, or `nobody` when that person had nothing else to match."),
  suggested: z.string().describe("The person suggested instead."),
  score: z.number(),
});

/** See {@link TuneWrongSchema}. */
export type TuneWrong = z.output<typeof TuneWrongSchema>;

const TuneCurrentSchema = z.object({ match: z.number(), margin: z.number() });

/** Voice part of `people.tune`. */
export const TuneVoiceSchema = z.object({
  speakers: z.int().nonnegative().describe("Linked speakers with a cached voice print."),
  people: z.int().nonnegative().describe("People with at least one."),
  usable: z.int().nonnegative().describe("Speakers whose person has another print to compare with: the cases a correct suggestion is possible for."),
  same: TuneDistributionSchema.nullable().describe("Similarity of two prints of one person."),
  different: TuneDistributionSchema.nullable().describe("Similarity of two prints of different people."),
  gap: z.number().nullable().describe("Lowest same-person score minus highest different-person score: above 0, one line separates them."),
  margin: TuneDistributionSchema.nullable().describe("Per usable speaker: its person's score minus the best other person's (negative: an impostor sounds closer)."),
  current: TuneCurrentSchema.describe("`SPEAKER_MATCH` and `SPEAKER_MARGIN` now."),
  rows: z.array(TuneSweepRowSchema).describe("Every match and margin tried."),
  wrong: z.array(TuneWrongSchema).describe("Wrong suggestions at the current constants."),
});

/** See {@link TuneVoiceSchema}. */
export type TuneVoice = z.output<typeof TuneVoiceSchema>;

/** One line of the face cluster sweep. */
export const TuneClusterRowSchema = z.object({
  match: z.number().describe("Cluster cut: lowest average similarity at which two groups of tracks are one face."),
  clusters: z.int().nonnegative().describe("Clusters the project's face tracks form at this cut."),
  purity: z.number().nullable().describe("Share of labelled tracks that sit in the biggest labelled person of their cluster; 1: no cluster mixes people. Null without labelled tracks."),
  mixed: z.int().nonnegative().describe("Clusters holding labelled tracks of more than one person (two people merged)."),
  splits: z.int().nonnegative().describe("Extra clusters of the same labelled person, summed over people (one person split in pieces)."),
});

/** See {@link TuneClusterRowSchema}. */
export type TuneClusterRow = z.output<typeof TuneClusterRowSchema>;

/** Face part of `people.tune`. */
export const TuneFacesSchema = z.object({
  tracks: z.int().nonnegative().describe("Face tracks a person's face anchor names: the labels. Tracks only a cluster ties to a person are not used."),
  people: z.int().nonnegative().describe("People with at least one."),
  same: TuneDistributionSchema.nullable().describe("Similarity of two labelled tracks of one person."),
  different: TuneDistributionSchema.nullable().describe("Similarity of two labelled tracks of different people."),
  gap: z.number().nullable().describe("Lowest same-person score minus highest different-person score."),
  clusterCurrent: z.number().describe("`FACE_CLUSTER_MATCH` now."),
  clusterRows: z.array(TuneClusterRowSchema),
  person: z
    .object({
      clusters: z.int().nonnegative().describe("Clusters at the current cut holding labelled tracks of one person: each is matched against the labelled tracks outside it."),
      usable: z.int().nonnegative().describe("Of those, clusters whose person has a labelled track outside it."),
      margin: TuneDistributionSchema.nullable().describe("Per usable cluster: its person's score minus the best other person's."),
      current: TuneCurrentSchema.describe("`FACE_PERSON_MATCH` and `FACE_PERSON_MARGIN` now."),
      rows: z.array(TuneSweepRowSchema),
      wrong: z.array(TuneWrongSchema),
    })
    .describe("Face cluster to person suggestions."),
});

/** See {@link TuneFacesSchema}. */
export type TuneFaces = z.output<typeof TuneFacesSchema>;

/** Result of `people.tune`. */
export const PeopleTuneResultSchema = z.object({
  dir: z.string().describe("Project root."),
  voice: TuneVoiceSchema.nullable().describe("Null when fewer than two people have a cached voice print."),
  faces: TuneFacesSchema.nullable().describe("Null when fewer than two people have a face anchor on a scanned face."),
  timings: z.object({ voicesMs: z.number(), facesMs: z.number(), sweepMs: z.number() }).describe("Milliseconds spent reading cached voice prints, reading and clustering face scans, and running the sweeps."),
  hints: z.array(z.string()).describe("What is missing for each part, with the command that makes it."),
});

/** See {@link PeopleTuneResultSchema}. */
export type PeopleTuneResult = z.output<typeof PeopleTuneResultSchema>;
