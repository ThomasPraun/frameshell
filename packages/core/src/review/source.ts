import { stat } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { ErrorCode, RpcError } from "@frameshell/protocol";
import { pool } from "../export/service.js";
import { probeMedia, runTool } from "../media/ffmpeg.js";
import { readRawFrames } from "../media/raw-frames.js";
import { ENERGY_WIDTH, type FrameRange, fileSampleRate, frameTime, tileHeight, timelineSampleStep } from "./plan.js";

// Where the frames of a review come from: an exported file decoded by ffmpeg, or a timeline rendered frame by frame.

/** Motion of a range: `energy[i]` is how much the grey picture changed between sample `i - 1` and sample `i` (0 for the first), `times` their seconds. */
export interface MotionSeries {
  times: number[];
  energy: number[];
}

/** A film frames can be taken from. */
export interface FilmSource {
  /** Frames per second, frames in all, and the size of one frame, px. */
  fps: number;
  frames: number;
  width: number;
  height: number;
  /** Write frame `frame` (0-based) as a PNG to absolute `out`. */
  capture(frame: number, out: string): Promise<void>;
  /** Measure the motion of `range`; `scratch` is a folder it may fill (the caller removes it). */
  motion(range: FrameRange, scratch: string, signal?: AbortSignal): Promise<MotionSeries>;
}

/** Captures at once: each is an ffmpeg (a timeline frame also compiles its plan), so half the cores, 1 to 4. */
export function captureParallelism(): number {
  return Math.max(1, Math.min(4, Math.floor(availableParallelism() / 2)));
}

/** Mean absolute difference of two grey frames of equal size, 0 to 255. */
export function meanAbsDiff(a: Uint8Array, b: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i]! - b[i]!);
  return sum / a.length;
}

/** The series of consecutive frames `grey`, sampled at `times`. */
async function series(grey: AsyncIterable<Uint8Array>, times: (index: number) => number): Promise<MotionSeries> {
  const out: MotionSeries = { times: [], energy: [] };
  let previous: Uint8Array | undefined;
  for await (const frame of grey) {
    out.times.push(times(out.times.length));
    out.energy.push(previous ? meanAbsDiff(previous, frame) : 0);
    previous = frame;
  }
  return out;
}

/** Size of the grey frames the motion measure compares for pictures `width` x `height`. */
function greySize(width: number, height: number): { width: number; height: number } {
  return { width: ENERGY_WIDTH, height: tileHeight(ENERGY_WIDTH, width / height) };
}

/**
 * The picture of exported file `path`, read with ffmpeg. Throws `AssetNotFound` for a missing file and
 * `InvalidOperation` for one with no picture to look at (audio, a still) or no frame rate.
 */
export async function fileSource(ffmpeg: string, ffprobe: string, path: string): Promise<FilmSource> {
  const found = await stat(path).catch(() => null);
  if (!found?.isFile()) throw new RpcError(ErrorCode.AssetNotFound, `review: ${path} is not a file.`, { path });
  const probe = await probeMedia(ffprobe, path).catch((error: unknown) => {
    throw new RpcError(ErrorCode.InvalidOperation, `review: ffprobe cannot read ${path}: ${(error as Error).message.split("\n")[0]}`, { op: "review", field: "file" });
  });
  const video = probe.video;
  if (!video || video.still || !video.fps || probe.duration === null) {
    throw new RpcError(ErrorCode.InvalidOperation, `review: ${path} has no video with a frame rate and a length to look at.`, { op: "review", field: "file" });
  }
  const fps = video.fps;
  const frames = Math.floor(probe.duration * fps + 1e-6);
  const base = ["-hide_banner", "-loglevel", "error", "-nostdin", "-y"];
  const exists = async (file: string) => (await stat(file).catch(() => null))?.isFile() === true;
  return {
    fps,
    frames,
    width: video.width,
    height: video.height,
    async capture(frame, out) {
      // Mid-frame, so a rounding error in the seek never lands on a neighbour.
      await runTool(ffmpeg, [...base, "-ss", ((frame + 0.5) / fps).toFixed(4), "-i", path, "-map", "0:v:0", "-frames:v", "1", out]);
      if (await exists(out)) return;
      // The container is a little longer than its picture: take the last frame from the end.
      await runTool(ffmpeg, [...base, "-sseof", (-1.5 / fps).toFixed(4), "-i", path, "-map", "0:v:0", "-update", "1", "-frames:v", "1", out]);
      if (!(await exists(out))) throw new RpcError(ErrorCode.InvalidOperation, `review: ${path} has no picture at ${frameTime(frame, fps)} s.`, { op: "review", field: "file" });
    },
    async motion(range, _scratch, signal) {
      const rate = fileSampleRate((range.end - range.first) / fps, fps);
      const grey = greySize(video.width, video.height);
      const from = range.first / fps;
      const stream = readRawFrames(ffmpeg, path, `fps=${rate},scale=${grey.width}:${grey.height}:flags=area,format=gray`, grey.width * grey.height, { from, to: range.end / fps });
      signal?.throwIfAborted();
      return series(stream, (i) => from + i / rate);
    },
  };
}

/** What {@link timelineSource} needs of the `frame` method. */
export interface TimelineFrames {
  /** Render the frame showing at timeline second `at` to PNG `out`; resolves with its size. */
  render(at: number, out: string): Promise<{ width: number; height: number }>;
}

/**
 * The picture of a timeline of `frames` frames at `fps`, rendered one frame at a time through `frames` (the `frame`
 * method: draft work that matches `render`). The first capture is made at once to learn the frame size; it also
 * renders the generated clips, so the concurrent ones after it find them cached.
 */
export async function timelineSource(ffmpeg: string, fps: number, frames: number, render: TimelineFrames["render"], scratch: string): Promise<FilmSource> {
  const size = await render(0.5 / fps, join(scratch, "size.png"));
  return {
    fps,
    frames,
    width: size.width,
    height: size.height,
    async capture(frame, out) {
      await render((frame + 0.5) / fps, out);
    },
    async motion(range, dir, signal) {
      const step = timelineSampleStep(range.end - range.first);
      const sampled: number[] = [];
      for (let frame = range.first; frame < range.end; frame += step) sampled.push(frame);
      const pattern = (i: number) => join(dir, `a${String(i + 1).padStart(5, "0")}.png`);
      await pool(sampled, captureParallelism(), async (frame, i) => {
        signal?.throwIfAborted();
        await render((frame + 0.5) / fps, pattern(i));
      });
      const grey = greySize(size.width, size.height);
      const stream = readRawFrames(ffmpeg, join(dir, "a%05d.png"), `scale=${grey.width}:${grey.height}:flags=area,format=gray`, grey.width * grey.height);
      return series(stream, (i) => sampled[i]! / fps);
    },
  };
}
