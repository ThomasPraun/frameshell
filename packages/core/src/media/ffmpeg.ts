import { spawn } from "node:child_process";
import type { MediaProbe } from "@frameshell/protocol";

/** Options for {@link runTool}. */
export interface RunToolOptions {
  /** Kills the process when aborted. */
  signal?: AbortSignal;
  /**
   * Receives output seconds written so far. Requires `-progress pipe:1` in the
   * args (ffmpeg only); stdout is then parsed, not returned.
   */
  onProgress?: (seconds: number) => void;
}

/** Keep the end of stderr only: ffmpeg's cause is on the last lines. */
const STDERR_TAIL = 4000;

/**
 * Run ffmpeg or ffprobe to completion. Resolves with stdout; rejects with the
 * stderr tail on a non-zero exit, or with an abort error when `signal` fires.
 */
export function runTool(file: string, args: string[], options: RunToolOptions = {}): Promise<string> {
  const { signal, onProgress } = options;
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const child = spawn(file, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    let pending = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (!onProgress) {
        stdout += chunk;
        return;
      }
      pending += chunk;
      let newline: number;
      while ((newline = pending.indexOf("\n")) !== -1) {
        const line = pending.slice(0, newline).trim();
        pending = pending.slice(newline + 1);
        const match = /^out_time_us=(\d+)$/.exec(line);
        if (match) onProgress(Number(match[1]) / 1e6);
      }
    });
    child.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-STDERR_TAIL);
    });
    const onAbort = () => child.kill();
    signal?.addEventListener("abort", onAbort, { once: true });
    child.on("error", (error) => {
      signal?.removeEventListener("abort", onAbort);
      reject(error);
    });
    child.on("close", (code) => {
      signal?.removeEventListener("abort", onAbort);
      if (signal?.aborted) reject(new Error("aborted"));
      else if (code === 0) resolve(stdout);
      else reject(new ToolError(file, code, stderr.trim()));
    });
  });
}

/** Non-zero exit of ffmpeg or ffprobe. */
export class ToolError extends Error {
  override readonly name = "ToolError";

  constructor(
    readonly file: string,
    readonly code: number | null,
    readonly stderr: string,
  ) {
    super(`${file} exited with ${code}: ${stderr.split(/\r?\n/).slice(-3).join(" | ") || "no output"}`);
  }
}

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  sample_rate?: string;
  channels?: number;
  disposition?: { attached_pic?: number };
}

/**
 * ffprobe summary of `path`. Throws {@link ToolError} when ffprobe cannot
 * read it; a readable file with no audio or video yields both null.
 */
export async function probeMedia(ffprobe: string, path: string, signal?: AbortSignal): Promise<MediaProbe> {
  const out = await runTool(ffprobe, ["-v", "error", "-show_format", "-show_streams", "-of", "json", path], {
    ...(signal ? { signal } : {}),
  });
  const parsed = JSON.parse(out) as { streams?: FfprobeStream[]; format?: { format_name?: string; duration?: string } };
  const streams = parsed.streams ?? [];
  const format = parsed.format?.format_name ?? "unknown";
  const duration = Number(parsed.format?.duration);
  // Cover art in audio files is a one-picture "video" stream: not footage.
  const video = streams.find((s) => s.codec_type === "video" && !s.disposition?.attached_pic);
  const audio = streams.find((s) => s.codec_type === "audio");
  const still = /(^|,)(image2|\w+_pipe)(,|$)/.test(format);
  const avg = rate(video?.avg_frame_rate);
  const real = rate(video?.r_frame_rate);
  return {
    duration: Number.isFinite(duration) && duration > 0 ? duration : null,
    format,
    video: video
      ? {
          codec: video.codec_name ?? "unknown",
          width: video.width ?? 0,
          height: video.height ?? 0,
          fps: still ? null : avg,
          // Containers report the tick rate as r_frame_rate; a lower average means irregular frame intervals.
          vfr: !still && avg !== null && real !== null && Math.abs(avg - real) > 0.01,
          still,
        }
      : null,
    audio: audio
      ? { codec: audio.codec_name ?? "unknown", sampleRate: Number(audio.sample_rate) || 0, channels: audio.channels ?? 0 }
      : null,
  };
}

/** `30000/1001` → 29.97; null for `0/0` or garbage. */
function rate(value: string | undefined): number | null {
  const [num, den] = (value ?? "").split("/").map(Number);
  if (!num || !den || !Number.isFinite(num / den)) return null;
  return num / den;
}
