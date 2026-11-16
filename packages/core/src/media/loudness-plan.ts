import type { MediaClip, Timeline } from "@frameshell/schema";
import type { LoudnessReading, SoundRange } from "../analyze/loudness.js";
import { isBinaryError } from "../binaries/errors.js";

/**
 * The arithmetic that turns per-asset EBU R128 readings (`LoudnessStore`) into clip gains: `duck --level` and
 * `music.candidates` (ADR 0037 slice 3). Pure but for the reading callback. Readings are over the part of the file a
 * clip plays ({@link playedRange}), not the whole file.
 */

/**
 * Most distinct played ranges of one voice file that are measured each; a file cut into more pieces (after `cleanup`)
 * is read whole, since a reading per piece would cost more than the difference it makes.
 */
export const MAX_VOICE_RANGES = 8;

/** The seconds of its file that `clip` plays (`in` to `out`), rounded to whole frames of `fps`. */
export function playedRange(clip: Pick<MediaClip, "in" | "out">, fps: number): SoundRange {
  const frame = (seconds: number) => Math.round(seconds * fps) / fps;
  return { start: frame(clip.in), end: frame(clip.out) };
}

/** True peak over which a gain that raises a file warns, dBTP: the export's own ceiling (`LOUDNORM_TP`). */
export const PEAK_CEILING_DBTP = -1;

/** A gain in dB to 0.1 dB, the step a person types. */
export const roundDb = (value: number): number => Math.round(value * 10) / 10;

/** Gain that brings a file of integrated loudness `loudness` (LUFS) to `target` (LUFS). */
export const gainFor = (loudness: number, target: number): number => roundDb(target - loudness);

/** One voice clip's share of the voice: its file's loudness, the clip's own gain and the seconds it plays. */
export interface VoicePart {
  asset: string;
  /** Integrated loudness of the file, LUFS. */
  loudness: number;
  /** Static `audio.gain` of the clip, dB. */
  gain: number;
  /** Seconds the clip plays on the timeline. */
  seconds: number;
}

/**
 * Loudness of the voice, LUFS: the energy mean of the parts' loudness plus gain, weighted by the seconds each plays (a
 * short aside does not outweigh the interview). Null with no part.
 */
export function voiceLoudness(parts: readonly VoicePart[]): number | null {
  const total = parts.reduce((sum, part) => sum + part.seconds, 0);
  if (parts.length === 0 || total <= 0) return null;
  const power = parts.reduce((sum, part) => sum + part.seconds * 10 ** ((part.loudness + part.gain) / 10), 0);
  return roundDb(10 * Math.log10(power / total));
}

/**
 * The voice of the media clips on the `under` tracks of `timeline`: one {@link VoicePart} per clip that plays, its
 * loudness read over the part of the file the clip plays (the whole file for one cut into over
 * {@link MAX_VOICE_RANGES} pieces). Muted tracks and clips are not counted (as ducking does); nested timelines, silent
 * files and files that cannot be measured are named in `warnings`. A missing or failing ffmpeg (`Binary*` errors) is
 * thrown: nothing was heard.
 */
export async function voiceParts(
  timeline: Timeline,
  under: readonly string[],
  deps: { fps: number; reading(asset: string, range?: SoundRange): Promise<LoudnessReading> },
): Promise<{ parts: VoicePart[]; warnings: string[] }> {
  const parts: VoicePart[] = [];
  const warnings: string[] = [];
  const warn = (message: string) => {
    if (!warnings.includes(message)) warnings.push(message);
  };
  const voices: MediaClip[] = [];
  for (const id of under) {
    const track = timeline.tracks.find((candidate) => candidate.id === id);
    if (!track || (track.kind !== "video" && track.kind !== "audio") || track.muted === true) continue;
    for (const clip of track.clips) {
      if (clip.audio?.muted === true) continue;
      if (!("asset" in clip)) {
        if (clip.type === "timeline") warn(`${clip.id} on ${id} is a nested timeline: its loudness is not measured, so it does not count as voice.`);
        continue;
      }
      voices.push(clip);
    }
  }
  const rangeKey = (range: SoundRange) => `${range.start}-${range.end}`;
  const pieces = new Map<string, Set<string>>();
  for (const clip of voices) {
    const set = pieces.get(clip.asset) ?? new Set<string>();
    set.add(rangeKey(playedRange(clip, deps.fps)));
    pieces.set(clip.asset, set);
  }
  const readings = new Map<string, Promise<LoudnessReading | Error>>();
  for (const clip of voices) {
    const range = (pieces.get(clip.asset)?.size ?? 0) > MAX_VOICE_RANGES ? undefined : playedRange(clip, deps.fps);
    const cacheKey = `${clip.asset}\0${range ? rangeKey(range) : ""}`;
    let reading = readings.get(cacheKey);
    if (!reading) {
      reading = deps.reading(clip.asset, range).catch((error: unknown) => {
        if (isBinaryError(error)) throw error;
        return error instanceof Error ? error : new Error(String(error));
      });
      readings.set(cacheKey, reading);
    }
    const found = await reading;
    if (found instanceof Error) {
      warn(`${clip.asset} cannot be measured (${found.message}): it does not count as voice.`);
    } else if (found.integrated === null) {
      warn(`${clip.asset} is silent: it does not count as voice.`);
    } else {
      parts.push({ asset: clip.asset, loudness: found.integrated, gain: clip.audio?.gain ?? 0, seconds: (clip.out - clip.in) / (clip.speed ?? 1) });
    }
  }
  return { parts, warnings };
}

