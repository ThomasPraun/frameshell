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

/** Genre presets of the music sequencer (ADR 0038 slice 3): each has its own instruments, groove, tempo and chords. */
export const MUSIC_PRESETS = ["synthwave", "lofi", "minimal"] as const;

/** One of {@link MUSIC_PRESETS}. */
export type MusicPreset = (typeof MUSIC_PRESETS)[number];

/** Zod model of a {@link MusicPreset}. */
export const MusicPresetSchema = z.enum(MUSIC_PRESETS);

/**
 * Tempo (BPM) and chords (one per bar, repeating) a preset plays when the caller names none; `swing` delays every
 * odd 16th by that fraction of a 16th. Numbers from the owner's notes on #463 (minimal has none: 110 BPM is ours).
 */
export const MUSIC_PRESET_DEFAULTS: Readonly<Record<MusicPreset, { bpm: number; chords: readonly string[]; swing: number }>> = {
  synthwave: { bpm: 118, chords: ["Am", "F", "C", "G"], swing: 0 },
  lofi: { bpm: 78, chords: ["Dm9", "G13", "Cmaj7", "Am7"], swing: 0.16 },
  minimal: { bpm: 110, chords: ["Am7", "Fmaj7", "C", "G"], swing: 0 },
};

/**
 * Parts of a generated track. `intro` pads and hats, `full` everything, `dark` stripped (pad, sub, soft kick: under
 * dense picture or a voice), `build` a climbing motif, a clap roll and a riser that ends 75 ms before the next part,
 * `gap` one stop-time hit then silence (so the next downbeat lands hard), `drop` everything with an accent on its
 * first beat, `outro` half time; the track always ends on a final chord that rings.
 */
export const MUSIC_SECTIONS = ["intro", "full", "dark", "build", "gap", "drop", "outro"] as const;

/** One of {@link MUSIC_SECTIONS}. */
export type MusicSection = (typeof MUSIC_SECTIONS)[number];

/** Zod model of a {@link MusicSection}. */
export const MusicSectionSchema = z.enum(MUSIC_SECTIONS);

/** Tempo range of generated music, BPM. */
export const MUSIC_BPM_RANGE = { min: 50, max: 180 } as const;

/** Beats per bar of generated music. */
export const MUSIC_METER_RANGE = { min: 2, max: 7 } as const;

/** Most bars of one generated track. */
export const MUSIC_MAX_BARS = 128;

/** Most seconds of one generated track before its ringing tail. */
export const MUSIC_MAX_SECONDS = 300;

/** Seconds the final chord rings after the last bar. */
export const MUSIC_TAIL_SECONDS = 2.5;

/** Integrated loudness every generated track is normalised to, LUFS (ADR 0038, gain). */
export const MUSIC_LUFS = -14;

/** Highest sample peak of a generated track, dBFS: a limiter holds it there when the loudness would push past it. */
export const MUSIC_PEAK_DBFS = -1;

/** Most chords, sections and accents one track takes. */
export const MUSIC_LIMITS = { chords: 16, sections: 32, accents: 32 } as const;

/**
 * Chord qualities the sequencer plays, as semitones over the root. A chord is a root (`A`, `C#`, `Bb`) then one of
 * these suffixes (none = major): `Am`, `Fmaj7`, `G13`.
 */
export const MUSIC_CHORD_QUALITIES: Readonly<Record<string, readonly number[]>> = {
  "": [0, 4, 7],
  m: [0, 3, 7],
  "7": [0, 4, 7, 10],
  maj7: [0, 4, 7, 11],
  m7: [0, 3, 7, 10],
  "9": [0, 4, 10, 14],
  maj9: [0, 4, 11, 14],
  m9: [0, 3, 10, 14],
  "13": [0, 4, 10, 21],
  "6": [0, 4, 7, 9],
  m6: [0, 3, 7, 9],
  sus2: [0, 2, 7],
  sus4: [0, 5, 7],
  dim: [0, 3, 6],
  aug: [0, 4, 8],
  add9: [0, 4, 7, 14],
};

/** A chord name the sequencer can play: a root letter, an optional `#` or `b`, then a key of {@link MUSIC_CHORD_QUALITIES}. */
export const MUSIC_CHORD_PATTERN = new RegExp(
  `^[A-G][#b]?(${Object.keys(MUSIC_CHORD_QUALITIES)
    .filter((quality) => quality !== "")
    .sort((a, b) => b.length - a.length)
    .join("|")})?$`,
);
