import { stat } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { ErrorCode, RpcError } from "@frameshell/protocol";
import { lumaSpread, readActivity } from "../analyze/activity.js";
import { pictureSize } from "../analyze/picture.js";
import { pool } from "../export/service.js";
import { probeMedia, runTool } from "../media/ffmpeg.js";
import { readRawFrames } from "../media/raw-frames.js";
import { frameDifference } from "../multicam/motion.js";
import { type FrameRange, frameTime, timelineSampleStep } from "./plan.js";

// Where the frames of a review come from: an exported file decoded by ffmpeg, or a timeline rendered frame by frame.

/**
 * Motion of a range on the scale of `analyze` (grey frames 64 px on the long side): `energy[i]` is how much the picture
 * changed between sample `i - 1` and sample `i` (0 for the first), `times` their seconds, `spread[i]` the standard
 * deviation of sample `i`'s grey levels (0 flat, up to 128). Sample `i` is frame `first + i * step` of the film.
 */
export interface MotionSeries {
  times: number[];
  energy: number[];
  spread: number[];
  /** Frame of the film that sample 0 is. */
  first: number;
  /** Frames between samples: 1 when every frame was measured (a file), more for a timeline over 90 frames. */
  step: number;
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
  /** A file: whether it has a sound track. Absent for a timeline, whose sound is not measured. */
  audio?: boolean;
  /** Measure the motion of `range`; `scratch` is a folder it may fill (the caller removes it). */
  motion(range: FrameRange, scratch: string, signal?: AbortSignal): Promise<MotionSeries>;
}

/** Captures at once: each is an ffmpeg (a timeline frame also compiles its plan), so half the cores, 1 to 4. */
export function captureParallelism(): number {
  return Math.max(1, Math.min(4, Math.floor(availableParallelism() / 2)));
}

/** The series of `grey`, the pictures of frames `first`, `first + step`... of a film at `fps`. */
async function series(grey: AsyncIterable<Uint8Array>, fps: number, first: number, step: number): Promise<MotionSeries> {
  const out: MotionSeries = { times: [], energy: [], spread: [], first, step };
  let previous: Uint8Array | undefined;
  for await (const frame of grey) {
    out.times.push((first + out.times.length * step) / fps);
    out.energy.push(previous ? frameDifference(previous, frame) : 0);
    out.spread.push(lumaSpread(frame));
    previous = frame;
  }
  return out;
}

/**
 * The picture of exported file `path`, read with ffmpeg. Throws `AssetNotFound` for a missing file and
 * `InvalidOperation` for one with no picture to look at (audio, a still) or no frame rate. `op` names the method in
 * the errors.
 */
export async function fileSource(ffmpeg: string, ffprobe: string, path: string, op = "review"): Promise<FilmSource> {
  const found = await stat(path).catch(() => null);
  if (!found?.isFile()) throw new RpcError(ErrorCode.AssetNotFound, `${op}: ${path} is not a file.`, { path });
  const probe = await probeMedia(ffprobe, path).catch((error: unknown) => {
    throw new RpcError(ErrorCode.InvalidOperation, `${op}: ffprobe cannot read ${path}: ${(error as Error).message.split("\n")[0]}`, { op, field: "file" });
  });
  const video = probe.video;
  if (!video || video.still || !video.fps || probe.duration === null) {
    throw new RpcError(ErrorCode.InvalidOperation, `${op}: ${path} has no video with a frame rate and a length to look at.`, { op, field: "file" });
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
    audio: probe.audio !== null,
    async capture(frame, out) {
      // Mid-frame, so a rounding error in the seek never lands on a neighbour.
      await runTool(ffmpeg, [...base, "-ss", ((frame + 0.5) / fps).toFixed(4), "-i", path, "-map", "0:v:0", "-frames:v", "1", out]);
      if (await exists(out)) return;
      // The container is a little longer than its picture: take the last frame from the end.
      await runTool(ffmpeg, [...base, "-sseof", (-1.5 / fps).toFixed(4), "-i", path, "-map", "0:v:0", "-update", "1", "-frames:v", "1", out]);
      if (!(await exists(out))) throw new RpcError(ErrorCode.InvalidOperation, `${op}: ${path} has no picture at ${frameTime(frame, fps)} s.`, { op, field: "file" });
    },
    async motion(range, _scratch, signal) {
      // Every frame, read as `analyze` reads it: a file's rhythm is the one `analyze` reports.
      const read = await readActivity(ffmpeg, path, { width: video.width, height: video.height, fps, frames }, signal, undefined, range);
      return {
        times: Array.from(read.activity, (_, i) => (range.first + i) / fps),
        energy: Array.from(read.activity),
        spread: Array.from(read.spread),
        first: range.first,
        step: 1,
      };
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
      const grey = pictureSize(size.width, size.height);
      const stream = readRawFrames(ffmpeg, join(dir, "a%05d.png"), `scale=${grey.width}:${grey.height}:flags=area,format=gray`, grey.width * grey.height);
      return series(stream, fps, range.first, step);
    },
  };
}
