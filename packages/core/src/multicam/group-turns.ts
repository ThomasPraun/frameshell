import { type MediaProbe, RpcError } from "@frameshell/protocol";
import { type Angle, type MulticamGroup, type Transcript, wordSpeaker } from "@frameshell/schema";
import { ENERGY_HOP_S, type EnergyProfile } from "../media/energy.js";
import { type Turn, type TurnInput, speakingTurns, wordTurns } from "./turns.js";

/** A transcript file of an asset, for turns from speakers. */
export interface TurnsTranscript {
  /** Project-relative transcript file. */
  path: string;
  transcript: Transcript;
  /** The asset changed after it was transcribed: word times no longer match it. */
  stale: boolean;
}

/** Where `multicam.turns` finds the media facts it needs; the daemon wires these to its services. */
export interface TurnsSource {
  /** Probe of a project-relative asset; see `MediaService.probe`. */
  probe(root: string, asset: string): Promise<MediaProbe>;
  /** Energy envelope of a project-relative asset; see `EnergyStore.profile`. */
  profile(root: string, asset: string): Promise<EnergyProfile>;
  /** Transcript of a project-relative asset, or null when it has none. */
  transcript(root: string, asset: string): Promise<TurnsTranscript | null>;
}

/** An angle whose turns came from a transcript speaker. */
export interface SpeakerSource {
  angle: string;
  speaker: string;
  /** Project-relative transcript file. */
  transcript: string;
}

/** Speaking turns of a group plus what could not be measured. */
export interface GroupTurns {
  /** Group-clock seconds where the last sound ends. */
  duration: number;
  /** Each carries the angle's display name. */
  turns: (Turn & { name: string })[];
  /** One line per angle that could not be measured, or whose speaker was guessed. */
  warnings: string[];
  /** Angles measured from transcript speakers, by file. */
  speakers: SpeakerSource[];
}

/** Where an angle is heard: its own file or a mic, placed on the group clock. */
interface Sound {
  /** `asset:<path>` or `mic:<id>`: angles with the same key hear the same recording. */
  key: string;
  asset: string;
  /** Group-clock second at which `asset`'s time 0 plays. */
  offset: number;
  gain: number;
  /** Names the sound in warnings: the angle's file, or its mic. */
  label: string;
  /** Display name of the mic, when the sound is one. */
  mic?: string;
}

/**
 * Turns of every angle of `group` (ADR 0016 decision 3), from the angle's
 * sound: its mic (offset and gain of the mic) or else its own file. Angles
 * sharing one file, angles sharing a mic whose transcript has speakers, and
 * angles naming a `speaker` take their turns from the words of their speaker
 * in that sound's transcript ({@link wordTurns}), human corrections included;
 * the others from the cached energy envelope ({@link speakingTurns}), so
 * angles sharing an undiarized mic (two cameras of one person) speak together. Screen
 * angles are never speakers: with a non-screen angle in the group they are
 * not heard at all (and a silent screen never warns). An angle with
 * `mic: null` has no turns and no warning. An angle that cannot be measured
 * gets no turns and a warning; it does not fail the call.
 * Daemon errors (missing asset, ffmpeg unavailable) are thrown, never turned into warnings.
 */
