import { z } from "zod";

/** Generated sound effects (ADR 0038): the kinds, their ranges and the placement offsets. */
export const SFX_KINDS = ["click", "tick", "pop", "whoosh", "riser", "thump", "impact", "shutter"] as const;

/** One of {@link SFX_KINDS}. */
export type SfxKind = (typeof SFX_KINDS)[number];

/** Zod model of a sound effect kind. */
export const SfxKindSchema = z.enum(SFX_KINDS);

/** Variants of every kind (`1` to this); each is a different recipe, not a random draw. */
export const SFX_VARIANTS = 3;

/** Largest seed; a seed is an unsigned 32-bit integer. */
export const SFX_SEED_MAX = 0xffff_ffff;

/** Sample rate of every generated sound, in Hz. */
export const SOUND_SAMPLE_RATE = 48_000;

/** Sample peak every effect is normalised to before its seeded level jitter, in dBFS. */
export const SFX_PEAK_DBFS = -3;

/** Seeded jitter of a take whose caller does not set the pitch: a pitch multiplier in this range, a level within ± this many dB. */
export const SFX_JITTER = { pitch: { min: 0.9, max: 1.3 }, levelDb: 1.5 } as const;

/** Range of an explicit `pitch` multiplier (all frequencies of the take scale by it). */
export const SFX_PITCH_RANGE = { min: 0.5, max: 2 } as const;

/** Kinds whose length can be set, with the range in seconds; every other kind has a fixed length per variant. */
export const SFX_LENGTH_RANGE: Partial<Record<SfxKind, { min: number; max: number }>> = {
  whoosh: { min: 0.3, max: 2 },
  riser: { min: 0.8, max: 6 },
};

/** What a placed sound does to the picture, which decides where its anchor sits against the cue. */
export const SOUND_ROLES = ["tap", "knock", "click", "pop", "whoosh", "swell"] as const;

/** One of {@link SOUND_ROLES}. */
export type SoundRole = (typeof SOUND_ROLES)[number];

/**
 * Milliseconds from the cue to a take's anchor (`peakAt`), per role: negative = before the picture. A sound is
 * placed at `cue + offset - peakAt`. A riser is not here: it ends {@link SOUND_RISER_END_BEFORE_MS} before the hit.
 * Numbers are the owner's (ADR 0038 decision 3).
 */
export const SOUND_ROLE_OFFSETS: Readonly<Record<SoundRole, number>> = {
  tap: -60,
  knock: -40,
  click: -11,
  pop: 30,
  whoosh: 37,
  swell: 42,
};

/** How long before the hit a riser's last sample falls, in milliseconds. */
export const SOUND_RISER_END_BEFORE_MS = 75;
