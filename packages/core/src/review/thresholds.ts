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
/** Width the alpha of a generated clip is read at, px. */
export const GRAPHIC_WIDTH = 160;
/** Most frames of a generated clip measured. */
export const GRAPHIC_SAMPLES = 12;
/** Most frames of a generated clip measured per second. */
export const GRAPHIC_HZ = 4;