export async function groupTurns(source: TurnsSource, root: string, group: MulticamGroup): Promise<GroupTurns> {
  const warnings: string[] = [];
  const sounds = new Map<string, Sound | null>();
  for (const angle of group.angles) {
    if (angle.mic === null) sounds.set(angle.id, null);
    else if (angle.mic === undefined) {
      sounds.set(angle.id, { key: `asset:${angle.asset}`, asset: angle.asset, offset: angle.offset, gain: angle.audio?.gain ?? 0, label: angle.asset });
    } else {
      const mic = group.mics?.find((candidate) => candidate.id === angle.mic);
      if (!mic) warnings.push(`${angle.name} names mic ${angle.mic}, which the group does not have, so it has no turns.`);
      sounds.set(angle.id, mic ? { key: `mic:${mic.id}`, asset: mic.asset, offset: mic.offset, gain: mic.audio?.gain ?? 0, label: `mic ${mic.name} (${mic.asset})`, mic: mic.name } : null);
    }
  }
  const sharing = new Map<string, number>();
  for (const angle of group.angles) {
    const sound = sounds.get(angle.id);
    if (sound && angle.screen !== true) sharing.set(sound.key, (sharing.get(sound.key) ?? 0) + 1);
  }
  const transcripts = new Map<string, Promise<TurnsTranscript | null>>();
  const transcriptOf = (asset: string): Promise<TurnsTranscript | null> => {
    let found = transcripts.get(asset);
    if (!found) transcripts.set(asset, (found = source.transcript(root, asset)));
    return found;
  };
  const shared = new Set<string>();
  for (const [key, count] of sharing) {
    if (count < 2) continue;
    const sound = [...sounds.values()].find((candidate) => candidate?.key === key)!;
    const named = group.angles.some((angle) => angle.speaker !== undefined && angle.screen !== true && sounds.get(angle.id)?.key === key);
    if (sound.mic === undefined || named) shared.add(key);
    else {
      // A mic may be one person's, filmed by several cameras: only its diarized transcript says otherwise.
      const found = await transcriptOf(sound.asset);
      if (found && !found.stale && (found.transcript.speakers ?? []).length > 0) shared.add(key);
    }
  }
  const bySpeaker = (angle: Angle) => {
    const sound = sounds.get(angle.id);
    return !!sound && angle.screen !== true && (angle.speaker !== undefined || shared.has(sound.key));
  };

  const profiles = new Map<string, { profile: EnergyProfile | null; problem?: string }>();
  const warned = new Set<string>();
  /** `quiet`: a screen angle, whose silence is expected and not worth a warning. */
  const profileOf = async (asset: string, who: string, quiet: boolean): Promise<EnergyProfile | null> => {
    let entry = profiles.get(asset);
    if (!entry) {
      try {
        const probe = await source.probe(root, asset);
        entry = probe.audio ? { profile: await source.profile(root, asset) } : { profile: null, problem: "has no sound" };
      } catch (error) {
        if (error instanceof RpcError) throw error;
        entry = { profile: null, problem: `could not read the sound (${(error as Error).message})` };
      }
      profiles.set(asset, entry);
    }
    if (entry.problem && !warned.has(asset) && !(quiet && entry.problem === "has no sound")) {
      warned.add(asset);
      warnings.push(entry.problem === "has no sound" ? `${who} (${asset}) has no sound, so it has no turns.` : `${who} (${asset}): ${entry.problem}, so it has no turns.`);
    }
    return entry.profile;
  };
  const inputs: TurnInput[] = [];
  for (const angle of group.angles.filter((candidate) => !bySpeaker(candidate))) {
    const sound = sounds.get(angle.id);
    if (!sound) {
      inputs.push({ id: angle.id, offset: angle.offset, profile: null });
      continue;
    }
    const who = sound.mic === undefined ? angle.name : `${angle.name}'s mic ${sound.mic}`;
    inputs.push({ id: angle.id, offset: sound.offset, gain: sound.gain, profile: await profileOf(sound.asset, who, angle.screen === true) });
  }
  const ends = inputs.map((input) => (input.profile ? input.offset + input.profile.db.length * ENERGY_HOP_S : 0));
  const fromSpeakers = await speakerTurns(
    source,
    root,
    transcriptOf,
    group.angles.filter(bySpeaker).map((angle) => ({ angle, sound: sounds.get(angle.id)! })),
    warnings,
  );
  const duration = Math.max(0, ...ends, ...fromSpeakers.ends);
  // A screen's sound (often the mixed call) must not mask people's turns; its turns are discarded anyway.
  const people = group.angles.some((angle) => angle.screen !== true);
  const screens = new Set(group.angles.filter((angle) => angle.screen === true).map((angle) => angle.id));
  const heard = people ? inputs.map((input) => (screens.has(input.id) ? { ...input, profile: null } : input)) : inputs;
  const names = new Map(group.angles.map((angle) => [angle.id, angle.name]));
  const turns = [...speakingTurns(heard, duration), ...fromSpeakers.turns]
    .map((turn) => ({ ...turn, end: Math.min(turn.end, Math.round(duration * 1000) / 1000), name: names.get(turn.angle)! }))
    .filter((turn) => turn.end > turn.start)
    .sort((a, b) => a.start - b.start || (a.angle < b.angle ? -1 : a.angle > b.angle ? 1 : 0));
  return { duration: Math.round(duration * 1000) / 1000, turns, warnings, speakers: fromSpeakers.sources };
}

