import { readRawFrames } from "../media/raw-frames.js";
import { frameDifference } from "../multicam/motion.js";
import { CELLS, type PictureSeries, cellStats } from "./events.js";
import { type LookBuilder, frameLook, luma } from "./look.js";

// One pass over every frame of the film, small: the look of each shot, and the series rhythm and events are found on.

/** Longest side of the frames the picture is measured on, px: area-averaged, so a thin caption still moves a cell. */
export const PICTURE_LONG_SIDE = 64;
/** Longest film the picture is measured on, seconds; beyond it a warning says the measures stop there. */
export const MAX_PICTURE_S = 3600;

/** Size the frames of a `width` x `height` film are measured at: {@link PICTURE_LONG_SIDE} on the long side, at least a grid cell a side. */
export function pictureSize(width: number, height: number): { width: number; height: number } {
  const scale = PICTURE_LONG_SIDE / Math.max(width, height);
  return { width: Math.max(8, Math.round(width * scale)), height: Math.max(6, Math.round(height * scale)) };
}

/** What {@link readPicture} reads. */
export interface PictureRequest {
  ffmpeg: string;
  /** Absolute path of the video. */
  file: string;
  film: { width: number; height: number; fps: number; frames: number };
  /** Index of the shot a frame belongs to; `looks[shotAt(frame)]` gets the frame. */
  shotAt(frame: number): number;
  /** One builder per shot. */
  looks: readonly LookBuilder[];
  /** Gets every frame. */
  overall: LookBuilder;
  signal?: AbortSignal | undefined;
  /** Fraction read, 0 to 1. */
  progress?: ((fraction: number) => void) | undefined;
}

/** The series of the frames read, and whether the film was longer than {@link MAX_PICTURE_S}. */
export interface PictureRead {
  series: PictureSeries;
  truncated: boolean;
}

/**
 * Every frame of the film (at its own rate, none dropped or repeated) through ffmpeg at {@link PICTURE_LONG_SIDE}: feeds the
 * look builders and returns the brightness, activity and cell series. Stops at {@link MAX_PICTURE_S}.
 */
export async function readPicture(request: PictureRequest): Promise<PictureRead> {
  const { film, signal } = request;
  const { width, height } = pictureSize(film.width, film.height);
  const limit = Math.floor(MAX_PICTURE_S * film.fps + 1e-6);
  const wanted = Math.min(film.frames, limit);
  const brightness = new Float32Array(wanted);
  const activity = new Float32Array(wanted);
  const cellLuma = new Float32Array(wanted * CELLS);
  const cellDetail = new Float32Array(wanted * CELLS);
  const cellLumaOne = new Float32Array(CELLS);
  const cellDetailOne = new Float32Array(CELLS);
  const grey = [new Uint8Array(width * height), new Uint8Array(width * height)];
  const range = wanted < film.frames ? { from: 0, to: MAX_PICTURE_S } : undefined;
  let index = 0;
  for await (const rgb of readRawFrames(request.ffmpeg, request.file, `fps=${film.fps},scale=${width}:${height}:flags=area,format=rgb24`, width * height * 3, range)) {
    signal?.throwIfAborted();
    if (index >= wanted) break;
    const current = grey[index % 2]!;
    for (let i = 0; i < width * height; i++) current[i] = Math.round(luma(rgb[i * 3]!, rgb[i * 3 + 1]!, rgb[i * 3 + 2]!));
    const figures = frameLook(rgb, width, height);
    brightness[index] = figures.brightness;
    activity[index] = index === 0 ? 0 : frameDifference(grey[(index + 1) % 2]!, current);
    cellStats(current, width, height, cellLumaOne, cellDetailOne);
    cellLuma.set(cellLumaOne, index * CELLS);
    cellDetail.set(cellDetailOne, index * CELLS);
    request.looks[request.shotAt(index)]!.add(rgb, width, height, figures);
    request.overall.add(rgb, width, height, figures);
    index++;
    if (index % 30 === 0) request.progress?.(index / wanted);
  }
  const frames = index;
  return {
    series: {
      frames,
      brightness: brightness.subarray(0, frames),
      activity: activity.subarray(0, frames),
      cellLuma: cellLuma.subarray(0, frames * CELLS),
      cellDetail: cellDetail.subarray(0, frames * CELLS),
    },
    truncated: wanted < film.frames,
  };
}
