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
  /** Group-clock seconds where the last angle's file ends. */
  duration: number;
  /** Each carries the angle's display name. */
  turns: (Turn & { name: string })[];
  /** One line per angle that could not be measured. */
  warnings: string[];
}

/**
 * Turns of every angle of `group` (see {@link speakingTurns}), from the
 * cached energy envelopes of the angles' files. An angle whose file has no
 * sound or cannot be decoded gets no turns and a warning; it does not fail the call.
 * With a non-screen angle in the group, screen angles are not heard at all.
 * Daemon errors (missing asset, ffmpeg unavailable) are thrown, never turned into warnings.
 */
export async function groupTurns(source: TurnsSource, root: string, group: MulticamGroup): Promise<GroupTurns> {
  const warnings: string[] = [];
  const inputs: TurnInput[] = [];
  for (const angle of group.angles) {
    let profile: EnergyProfile | null = null;
    try {
      const probe = await source.probe(root, angle.asset);
      if (probe.audio) profile = await source.profile(root, angle.asset);
      else if (angle.screen !== true) warnings.push(`${angle.name} (${angle.asset}) has no sound, so it has no turns.`);
    } catch (error) {
      if (error instanceof RpcError) throw error;
      warnings.push(`${angle.name} (${angle.asset}): could not read the sound (${(error as Error).message}), so it has no turns.`);
    }
    inputs.push({ id: angle.id, offset: angle.offset, gain: angle.audio?.gain ?? 0, profile });
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
