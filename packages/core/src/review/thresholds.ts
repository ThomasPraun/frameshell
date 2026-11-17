import type { SfxKind } from "@frameshell/schema";

// The numbers `review` judges a film by, as data (#457, decided in #478). Ported from HyperFrames' `check` and
// `measure` (Apache-2.0, https://github.com/heygen-com/hyperframes) and from the ranges the owner measured on seven launch
// films with earshot; every one is a judgment with a number, so each is a warning, never a failure.

/** Seconds a visual event may sit from a sound to count as the one it belongs to. */
export const SYNC_MATCH_S = 0.12;
/** A sound this many seconds before its picture event reads early (a viewer notices from 45 ms). */
export const SYNC_EARLY_S = 0.045;
/** A sound this many seconds after its picture event reads late (from 75 ms). */
export const SYNC_LATE_S = 0.075;
/** Seconds within which a sound has a visual event "near" it, for the hit rate and its chance baseline. */
export const SYNC_NEAR_S = 0.1;
/**
 * Fixed offsets (seconds) the sounds are moved by to see what random placement scores. A shift is used only when it is
 * clear of the near window, which a coarse picture series widens by half its sample spacing (`syncMetrics` drops the rest).
 */
export const SYNC_CHANCE_SHIFTS_S = [-1.1, -0.9, -0.7, -0.5, -0.3, 0.3, 0.5, 0.7, 0.9, 1.1] as const;
/** Effects that do not land on an event by design: a whoosh peaks before it, a riser builds to it, ticks keep time. */
export const SYNC_EXCLUDED_KINDS: readonly SfxKind[] = ["whoosh", "riser", "tick"];
/** Fewest scored sounds before the baseline is a warning: three sounds say nothing about chance. */
export const SYNC_MIN_SOUNDS = 5;
/** The hit rate must beat chance by this much (a share, 0 to 1) or the sounds sit where random ones would. */
export const SYNC_CHANCE_MARGIN = 0.15;
/** Most sounds listed in `sync.offsets`. */
export const SYNC_LISTED = 60;
/** Most cuts without a sound listed in `sync.silentCuts`. */
export const SYNC_LISTED_CUTS = 20;

/** Mean grey difference (0 to 255) between the last and the first frame under which a loop reads as continuous. */
export const SEAM_CONTINUOUS = 10;

/** Frames of tolerance on the length of an exported file against the plan (the container is a little longer than its picture). */
export const DELIVERY_FRAMES = 2;
/** LU an exported file's integrated loudness may be off the plan's target (the AAC encode and the loudnorm pass move it). */
export const DELIVERY_LOUDNESS_LU = 1.5;
/** Frame rates (fps) closer than this are the same. */
export const DELIVERY_FPS = 0.01;

/** Alpha above this (0 to 255) is picture, for the box of a generated clip. */
export const GRAPHIC_ALPHA = 24;
/** Width the alpha of a generated clip is read at, px. With the two below, quoted in `staysInFrame` (schema `requirements.ts`, skill `critique.md`). */
export const GRAPHIC_WIDTH = 160;
/** Most frames of a generated clip measured. */
export const GRAPHIC_SAMPLES = 12;
/** Most frames of a generated clip measured per second. */
export const GRAPHIC_HZ = 4;

// The sound review list (#457): the 2.5D shorts course's rules ("the voice is always on top", "no whoosh repeated more than
// twice", "the music resolves on the final frame") and earshot's mechanical audio QA, with its numbers.

/** Seconds per window of the voice-over-bed check: a few syllables, so one buried word shows and pauses between words do not. */
export const VOICE_WINDOW_S = 0.5;
/** dB the bed may come up to under the voice: half the 12 dB the style guide sets music under the voice by default (`musicUnderVoice`). */
export const VOICE_OVER_BED_DB = 6;
/** Most low stretches listed in `sound.voice.low`. */
export const VOICE_LISTED = 20;
/** Plays of one effect file allowed in a film: "no whoosh repeated more than twice" (2.5D shorts course, #457). */
export const SFX_REPEAT_MAX = 2;
/** Effects a key run repeats by design (`sound.place` `typing` rotates six takes of these): left out of the repeat count. */
export const SFX_REPEAT_EXEMPT: readonly SfxKind[] = ["tick", "click"];
/** Plays of one sample in a row that read as a machine gun (earshot: 4 events of one sample with pitch spread under 0.1 semitone). */
export const MACHINE_GUN_PLAYS = 4;
/**
 * Most seconds between two plays of a machine-gun run: earshot's rule is about rapid repeats, so one effect heard every
 * 20 s is not one. One take twice in a row at any distance is `sound place`'s warning (ADR 0038 decision 5), not this list's.
 */
