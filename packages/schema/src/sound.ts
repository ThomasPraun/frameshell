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

/** Zod model of a {@link SoundRole}. */
export const SoundRoleSchema = z.enum(SOUND_ROLES);

/** How much a placed sound matters to the picture; it sets the clip gain under the voice. */
export const SOUND_TIERS = ["primary", "secondary", "texture"] as const;

/** One of {@link SOUND_TIERS}. */
export type SoundTier = (typeof SOUND_TIERS)[number];

/** Zod model of a {@link SoundTier}. */
export const SoundTierSchema = z.enum(SOUND_TIERS);

/**
 * dB added to the clip gain per tier, on top of `-style.sound.sfxUnderVoice` (ADR 0038, gain): the sounds that carry
 * the picture sit at the style's level under the voice, the rest 4 and 8 dB below it.
 */
export const SOUND_TIER_OFFSETS_DB: Readonly<Record<SoundTier, number>> = { primary: 0, secondary: -4, texture: -8 };

/** Role a kind takes when the caller names none; null = the riser, which has its own rule ({@link SOUND_RISER_END_BEFORE_MS}). */
export const SOUND_DEFAULT_ROLES: Readonly<Record<SfxKind, SoundRole | null>> = {
  click: "click",
  tick: "tap",
  pop: "pop",
  whoosh: "whoosh",
  riser: null,
  thump: "pop",
  impact: "knock",
  shutter: "click",
};

/** Tier a kind takes when the caller names none: ticks are texture, a shutter supports, everything else carries the picture. */
export const SOUND_DEFAULT_TIERS: Readonly<Record<SfxKind, SoundTier>> = {
  click: "primary",
  tick: "texture",
  pop: "primary",
  whoosh: "primary",
  riser: "primary",
  thump: "primary",
  impact: "primary",
  shutter: "secondary",
};

/** Fewest milliseconds between the anchors of two sounds of one kind before a warning (owner's numbers: ticks 66, pops 114). */
export const SOUND_MIN_GAP_MS: Readonly<Partial<Record<SfxKind, number>>> = { tick: 66, pop: 114 };

/** Fewest milliseconds between two keys of a typing run (owner's number: keys 87); the run's rate is capped to keep it. */
export const SOUND_KEY_GAP_MS = 87;

/** Keys per second of a typing run: the default and the most (a 10 % timing jitter on 10 keys/s stays above {@link SOUND_KEY_GAP_MS}). */
export const SOUND_TYPING_RATE = { default: 8, max: 10 } as const;

/** Most sounds whose anchors may fall on one frame before a warning. */
export const SOUND_MAX_PER_FRAME = 2;

/** Most sounds one `sound.place` call places. */
export const SOUND_MAX_PLACEMENTS = 200;
