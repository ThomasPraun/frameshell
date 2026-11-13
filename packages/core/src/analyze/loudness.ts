import { runTool } from "../media/ffmpeg.js";

// Programme loudness of a file's sound by EBU R128 (ITU-R BS.1770 gating), measured by ffmpeg's `ebur128`.

/** What the loudness of a file's sound comes to. */
export interface LoudnessReading {
  /** Integrated loudness, LUFS; null for silence (nothing above the absolute gate). */
  integrated: number | null;
  /** Loudness range, LU; null for silence. */
  range: number | null;
  /** True peak of the loudest channel, dBTP; null for digital silence. */
  truePeak: number | null;
}

/**
 * The reading in the text of `ametadata=print` after `ebur128=metadata=1`: the last block of values, which holds
 * what was measured over the whole sound (the filter reports the running figures every 100 ms). Null when the text
 * has no reading.
 */
export function parseLoudness(text: string): LoudnessReading | null {
  const last = new Map<string, number>();
  for (const line of text.split("\n")) {
    const match = /^lavfi\.r128\.(I|LRA|true_peak)=(-?[0-9.]+|-?inf|nan)$/i.exec(line.trim());
    if (match) last.set(match[1]!, Number(match[2]!.replace(/^(-?)inf$/i, "$1Infinity")));
  }
  const integrated = last.get("I");
  if (integrated === undefined) return null;
  const finite = (value: number | undefined, digits: number): number | null =>
    value !== undefined && Number.isFinite(value) ? Math.round(value * 10 ** digits) / 10 ** digits : null;
  // The meter floors silence at -70 LUFS.
  const silent = !Number.isFinite(integrated) || integrated <= -70;
  const peak = last.get("true_peak");
  return {
    integrated: silent ? null : finite(integrated, 1),
    range: silent ? null : finite(last.get("LRA"), 1),
    truePeak: peak !== undefined && peak > 0 ? finite(20 * Math.log10(peak), 1) : null,
  };
}

/** Audio filters that keep the 200 Hz to 6 kHz band, what a phone speaker plays: `measureLoudness`'s `before`. */
export const PHONE_BAND_FILTER = "highpass=f=200,lowpass=f=6000";

/**
 * Measure the first audio stream of absolute `path`, after the audio filters `before` when given; null when ffmpeg
 * reports nothing (no audio). Rejects with ffmpeg's error.
 */
export async function measureLoudness(ffmpeg: string, path: string, signal?: AbortSignal, before?: string): Promise<LoudnessReading | null> {
  const text = await runTool(
    ffmpeg,
    ["-hide_banner", "-loglevel", "error", "-nostdin", "-i", path, "-map", "0:a:0", "-vn", "-af", `${before ? `${before},` : ""}ebur128=peak=true:metadata=1,ametadata=mode=print:file=-`, "-f", "null", "-"],
    signal ? { signal } : {},
  );
  return parseLoudness(text);
}