export const MACHINE_GUN_GAP_S = 1;
/** Most files listed in `sound.repeats` and runs in `sound.machineGun`. */
export const SOUND_LISTED = 20;
/** Level against its loudest (dB) above which a sound's tail is chopped rather than decayed (earshot: unfaded tail above -35 dB re peak). */
export const CHOP_DB = -35;
/** Most clips listed in `sound.chopped`. */
export const CHOP_LISTED = 20;
/** Seconds of a file's sound the ending is measured over, and the RMS (dBFS) it must be under (earshot: last 50 ms at or under -45 dBFS). */
export const ENDING_TAIL_S = 0.05;
/** See {@link ENDING_TAIL_S}. */
export const ENDING_DBFS = -45;
/** The loudest moment of a file comes before this share of its length (earshot: loudest before 85 % of the runtime). */
export const LOUDEST_BEFORE = 0.85;
/** Seconds of the loudest moment: the EBU R128 momentary window. */
export const LOUDEST_WINDOW_S = 0.4;
/** dB within which a moment is as loud as the loudest: about the smallest change of level a listener notices, so a steady sound has no late peak. */
export const LOUDEST_MARGIN_DB = 1;
/** Clicks (earshot): a burst above this frequency (Hz)... */
export const CLICK_BAND_HZ = 14_000;
/** ...peaking over this many times the RMS of the {@link CLICK_CONTEXT_S} around it... */
export const CLICK_RATIO = 9;
/** ...with at least this share of that window's energy in {@link CLICK_BURST_S}. */
export const CLICK_SHARE = 0.8;
/** Seconds of a click's burst. */
export const CLICK_BURST_S = 0.001;
/** Seconds of the window a click is measured against; two bursts closer than this are one click. */
export const CLICK_CONTEXT_S = 0.02;
/** dBFS a click's peak (in the band) reaches at least: a lone burst under it is the encode's quantization dust (one 16-bit step is -90 dBFS), not a click anyone hears. */
export const CLICK_FLOOR_DBFS = -60;
/** Most clicks listed in `sound.clicks.at`. */
export const CLICK_LISTED = 20;
/**
 * dB the music may come above the style's `sound.musicUnderVoice` under the voice before it is `masking`: 3 dB doubles
 * its power, a step any listener hears, while a 0.5 s window of music wobbles by less. Never under 0 dB: music as loud
 * as the voice masks it (earshot: a band under 0 dB of voice over music is masked).
 */
export const MASKING_SLACK_DB = 3;
/** Most stretches listed in `sound.music.low`. */
export const MASKING_LISTED = 20;
/** Band (Hz) the harshness of a file is measured in (earshot: 2 to 6 kHz, where the ear is most sensitive and a sound turns shrill). */
export const HARSH_BAND_HZ = [2000, 6000] as const;
/**
 * dB a 400 ms window of that band may come over the band at the mix's loudest 400 ms (earshot: 2 to 6 kHz more than 6 dB
 * over the music's loudest is harsh; a file is one mix, so its loudest moment stands in for the music's).
 */
export const HARSH_DB = 6;
/**
 * dB under the whole mix at its loudest window that the band there counts as at least. Pink noise puts 2 to 6 kHz 8 dB
 * under the whole; a loudest moment with almost nothing there (a bass hit, a low drone) would make every bright sound harsh.
 */
export const HARSH_REFERENCE_FLOOR_DB = 20;
/** Seconds per window of the harshness check: the EBU R128 momentary window, as for the loudest moment. */
export const HARSH_WINDOW_S = LOUDEST_WINDOW_S;
/** Most stretches listed in `sound.harsh.spans`. */
export const HARSH_LISTED = 20;
/**
 * A clip edge with no fade clicks when the sound it cuts into jumps by this much (dB) over what the rest of the film played the 10 ms
 * before: earshot's click ratio, a burst 9 times its surroundings (20 log10 9 = 19 dB).
 */
export const EDGE_JUMP_DB = 19;
/** dBFS (RMS of 10 ms) a clip's sound must reach at a hard edge to click: under it the edge reads as silence (earshot's -45 dBFS end of a film). */
export const EDGE_FLOOR_DBFS = ENDING_DBFS;
/** Most edges listed in `sound.edges`. */
export const EDGE_LISTED = 20;

// The speed graph of a hero point (`review --speed`, #457): when a move reads mechanical. Judgments with a number, so
// warnings only. A constant speed is the tell of a key with no ease; a dead stop mid-move reads as a hitch.

/**
 * Fastest minus slowest over the mean speed of a stretch under which its speed counts as constant: no ease. Not 5 %: the
 * middle 20 % of the `in-out` key ease (smoothstep) varies by 4 %, and a sine ease's by 5 %, so 5 % flags eased moves.
 */
export const SPEED_LINEAR_SPREAD = 0.025;
/** Fewest frames a constant-speed stretch needs to be `linear`: over fewer, any curve looks constant at its top. */
export const SPEED_LINEAR_FRAMES = 6;
/** Least share of the whole move (first to last moving frame) a constant-speed stretch covers to be `linear`. */
export const SPEED_LINEAR_SHARE = 0.2;
/** Film px per frame under which the hero point stands still: a quarter pixel. */
export const SPEED_STOP_PX = 0.25;
/** Fewest still frames between two moving stretches that read as a dead `stop` (4 frames at 30 fps: a visible hitch). */
export const SPEED_STOP_FRAMES = 4;
/** Width a generated clip's alpha is read at for its hero point, px; the centre is an alpha-weighted mean, finer than a pixel. */
export const SPEED_ALPHA_WIDTH = 480;
