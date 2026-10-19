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
  /** Group-clock seconds where the last angle's file ends. */
  duration: number;
  /** Each carries the angle's display name. */
  turns: (Turn & { name: string })[];
  /** One line per angle that could not be measured, or whose speaker was guessed. */
  warnings: string[];
  /** Angles measured from transcript speakers, by file. */
  speakers: SpeakerSource[];
}

/**
 * Turns of every angle of `group` (ADR 0016 decision 3). An angle with its
 * own mic: from the cached energy envelope of its file ({@link speakingTurns}).
 * Angles sharing one file (a mixed recording), and angles naming a
 * `speaker`: from the words of their speaker in that file's transcript
 * ({@link wordTurns}), human corrections included. An angle that cannot be
 * measured gets no turns and a warning; it does not fail the call.
 * Daemon errors (missing asset, ffmpeg unavailable) are thrown, never turned into warnings.
 */
export async function groupTurns(source: TurnsSource, root: string, group: MulticamGroup): Promise<GroupTurns> {
  const warnings: string[] = [];
  const sharing = new Map<string, number>();
  for (const angle of group.angles) sharing.set(angle.asset, (sharing.get(angle.asset) ?? 0) + 1);
  const bySpeaker = (angle: Angle) => angle.speaker !== undefined || sharing.get(angle.asset)! > 1;

  const inputs: TurnInput[] = [];
  for (const angle of group.angles.filter((candidate) => !bySpeaker(candidate))) {
    let profile: EnergyProfile | null = null;
    try {
      const probe = await source.probe(root, angle.asset);
      if (probe.audio) profile = await source.profile(root, angle.asset);
      else warnings.push(`${angle.name} (${angle.asset}) has no sound, so it has no turns.`);
    } catch (error) {
      if (error instanceof RpcError) throw error;
      warnings.push(`${angle.name} (${angle.asset}): could not read the sound (${(error as Error).message}), so it has no turns.`);
    }
    inputs.push({ id: angle.id, offset: angle.offset, gain: angle.audio?.gain ?? 0, profile });
  }
  const ends = inputs.map((input) => (input.profile ? input.offset + input.profile.db.length * ENERGY_HOP_S : 0));
  const fromSpeakers = await speakerTurns(source, root, group.angles.filter(bySpeaker), warnings);
  const duration = Math.max(0, ...ends, ...fromSpeakers.ends);
  const names = new Map(group.angles.map((angle) => [angle.id, angle.name]));
  const turns = [...speakingTurns(inputs, duration), ...fromSpeakers.turns]
    .map((turn) => ({ ...turn, end: Math.min(turn.end, Math.round(duration * 1000) / 1000), name: names.get(turn.angle)! }))
    .filter((turn) => turn.end > turn.start)
    .sort((a, b) => a.start - b.start || (a.angle < b.angle ? -1 : a.angle > b.angle ? 1 : 0));
  return { duration: Math.round(duration * 1000) / 1000, turns, warnings, speakers: fromSpeakers.sources };
}

/** Turns of angles measured from transcript speakers, grouped by file; adds a warning per problem. */
async function speakerTurns(
  source: TurnsSource,
  root: string,
  angles: readonly Angle[],
  warnings: string[],
): Promise<{ turns: Turn[]; ends: number[]; sources: SpeakerSource[] }> {
  const turns: Turn[] = [];
  const ends: number[] = [];
  const sources: SpeakerSource[] = [];
  for (const asset of new Set(angles.map((angle) => angle.asset))) {
    const here = angles.filter((angle) => angle.asset === asset);
    const who = here.map((angle) => angle.name).join(", ");
    let length: number | null = null;
    try {
      length = (await source.probe(root, asset)).duration;
    } catch (error) {
      // An unreadable file still has its transcript; the group then ends with its last word.
      if (error instanceof RpcError) throw error;
    }
    for (const angle of here) if (length !== null) ends.push(angle.offset + length);
    const found = await source.transcript(root, asset);
    if (!found) {
      warnings.push(`${who} share ${asset}, which has no transcript, so they have no turns. Run \`transcribe\` then \`transcribe.speakers\` on it.`);
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
        warnings.push(`${angle.name}: every speaker of ${found.path} belongs to another angle, so it has no turns.`);
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
      const made = wordTurns(words, speaker, angle.offset);
      turns.push(...made.map((turn) => ({ angle: angle.id, ...turn })));
      ends.push(...made.map((turn) => turn.end));
    }
  }
  return { turns, ends, sources };
}

function listSpeakers(speakers: readonly { id: string; name: string }[]): string {
  return speakers.map((speaker) => `${speaker.id} ${speaker.name}`).join(", ");
}
