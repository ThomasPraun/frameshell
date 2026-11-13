import type { Timeline } from "@frameshell/schema";
import type { LoudnessReading } from "../analyze/loudness.js";
import { isBinaryError } from "../binaries/errors.js";

/**
 * The arithmetic that turns per-asset EBU R128 readings (`LoudnessStore`) into clip gains: `duck --level` and
 * `music.candidates` (ADR 0037 slice 3). Pure but for the reading callback.
 */

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
 * The voice of the media clips on the `under` tracks of `timeline`: one {@link VoicePart} per clip that plays. Muted
 * tracks and clips are not counted (as ducking does); nested timelines, silent files and files that cannot be measured
 * are named in `warnings`. A missing or failing ffmpeg (`Binary*` errors) is thrown: nothing was heard.
 */
export async function voiceParts(
  timeline: Timeline,
  under: readonly string[],
  deps: { reading(asset: string): Promise<LoudnessReading> },
): Promise<{ parts: VoicePart[]; warnings: string[] }> {
  const parts: VoicePart[] = [];
  const warnings: string[] = [];
  const warn = (message: string) => {
    if (!warnings.includes(message)) warnings.push(message);
  };
  const readings = new Map<string, Promise<LoudnessReading | Error>>();
  for (const id of under) {
    const track = timeline.tracks.find((candidate) => candidate.id === id);
    if (!track || (track.kind !== "video" && track.kind !== "audio") || track.muted === true) continue;
    for (const clip of track.clips) {
      if (clip.audio?.muted === true) continue;
      if (!("asset" in clip)) {
        if (clip.type === "timeline") warn(`${clip.id} on ${id} is a nested timeline: its loudness is not measured, so it does not count as voice.`);
        continue;
      }
      let reading = readings.get(clip.asset);
      if (!reading) {
        reading = deps.reading(clip.asset).catch((error: unknown) => {
          if (isBinaryError(error)) throw error;
          return error instanceof Error ? error : new Error(String(error));
        });
        readings.set(clip.asset, reading);
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
  }
  return { parts, warnings };
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