/** One music clip's static gain from `level`: the loudness of the part of its file it plays and the gain that brings it to the target. */
export interface ClipLevel {
  clip: string;
  /** Integrated loudness of the part of the file the clip plays, LUFS. */
  loudness: number;
  /** Static `audio.gain` to write, dB. */
  gain: number;
}

/** What {@link planLevels} found. */
export interface LevelPlan {
  /** Loudness of the voice, LUFS; null when there is none to measure. */
  voice: number | null;
  /** LUFS the music is set to (`voice - level`); null with no voice. */
  target: number | null;
  /** The clips whose gain is set. */
  clips: ClipLevel[];
  /** Voice files and clips left out, and why. */
  warnings: string[];
}

/**
 * The static gain `duck --level` sets on the media clips of audio track `track`: the voice of the `under` tracks is read
 * ({@link voiceParts}), the music at `level` dB under it, each clip by the loudness of the part of its file it plays.
 * `only` limits it to those clips (the ones `music.fit` moved). A clip with gain keys of its own (not duck keys) is left
 * alone and named, as are muted, non-media, silent and unmeasurable ones. Reads only.
 */
export async function planLevels(
  timeline: Timeline,
  fps: number,
  request: {
    track: string;
    under: readonly string[];
    level: number;
    only?: ReadonlySet<string> | undefined;
    /** Automatic keys (`auto` marks) the caller writes again after the gain is set, so they are not a clip's "own". Default: duck keys only. */
    replaced?: ReadonlySet<string> | undefined;
  },
  deps: { reading(asset: string, range?: SoundRange): Promise<LoudnessReading> },
): Promise<LevelPlan> {
  const replaced = request.replaced ?? new Set(["duck"]);
  const own = (key: { auto?: string | undefined; base?: number | undefined; baseAuto?: string | undefined }) =>
    !(key.auto && replaced.has(key.auto)) || (key.base !== undefined && !(key.baseAuto && replaced.has(key.baseAuto)));
  const voice = await voiceParts(timeline, request.under, { fps, reading: deps.reading });
  const voiceLufs = voiceLoudness(voice.parts);
  const warnings = new Set(voice.warnings);
  if (voiceLufs === null) return { voice: null, target: null, clips: [], warnings: [...warnings] };
  const target = roundDb(voiceLufs - request.level);
  const clips: ClipLevel[] = [];
  const track = timeline.tracks.find((candidate) => candidate.id === request.track);
  for (const clip of track?.kind === "audio" ? track.clips : []) {
    if (request.only && !request.only.has(clip.id)) continue;
    if (!("asset" in clip)) {
      warnings.add(`${clip.id} is not a media clip: its level is not set.`);
      continue;
    }
    if (clip.audio?.muted === true) continue;
    if (clip.keys?.gain?.some(own)) {
      warnings.add(`${clip.id} has gain keys of its own: its level is left as it is (\`clip key --prop gain --clear\` first to set it by loudness).`);
      continue;
    }
    const reading = await deps.reading(clip.asset, playedRange(clip, fps)).catch((error: unknown) => {
      if (isBinaryError(error)) throw error;
      warnings.add(`${clip.asset} cannot be measured (${error instanceof Error ? error.message : String(error)}): ${clip.id}'s level is left as it is.`);
      return null;
    });
    if (!reading) continue;
    if (reading.integrated === null) {
      warnings.add(`${clip.asset} is silent: ${clip.id}'s level is left as it is.`);
      continue;
    }
    clips.push({ clip: clip.id, loudness: reading.integrated, gain: gainFor(reading.integrated, target) });
  }
  return { voice: voiceLufs, target, clips, warnings: [...warnings] };
}

/**
 * The loudness `music.candidates` brings every file to: `given` (LUFS), else the quietest file's, so a gain never
 * raises a file and no candidate clips that was not already.
 */
export function candidateTarget(loudnesses: readonly number[], given: number | undefined): { target: number; source: "given" | "quietest" } {
  if (given !== undefined) return { target: given, source: "given" };
  return { target: Math.min(...loudnesses), source: "quietest" };
}

/** Warning when raising a file by `gain` dB puts its true peak over {@link PEAK_CEILING_DBTP}; null when it stays under or the peak is unknown. */
export function peakWarning(asset: string, truePeak: number | null, gain: number): string | null {
  if (truePeak === null || gain <= 0 || truePeak + gain <= PEAK_CEILING_DBTP) return null;
  return `${asset}: +${gain} dB puts its true peak at ${roundDb(truePeak + gain)} dBTP, over ${PEAK_CEILING_DBTP}: the export's limiter will bite on it. Pass a lower \`loudness\`.`;
}
