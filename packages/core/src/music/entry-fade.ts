import type { MediaClip } from "@frameshell/schema";

/**
 * Milliseconds of the sample-accurate fade in a music entry gets (`audio.fadeInMs`, ADR 0037): short enough not to
 * touch the music, long enough that a clip cut mid-waveform does not click. Below a frame, so `fadeIn` cannot hold it.
 */
export const MUSIC_ENTRY_FADE_MS = 5;

/**
 * Whether `music shape` and `music fit` give `clip` the {@link MUSIC_ENTRY_FADE_MS} fade in: not where the person (or an
 * earlier run) already set the edge, by a sound fade (`audio.fadeInMs`), a frame fade (`fadeIn`) or a dissolve.
 */
export function needsEntryFade(clip: Pick<MediaClip, "audio" | "fadeIn" | "dissolve">): boolean {
  return clip.audio?.fadeInMs === undefined && clip.fadeIn === undefined && clip.dissolve === undefined;
}
