import type { PeopleSuggestion } from "@frameshell/protocol";
import { type Person, type Transcript, speakerLinkKey, wordSpeaker } from "@frameshell/schema";
import { type ClusterTrack, type FaceCluster, type FaceModel, type FaceOwners, overlapSeconds, personFacePrint, presence, spanSeconds } from "./face-clusters.js";
import { mergeSpans } from "./ranges.js";
import { suggestionId } from "./suggest.js";
import { cosine } from "./vector.js";

/** A face nobody has is asked about once on screen this long (ADR 0020 decision 5): shorter ones are extras. */
export const FACE_MIN_SCREEN_S = 10;
/**
 * Lowest similarity of a face cluster to a person's faces (cosine of mean
 * prints) suggested as that person. Below `FACE_CLUSTER_MATCH` on purpose:
 * a cluster this close was not merged, so a person decides.
 * Placeholder until tuned on real recordings.
 */
export const FACE_PERSON_MATCH = 0.4;
/** The best person must beat the second best by this much, or the face is asked about with nobody named. */
export const FACE_PERSON_MARGIN = 0.1;
/** Share of a speaker's time one face must be on screen to be suggested as that speaker (ADR 0020 decision 5). */
export const FACE_SPEAKER_SHARE = 0.6;
/** A speaker with less speech than this (seconds) gives too little to tie to a face. */
export const FACE_SPEAKER_MIN_S = 3;

/** What {@link faceSuggestions} reads. */
export interface FaceSuggestInput {
  model: FaceModel;
  owners: FaceOwners;
  people: readonly Person[];
  /** Valid transcripts by project-relative path. */
  transcripts: ReadonlyMap<string, Transcript>;
}

/**
 * `face` and `face-speaker` suggestions (ADR 0020 decision 5), dismissed ones
 * included, best first within each kind, and hints for transcripts that
 * cannot be compared with a scan.
 */
export function faceSuggestions(input: FaceSuggestInput): { suggestions: PeopleSuggestion[]; hints: string[] } {
  const hints: string[] = [];
  const named = new Map(input.people.map((person) => [person.id, person]));
  const owned = new Set([...input.owners.tracks.values()].flat());
  const pairs = coSpeakers(input, hints, named, owned);
  const faces = newFaces(input, named, owned);
  return { suggestions: [...pairs, ...faces], hints };
}

/** `face`: clusters nobody has, on screen {@link FACE_MIN_SCREEN_S} or more, named after the closest person when clear. */
function newFaces({ model, owners }: FaceSuggestInput, named: Map<string, Person>, owned: Set<ClusterTrack>): PeopleSuggestion[] {
  const prints = [...owners.tracks].flatMap(([id, tracks]) => {
    const print = personFacePrint(tracks);
    const person = named.get(id);
    return print && person ? [{ person, print }] : [];
  });
  const suggestions: PeopleSuggestion[] = [];
  for (const cluster of model.clusters) {
    if (cluster.seconds < FACE_MIN_SCREEN_S || cluster.tracks.some((track) => owned.has(track))) continue;
    const ranked = prints.map(({ person, print }) => ({ person, score: cosine(cluster.mean, print) })).sort((a, b) => b.score - a.score);
    const [best, second] = ranked;
    const face = suggestedFace(cluster);
    if (best && best.score >= FACE_PERSON_MATCH && (!second || best.score - second.score >= FACE_PERSON_MARGIN)) {
      const score = round2(best.score);
      suggestions.push({
        id: suggestionId("face", [best.person.id, cluster.handle]),
        kind: "face",
        person: { id: best.person.id, name: best.person.name },
        face,
        links: ["face"],
        score,
        reason: `The face at ${where(face.anchor)} (${seconds(cluster.seconds)} on screen) looks like ${best.person.name} (${score.toFixed(2)}).`,
      });
      continue;
    }
    suggestions.push({
      id: suggestionId("face", [cluster.handle]),
      kind: "face",
      face,
      links: ["face"],
      reason: `Who is this? A face nobody has, ${seconds(cluster.seconds)} on screen, e.g. at ${where(face.anchor)}.`,
    });
  }
  return suggestions.sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || b.face!.seconds - a.face!.seconds || a.id.localeCompare(b.id));
}

