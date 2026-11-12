import type { DaemonConnection, SoundSfxResult } from "@frameshell/protocol";
import { SFX_JITTER, SFX_KINDS, SFX_PITCH_RANGE, SFX_SEED_MAX, SFX_VARIANTS, type SfxKind } from "@frameshell/schema";
import { UsageError } from "./timeline-commands.js";

/** Help text of the `sound` commands (ADR 0038), in `frameshell --help`. */
export const SOUND_USAGE = `  sound sfx <kind> [--variant n] [--seed n] [--pitch x] [--length s]
                               Synthesize a sound effect offline into assets/sound/<kind>-<key>.wav and import it.
                               Kinds: ${SFX_KINDS.join(", ")}. The same arguments always give the same file; vary
                               --variant (1 to ${SFX_VARIANTS}) and --seed between uses. --pitch scales every frequency
                               (default: seeded ${SFX_JITTER.pitch.min} to ${SFX_JITTER.pitch.max}); --length is for whoosh and riser.
                               Prints peakAt: the second of the take that must land on the cue
`;

/** Flags each `sound` command takes besides the global ones. */
export const SOUND_FLAGS: Record<string, readonly string[]> = {
  "sound sfx": ["variant", "seed", "pitch", "length"],
};

/** A parsed `sound` command. */
export type SoundInvocation = { kind: "sound.sfx"; sfx: SfxKind; variant?: number; seed?: number; pitch?: number; length?: number };

/** Parse `sound sfx <kind> …`; null when the shape is wrong. Throws `UsageError` for a bad flag value. */
export function parseSound(
  rest: string[],
  options: { variant?: string | undefined; seed?: string | undefined; pitch?: string | undefined; length?: string | undefined },
): SoundInvocation | null {
  const [sub, ...args] = rest;
  if (sub !== "sfx" || args.length !== 1) return null;
  const sfx = args[0]!;
  if (!(SFX_KINDS as readonly string[]).includes(sfx)) throw new UsageError(`Unknown sound effect "${sfx}": expected ${SFX_KINDS.join(", ")}.`);
  const variant = number(options.variant, "variant", `a whole number from 1 to ${SFX_VARIANTS}`, (n) => Number.isInteger(n) && n >= 1 && n <= SFX_VARIANTS);
  const seed = number(options.seed, "seed", `a whole number from 0 to ${SFX_SEED_MAX}`, (n) => Number.isInteger(n) && n >= 0 && n <= SFX_SEED_MAX);
  const pitch = number(options.pitch, "pitch", `a multiplier from ${SFX_PITCH_RANGE.min} to ${SFX_PITCH_RANGE.max}`, (n) => n >= SFX_PITCH_RANGE.min && n <= SFX_PITCH_RANGE.max);
  const length = number(options.length, "length", "a number of seconds above 0", (n) => n > 0);
  return {
    kind: "sound.sfx",
    sfx: sfx as SfxKind,
    ...(variant !== undefined ? { variant } : {}),
    ...(seed !== undefined ? { seed } : {}),
    ...(pitch !== undefined ? { pitch } : {}),
    ...(length !== undefined ? { length } : {}),
  };
}

function number(raw: string | undefined, flag: string, expected: string, valid: (n: number) => boolean): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (raw.trim() === "" || !Number.isFinite(value) || !valid(value)) throw new UsageError(`--${flag}: expected ${expected}, got "${raw}".`);
  return value;
}

/** Run a parsed `sound` command; human output unless `json`. */
export async function executeSound(conn: DaemonConnection, inv: SoundInvocation, cwd: string, json: boolean): Promise<string> {
  const { kind: _kind, sfx, ...params } = inv;
  const result = await conn.request("sound.sfx", { cwd, kind: sfx, ...params });
  return json ? `${JSON.stringify(result, null, 2)}\n` : formatSfx(result);
}

function formatSfx(result: SoundSfxResult): string {
  const lines = [
    `${result.file}  ${result.state}  ${result.kind} ${result.variant}, seed ${result.seed}, pitch ${result.pitch.toFixed(2)}`,
    `  ${result.duration.toFixed(2)} s, ${result.channels === 2 ? "stereo" : "mono"}, peak ${result.peakDb} dBFS, rms ${result.rmsDb} dBFS`,
    `  peakAt ${result.peakAt.toFixed(3)} s: put this instant of the take on the cue`,
  ];
  if (result.credited) lines.push("  recorded in credits.json (own work)");
  return `${lines.join("\n")}\n`;
}
