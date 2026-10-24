// Pure parts of the shoot recorder (ADR 0024): recording types, the 1440p screen cap, levels and the silence check.

/** Video types in order of preference: H.264 High, then Baseline, in MP4; WebM VP9 where MP4 is not offered. */
export const VIDEO_TYPES = ["video/mp4;codecs=avc1.640028", "video/mp4;codecs=avc1.42E01E", "video/webm;codecs=vp9"] as const;
/** Audio types in order of preference: AAC in MP4, then Opus in WebM. MP4 + Opus is avoided: about 100 ms off (spike Q1). */
export const AUDIO_TYPES = ["audio/mp4;codecs=mp4a.40.2", "audio/webm;codecs=opus"] as const;

/** First type of `kind` the recorder supports; null when none is. */
export function pickType(kind: "video" | "audio", supported: (type: string) => boolean): string | null {
  return (kind === "video" ? VIDEO_TYPES : AUDIO_TYPES).find(supported) ?? null;
}

/** Shorter side of a recorded screen or window at most, px (ADR 0024 decision 2). */
export const SCREEN_MAX = 1440;

/**
 * Size to scale a `width` x `height` capture to so its shorter side is at most {@link SCREEN_MAX}, aspect kept and
 * even (H.264 needs it); null when it already fits.
 */
export function capSize(width: number, height: number, max = SCREEN_MAX): { width: number; height: number } | null {
  const short = Math.min(width, height);
  if (!(short > max)) return null;
  const scale = max / short;
  const even = (value: number) => Math.max(2, Math.round((value * scale) / 2) * 2);
  return { width: even(width), height: even(height) };
}

/** Lowest level a meter shows, dBFS: digital silence. */
export const LEVEL_FLOOR = -100;

/** RMS level of `samples` (-1..1) in dBFS, never below {@link LEVEL_FLOOR}. */
export function levelDb(samples: ArrayLike<number>): number {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i]! * samples[i]!;
  const rms = samples.length > 0 ? Math.sqrt(sum / samples.length) : 0;
  return rms > 0 ? Math.max(LEVEL_FLOOR, 20 * Math.log10(rms)) : LEVEL_FLOOR;
}

/** Meter fill for a level, 0..1: -60 dBFS and below empty, 0 dBFS full. */
export function meterFill(db: number): number {
  return Math.min(1, Math.max(0, (db + 60) / 60));
}

/** Below this, system audio counts as silent, dBFS: an idle loopback track is about -91 (spike, owner runs). */
export const SILENCE_DB = -60;
/** System audio silent this long while on gets a warning, ms: the failure gives no error (ADR 0024 decision 2). */
export const SILENCE_WARN_MS = 10_000;

/** When the current silence began (ms), given the previous value and a level read at `now`; null while there is sound. */
export function silentSince(previous: number | null, db: number, now: number): number | null {
  if (db > SILENCE_DB) return null;
  return previous ?? now;
}

/** True once a silence that began at `since` has lasted {@link SILENCE_WARN_MS} at `now`. */
export function silentTooLong(since: number | null, now: number): boolean {
  return since !== null && now - since >= SILENCE_WARN_MS;
}

/** Recording time as `m:ss`, or `h:mm:ss` from an hour. */
export function elapsedLabel(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}` : `${minutes}:${seconds}`;
}
