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
 * An angle whose sound is missing or cannot be decoded gets no turns and a
 * warning; it does not fail the call. With a non-screen angle in the group,
 * screen angles are not heard at all (and a silent screen never warns).
 * Daemon errors (missing asset, ffmpeg unavailable) are thrown, never turned into warnings.
 */
export async function groupTurns(source: TurnsSource, root: string, group: MulticamGroup): Promise<GroupTurns> {
  const warnings: string[] = [];
  const inputs: TurnInput[] = [];
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
  for (const angle of group.angles) {
    if (angle.mic === null) {
      inputs.push({ id: angle.id, offset: angle.offset, profile: null });
    } else if (angle.mic === undefined) {
      inputs.push({ id: angle.id, offset: angle.offset, gain: angle.audio?.gain ?? 0, profile: await profileOf(angle.asset, angle.name, angle.screen === true) });
    } else {
      const mic = group.mics?.find((candidate) => candidate.id === angle.mic);
      if (!mic) {
        warnings.push(`${angle.name} names mic ${angle.mic}, which the group does not have, so it has no turns.`);
        inputs.push({ id: angle.id, offset: angle.offset, profile: null });
        continue;
      }
      inputs.push({ id: angle.id, offset: mic.offset, gain: mic.audio?.gain ?? 0, profile: await profileOf(mic.asset, `${angle.name}'s mic ${mic.name}`, angle.screen === true) });
    }
  }
  const duration = Math.max(0, ...inputs.map((input) => (input.profile ? input.offset + input.profile.db.length * ENERGY_HOP_S : 0)));
  // A screen's sound (often the mixed call) must not mask people's turns; its turns are discarded anyway.
  const people = group.angles.some((angle) => angle.screen !== true);
  const screens = new Set(group.angles.filter((angle) => angle.screen === true).map((angle) => angle.id));
  const heard = people ? inputs.map((input) => (screens.has(input.id) ? { ...input, profile: null } : input)) : inputs;
  const names = new Map(group.angles.map((angle) => [angle.id, angle.name]));
  const turns = speakingTurns(heard, duration).map((turn) => ({ ...turn, name: names.get(turn.angle)! }));
  return { duration: Math.round(duration * 1000) / 1000, turns, warnings };
}