/**
 * `face-speaker`: per scanned video and diarized transcript of it, the one
 * cluster on screen for {@link FACE_SPEAKER_SHARE} of a speaker's words,
 * when the two sides are not one person already and not two different ones.
 */
function coSpeakers({ model, owners, people, transcripts }: FaceSuggestInput, hints: string[], named: Map<string, Person>, owned: Set<ClusterTrack>): PeopleSuggestion[] {
  const speakerOwner = new Map<string, Person>();
  for (const person of people) for (const link of person.speakers) speakerOwner.set(speakerLinkKey(link), person);
  const suggestions: PeopleSuggestion[] = [];
  for (const [rel, transcript] of transcripts) {
    const scan = model.scans.get(transcript.asset);
    if (!scan) continue;
    if (!transcript.speakers?.length) {
      hints.push(`${rel} has no speakers, so its voices are not matched with faces: frameshell transcribe --speakers ${transcript.asset}`);
      continue;
    }
    if (transcript.assetHash !== scan.hash) {
      hints.push(`${rel} is stale: ${transcript.asset} changed after it was transcribed: its speakers are not matched with faces.`);
      continue;
    }
    const clusters = model.clusters.map((cluster) => ({ cluster, spans: presence(cluster.tracks, transcript.asset) })).filter((entry) => entry.spans.length > 0);
    for (const speaker of transcript.speakers) {
      const talk = mergeSpans(
        transcript.words
          .filter((word) => wordSpeaker(transcript, word) === speaker.id && transcript.edits[word.id]?.text !== "")
          .map((word) => ({ start: word.start, end: word.end })),
      );
      const total = spanSeconds(talk);
      if (total < FACE_SPEAKER_MIN_S) continue;
      const shares = clusters.map(({ cluster, spans }) => ({ cluster, share: overlapSeconds(talk, spans) / total })).filter((entry) => entry.share >= FACE_SPEAKER_SHARE);
      if (shares.length !== 1) continue;
      const { cluster, share } = shares[0]!;
      const voice = speakerOwner.get(speakerLinkKey({ transcript: rel, speaker: speaker.id })) ?? speakerOwner.get(speakerLinkKey({ transcript: rel }));
      const faceOwnerId = owners.clusters.get(cluster.id);
      // Split between people, or partly owned: not one face to name.
      if (!faceOwnerId && cluster.tracks.some((track) => owned.has(track))) continue;
      const faceOwner = faceOwnerId ? named.get(faceOwnerId) : undefined;
      if (voice && faceOwner) continue;
      const person = voice ?? faceOwner;
      const face = suggestedFace(cluster);
      const score = round2(share);
      const percent = `${Math.round(share * 100)}%`;
      const said = `${speaker.id} (${speaker.name}) in ${rel}`;
      suggestions.push({
        id: suggestionId("face-speaker", [person?.id ?? "", rel, speaker.id, cluster.handle]),
        kind: "face-speaker",
        ...(person ? { person: { id: person.id, name: person.name } } : {}),
        speaker: { transcript: rel, speaker: speaker.id, name: speaker.name },
        face,
        links: voice ? ["face"] : faceOwner ? ["speaker"] : ["speaker", "face"],
        score,
        reason: voice
          ? `The face at ${where(face.anchor)} is on screen for ${percent} of ${voice.name}'s speech as ${said}: it may be ${voice.name}.`
          : faceOwner
            ? `${faceOwner.name}'s face is on screen for ${percent} of ${said}: that voice may be ${faceOwner.name}.`
            : `The face at ${where(face.anchor)} is on screen for ${percent} of ${said}: one person nobody has yet. Who is it?`,
      });
    }
  }
  return suggestions.sort((a, b) => b.score! - a.score! || Number(b.person !== undefined) - Number(a.person !== undefined) || a.id.localeCompare(b.id));
}

function suggestedFace(cluster: FaceCluster): NonNullable<PeopleSuggestion["face"]> {
  return { cluster: cluster.id, anchor: cluster.anchor, seconds: cluster.seconds };
}

function where(anchor: { asset: string; at: number }): string {
  return `${anchor.asset} ${anchor.at} s`;
}

function seconds(value: number): string {
  return `${Math.round(value)} s`;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