/** Turns of angles measured from transcript speakers, grouped by the sound they share; adds a warning per problem. */
async function speakerTurns(
  source: TurnsSource,
  root: string,
  transcriptOf: (asset: string) => Promise<TurnsTranscript | null>,
  angles: readonly { angle: Angle; sound: Sound }[],
  warnings: string[],
): Promise<{ turns: Turn[]; ends: number[]; sources: SpeakerSource[] }> {
  const turns: Turn[] = [];
  const ends: number[] = [];
  const sources: SpeakerSource[] = [];
  for (const key of new Set(angles.map(({ sound }) => sound.key))) {
    const here = angles.filter(({ sound }) => sound.key === key).map(({ angle }) => angle);
    const { asset, offset, label } = angles.find(({ sound }) => sound.key === key)!.sound;
    const who = here.map((angle) => angle.name).join(", ");
    let length: number | null = null;
    try {
      length = (await source.probe(root, asset)).duration;
    } catch (error) {
      // An unreadable file still has its transcript; the group then ends with its last word.
      if (error instanceof RpcError) throw error;
    }
    if (length !== null) ends.push(offset + length);
    const found = await transcriptOf(asset);
    if (!found) {
      const verb = here.length > 1 ? "share" : "uses";
      warnings.push(`${who} ${verb} ${label}, which has no transcript, so they have no turns. Run \`transcribe\` then \`transcribe.speakers\` on ${asset}.`);
      continue;
    }
    if (found.stale) {
      warnings.push(`${who}: ${found.path} is stale (${asset} changed), so they have no turns. Run \`transcribe\` then \`transcribe.speakers\` on it again.`);
      continue;
    }
    const known = found.transcript.speakers ?? [];
    if (known.length === 0) {
      warnings.push(`${who}: ${found.path} has no speakers, so they have no turns. Run \`transcribe.speakers\` on ${asset}.`);
      continue;
    }
    const named = new Set(here.flatMap((angle) => (angle.speaker !== undefined ? [angle.speaker] : [])));
    const free = known.map((speaker) => speaker.id).filter((id) => !named.has(id));
    const assigned = new Map<string, string>();
    for (const angle of here) {
      if (angle.speaker !== undefined) {
        if (known.some((speaker) => speaker.id === angle.speaker)) assigned.set(angle.id, angle.speaker);
        else warnings.push(`${angle.name}: speaker ${angle.speaker} is not in ${found.path} (${listSpeakers(known)}), so it has no turns.`);
        continue;
      }
      const guess = free.shift();
      if (guess === undefined) {
        warnings.push(
          `${angle.name}: every speaker of ${found.path} belongs to another angle, so it has no turns. ` +
            "Two cameras of one person: give both the same `speaker` with `multicam.angle`.",
        );
        continue;
      }
      assigned.set(angle.id, guess);
      const name = known.find((speaker) => speaker.id === guess)!.name;
      warnings.push(`${angle.name} took speaker ${guess} (${name}) of ${found.path} by order; set the right one with \`multicam.angle\` \`speaker\` if that is not them.`);
    }
    const { transcript } = found;
    const words = transcript.words.map((word) => ({ start: word.start, end: word.end, speaker: wordSpeaker(transcript, word) }));
    for (const angle of here) {
      const speaker = assigned.get(angle.id);
      if (speaker === undefined) continue;
      sources.push({ angle: angle.id, speaker, transcript: found.path });
      const made = wordTurns(words, speaker, offset);
      turns.push(...made.map((turn) => ({ angle: angle.id, ...turn })));
      ends.push(...made.map((turn) => turn.end));
    }
  }
  return { turns, ends, sources };
}

function listSpeakers(speakers: readonly { id: string; name: string }[]): string {
  return speakers.map((speaker) => `${speaker.id} ${speaker.name}`).join(", ");
}
