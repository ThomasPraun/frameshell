import type { PeopleSuggestion } from "@frameshell/protocol";
import { type Angle, type MulticamGroup, type Person, type Timeline, type Transcript, angleLinkKey, personNameKey, speakerLinkKey, wordSpeaker } from "@frameshell/schema";
import { type FaceCluster, type FaceModel, type FaceOwners, presence, spanSeconds } from "./face-clusters.js";
import { FACE_SPEAKER_MIN_S, FACE_SPEAKER_SHARE } from "./face-suggest.js";
import { suggestionId } from "./suggest.js";

/** Share of the words of an angle's sound one diarized speaker must hold to be taken as the angle's person (ADR 0020 decision 5). */
export const ANGLE_SPEAKER_SHARE = 0.8;

/** What {@link angleSuggestions} reads. */
export interface AngleSuggestInput {
  /** Valid timelines by id (file name without `.json`), sorted. */
  timelines: ReadonlyMap<string, Timeline>;
  people: readonly Person[];
  /** Valid transcripts by project-relative path. */
  transcripts: ReadonlyMap<string, Transcript>;
  model: FaceModel;
  owners: FaceOwners;
}

/**
 * `angle` suggestions (ADR 0020 decision 5), dismissed ones included, in
 * timeline, group and angle order: each angle that is not a screen and has no
 * person gets the person named like it (ignoring case; else a new one with its
 * name), its voice and the face most on its screen, so one confirmation links
 * them all. A voice or face someone else has is left out.
 */
export function angleSuggestions(input: AngleSuggestInput): PeopleSuggestion[] {
  const linked = new Set(input.people.flatMap((person) => person.angles.map(angleLinkKey)));
  const speakerOwner = new Map<string, Person>();
  for (const person of input.people) for (const link of person.speakers) speakerOwner.set(speakerLinkKey(link), person);
  const byName = new Map(input.people.map((person) => [personNameKey(person.name), person]));
  const suggestions: PeopleSuggestion[] = [];
  for (const [timeline, { groups }] of input.timelines) {
    for (const group of groups ?? []) {
      for (const angle of group.angles) {
        const target = { timeline, group: group.id, angle: angle.id };
        if (angle.screen === true || linked.has(angleLinkKey(target))) continue;
        const person = byName.get(personNameKey(angle.name));
        const links: PeopleSuggestion["links"] = ["angle"];
        const parts = [`the angle ${angle.name} (${group.id} in ${timeline}) is ${person ? person.name : `a new person, ${angle.name}`}`];
        const suggestion: PeopleSuggestion = {
          id: suggestionId("angle", [timeline, group.id, angle.id]),
          kind: "angle",
          ...(person ? { person: { id: person.id, name: person.name } } : {}),
          angle: { ...target, name: angle.name },
          links,
          reason: "",
        };
        const voice = angleVoice(input.transcripts, group, angle);
        if (voice && !speakerOwner.has(speakerLinkKey(voice))) {
          links.push("speaker");
          suggestion.speaker = { transcript: voice.transcript, ...(voice.speaker !== undefined ? { speaker: voice.speaker, name: voice.name } : {}) };
          parts.push(voice.speaker === undefined ? `all of ${voice.transcript} is its voice` : `${voice.speaker} (${voice.name}) in ${voice.transcript} is its voice`);
        }
        const face = angleFace(input, angle, person);
        if (face) {
          links.push("face");
          suggestion.face = { cluster: face.id, anchor: face.anchor, seconds: face.seconds };
          parts.push(`the face at ${face.anchor.asset} ${face.anchor.at} s is the most on its screen`);
        }
        suggestion.reason = `${parts.join("; ")}.`.replace(/^./, (first) => first.toUpperCase());
        suggestions.push(suggestion);
      }
    }
  }
  return suggestions;
}

/** The transcript speaker (or whole transcript) heard in `angle`, or null when none is clear. */
function angleVoice(transcripts: ReadonlyMap<string, Transcript>, group: MulticamGroup, angle: Angle): { transcript: string; speaker?: string; name: string } | null {
  if (angle.mic === null) return null;
  const mic = angle.mic === undefined ? undefined : group.mics?.find((candidate) => candidate.id === angle.mic);
  if (angle.mic !== undefined && !mic) return null;
  const found = [...transcripts].find(([, transcript]) => transcript.asset === (mic?.asset ?? angle.asset));
  if (!found) return null;
  const [rel, transcript] = found;
  const speakers = transcript.speakers ?? [];
  const named = speakers.find((speaker) => speaker.id === angle.speaker);
  if (named) return { transcript: rel, speaker: named.id, name: named.name };
  if (speakers.length === 0) {
    // A mic only this angle uses is one person's; a camera file or shared mic says nothing without speakers.
    const alone = mic && group.angles.filter((other) => other.screen !== true && other.mic === mic.id).length === 1;
    return alone ? { transcript: rel, name: mic.name } : null;
  }
  const counts = new Map<string, number>();
  let total = 0;
  for (const word of transcript.words) {
    const id = wordSpeaker(transcript, word);
    if (transcript.edits[word.id]?.text === "" || id === undefined) continue;
    counts.set(id, (counts.get(id) ?? 0) + 1);
    total++;
  }
  const top = speakers.map((speaker) => ({ speaker, count: counts.get(speaker.id) ?? 0 })).sort((a, b) => b.count - a.count)[0];
  return top && total > 0 && top.count / total >= ANGLE_SPEAKER_SHARE ? { transcript: rel, speaker: top.speaker.id, name: top.speaker.name } : null;
}

/**
 * The one cluster holding {@link FACE_SPEAKER_SHARE} of the face time in the
 * angle's picture, for at least {@link FACE_SPEAKER_MIN_S}; null when the
 * video was not scanned, the faces are split, or the face belongs to someone
 * already or the person already has a face.
 */
function angleFace({ model, owners }: AngleSuggestInput, angle: Angle, person: Person | undefined): FaceCluster | null {
  if (!model.scans.has(angle.asset)) return null;
  const seen = model.clusters.map((cluster) => ({ cluster, seconds: spanSeconds(presence(cluster.tracks, angle.asset)) })).filter((entry) => entry.seconds > 0);
  const total = seen.reduce((sum, entry) => sum + entry.seconds, 0);
  const top = seen.sort((a, b) => b.seconds - a.seconds)[0];
  if (!top || top.seconds < FACE_SPEAKER_MIN_S || top.seconds / total < FACE_SPEAKER_SHARE) return null;
  const owned = new Set([...owners.tracks.values()].flat());
  if (top.cluster.tracks.some((track) => owned.has(track))) return null;
  return person && (owners.tracks.get(person.id)?.length ?? 0) > 0 ? null : top.cluster;
}
