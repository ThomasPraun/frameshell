import { spawn } from "node:child_process";
import { alignedAudioFilter } from "../media/recipe.js";

/** Sample rate whisper-style providers expect (provider contract). */
export const TRANSCRIPTION_SAMPLE_RATE = 16_000;

/** Audio to extract from: a media file, or a headerless PCM file such as the ingest sidecar. */
export interface AudioInput {
  /** Absolute path. */
  path: string;
  /** Layout of a headerless PCM file; absent = container file ffmpeg probes. */
  raw?: { format: "s16le"; sampleRate: number; channels: number } | undefined;
}

/**
 * Writes `output` as 16 kHz mono 16-bit PCM WAV (the transcription provider
 * contract) from `input`: a raw PCM file, or the first audio stream of a media
 * file. `ffmpeg` resolves the managed or overridden executable, installing it
 * on first use.
 */
export type AudioExtractor = (input: AudioInput, output: string, ffmpeg: () => Promise<string>) => Promise<void>;

/**
 * {@link AudioExtractor} running ffmpeg; args as an array, never a shell string.
 * Media files go through the ingest clock filter, so their samples line up
 * with the PCM sidecar and the CFR proxy. Raw PCM is already on that clock and
 * is only resampled.
 */
export const extractAudioWithFfmpeg: AudioExtractor = async (input, output, ffmpeg) => {
  const file = await ffmpeg();
  await new Promise<void>((resolve, reject) => {
    const child = spawn(file, extractArgs(input, output), { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => (stderr = (stderr + chunk).slice(-4000)));
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg could not extract audio from ${input.path} (exit ${code}): ${stderr.trim()}`));
    });
  });
};

/** ffmpeg arguments of {@link extractAudioWithFfmpeg}. */
function extractArgs(input: AudioInput, output: string): string[] {
  const args = ["-hide_banner", "-loglevel", "error", "-nostdin", "-y"];
  if (input.raw) {
    const { format, sampleRate, channels } = input.raw;
    args.push("-f", format, "-ar", String(sampleRate), "-ac", String(channels), "-i", input.path);
  } else {
    args.push("-i", input.path, "-map", "0:a:0", "-vn", "-af", alignedAudioFilter(TRANSCRIPTION_SAMPLE_RATE));
  }
  args.push("-ac", "1", "-ar", String(TRANSCRIPTION_SAMPLE_RATE), "-c:a", "pcm_s16le", "-f", "wav", output);
  return args;
}
