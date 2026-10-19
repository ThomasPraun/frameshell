import { type MediaProbe, RpcError } from "@frameshell/protocol";
import type { MulticamGroup } from "@frameshell/schema";
import { ENERGY_HOP_S, type EnergyProfile } from "../media/energy.js";
import { type Turn, type TurnInput, speakingTurns } from "./turns.js";

/** Where `multicam.turns` finds the media facts it needs; the daemon wires these to its services. */
export interface TurnsSource {
  /** Probe of a project-relative asset; see `MediaService.probe`. */
  probe(root: string, asset: string): Promise<MediaProbe>;
  /** Energy envelope of a project-relative asset; see `EnergyStore.profile`. */
  profile(root: string, asset: string): Promise<EnergyProfile>;
}

/** Speaking turns of a group plus what could not be measured. */
export interface GroupTurns {
  /** Group-clock seconds where the last sound ends. */
  duration: number;
  /** Each carries the angle's display name. */
  turns: (Turn & { name: string })[];
  /** One line per angle that could not be measured. */
  warnings: string[];
}

/**
 * Turns of every angle of `group` (see {@link speakingTurns}), from the
 * cached energy envelopes of the angles' sound: its own file, or its mic
 * (offset and gain of the mic; angles sharing a mic hear the same voice, so
 * they speak together). An angle with `mic: null` has no turns and no warning.
 * An angle whose file has no sound or cannot be decoded gets no turns and a
 * warning; it does not fail the call. Daemon errors (missing asset, ffmpeg
 * unavailable) are thrown, never turned into warnings.
 */
export async function groupTurns(source: TurnsSource, root: string, group: MulticamGroup): Promise<GroupTurns> {
  const warnings: string[] = [];
  const inputs: TurnInput[] = [];
  const profiles = new Map<string, EnergyProfile | null>();
  const profileOf = async (asset: string, who: string): Promise<EnergyProfile | null> => {
    if (profiles.has(asset)) return profiles.get(asset)!;
    let profile: EnergyProfile | null = null;
    try {
      const probe = await source.probe(root, asset);
      if (probe.audio) profile = await source.profile(root, asset);
      else warnings.push(`${who} (${asset}) has no sound, so it has no turns.`);
    } catch (error) {
      if (error instanceof RpcError) throw error;
      warnings.push(`${who} (${asset}): could not read the sound (${(error as Error).message}), so it has no turns.`);
    }
    profiles.set(asset, profile);
    return profile;
  };
  for (const angle of group.angles) {
    if (angle.mic === null) {
      inputs.push({ id: angle.id, offset: angle.offset, profile: null });
    } else if (angle.mic === undefined) {
      inputs.push({ id: angle.id, offset: angle.offset, gain: angle.audio?.gain ?? 0, profile: await profileOf(angle.asset, angle.name) });
    } else {
      const mic = group.mics?.find((candidate) => candidate.id === angle.mic);
      if (!mic) {
        warnings.push(`${angle.name} names mic ${angle.mic}, which the group does not have, so it has no turns.`);
        inputs.push({ id: angle.id, offset: angle.offset, profile: null });
        continue;
      }
      inputs.push({ id: angle.id, offset: mic.offset, gain: mic.audio?.gain ?? 0, profile: await profileOf(mic.asset, `${angle.name}'s mic ${mic.name}`) });
    }
  }
  const duration = Math.max(0, ...inputs.map((input) => (input.profile ? input.offset + input.profile.db.length * ENERGY_HOP_S : 0)));
  const names = new Map(group.angles.map((angle) => [angle.id, angle.name]));
  const turns = speakingTurns(inputs, duration).map((turn) => ({ ...turn, name: names.get(turn.angle)! }));
  return { duration: Math.round(duration * 1000) / 1000, turns, warnings };
}
