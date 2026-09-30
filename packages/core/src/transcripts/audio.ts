import { spawn } from "node:child_process";

/**
 * Writes `output` as 16 kHz mono 16-bit PCM WAV from the first audio stream
 * of `input` (the transcription provider contract). `ffmpeg` resolves the
 * managed or overridden executable, installing it on first use.
 */
export type AudioExtractor = (input: string, output: string, ffmpeg: () => Promise<string>) => Promise<void>;

/** {@link AudioExtractor} running ffmpeg; args as an array, never a shell string. */
export const extractAudioWithFfmpeg: AudioExtractor = async (input, output, ffmpeg) => {
  const file = await ffmpeg();
  const args = ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-i", input];
  args.push("-map", "0:a:0", "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "-f", "wav", output);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(file, args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => (stderr = (stderr + chunk).slice(-4000)));
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg could not extract audio from ${input} (exit ${code}): ${stderr.trim()}`));
    });
  });
};
