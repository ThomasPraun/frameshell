import { open, readFile } from "node:fs/promises";
import { mediaTools, run, runBuffer } from "./media-tools.js";

/** Time of the sync marks in {@link makeVfrRecording}: first white frame and beep onset. */
export const SYNC_MARK_S = 1;

/**
 * Tiny VFR recording like a phone or OBS capture: frames at irregular
 * intervals (every other 60 fps frame plus some extras), a white flash and a
 * 1 kHz beep both starting at {@link SYNC_MARK_S}, 44.1 kHz audio.
 */
export async function makeVfrRecording(path: string, durationS = 2.5): Promise<void> {
  const { ffmpeg } = await mediaTools();
  await run(ffmpeg, [
    ...["-hide_banner", "-loglevel", "error", "-y"],
    ...["-f", "lavfi", "-i", `color=c=black:s=160x120:r=60:d=${durationS}`],
    ...["-f", "lavfi", "-i", `aevalsrc='if(between(t,${SYNC_MARK_S},${SYNC_MARK_S + 0.2}),0.5*sin(2*PI*1000*t),0)':s=44100:d=${durationS}`],
    "-filter:v",
    `select='not(mod(n\\,2))+eq(mod(n\\,7)\\,3)',drawbox=x=0:y=0:w=iw:h=ih:color=white:t=fill:enable='gte(t,${SYNC_MARK_S})'`,
    ...["-fps_mode", "vfr", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", path],
  ]);
}

/** Short CFR clip of a given size, test pattern plus tone. */
export async function makeClip(path: string, { width = 320, height = 240, fps = 30, durationS = 1 } = {}): Promise<void> {
  const { ffmpeg } = await mediaTools();
  await run(ffmpeg, [
    ...["-hide_banner", "-loglevel", "error", "-y"],
    ...["-f", "lavfi", "-i", `testsrc2=s=${width}x${height}:r=${fps}:d=${durationS}`],
    ...["-f", "lavfi", "-i", `sine=f=440:r=48000:d=${durationS}`],
    ...["-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", path],
  ]);
}

/**
 * Short VP9 WebM, test pattern plus tone. With `alpha` (default) the left half
 * is opaque and the right half at alpha 64, stored as VP9 alpha
 * (`alpha_mode=1`) the way overlay renders are; without it, plain opaque VP9.
 */
export async function makeVp9Clip(path: string, { alpha = true, width = 320, height = 180, fps = 24, durationS = 1 } = {}): Promise<void> {
  const { ffmpeg } = await mediaTools();
  const picture = alpha
    ? `testsrc2=s=${width}x${height}:r=${fps}:d=${durationS},format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(lt(X,W/2),255,64)'`
    : `testsrc2=s=${width}x${height}:r=${fps}:d=${durationS}`;
  await run(ffmpeg, [
    ...["-hide_banner", "-loglevel", "error", "-y"],
    ...["-f", "lavfi", "-i", picture],
    ...["-f", "lavfi", "-i", `sine=f=440:r=48000:d=${durationS}`],
    ...["-c:v", "libvpx-vp9", "-pix_fmt", alpha ? "yuva420p" : "yuv420p", "-auto-alt-ref", "0", "-deadline", "realtime", "-b:v", "0", "-crf", "30"],
    // ffmpeg's own Opus encoder: in every build, unlike libopus.
    ...["-c:a", "opus", "-strict", "-2", "-shortest", path],
  ]);
}

/** RGBA bytes of the first frame of `path`, decoded with libvpx so VP9 alpha survives (ADR 0002). */
export async function firstFrameRgba(path: string): Promise<Buffer> {
  const { ffmpeg } = await mediaTools();
  return runBuffer(ffmpeg, [
    ...["-hide_banner", "-loglevel", "error", "-c:v", "libvpx-vp9", "-i", path, "-map", "0:v:0"],
    ...["-frames:v", "1", "-vf", "format=rgba", "-f", "rawvideo", "-"],
  ]);
}

/** ffprobe `-show_entries` output as JSON. */
export async function ffprobeJson(path: string, args: string[]): Promise<Record<string, unknown>> {
  const { ffprobe } = await mediaTools();
  const { stdout } = await run(ffprobe, ["-v", "error", ...args, "-of", "json", path]);
  return JSON.parse(stdout) as Record<string, unknown>;
}

/** Mean luma (0-255) of every decoded video frame, in decode = display order. */
export async function frameLuma(path: string): Promise<number[]> {
  const { ffmpeg } = await mediaTools();
  const raw = await runBuffer(ffmpeg, [
    ...["-hide_banner", "-loglevel", "error", "-i", path, "-map", "0:v:0"],
    ...["-vf", "scale=8:8,format=gray", "-fps_mode", "passthrough", "-f", "rawvideo", "-"],
  ]);
  const means: number[] = [];
  for (let offset = 0; offset + 64 <= raw.length; offset += 64) {
    let sum = 0;
    for (let i = 0; i < 64; i++) sum += raw[offset + i]!;
    means.push(sum / 64);
  }
  return means;
}

/** Signed 16-bit mono samples of a raw s16le file. */
export async function readS16le(path: string): Promise<Int16Array> {
  const bytes = await readFile(path);
  return new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.length / 2));
}

/** Index of the first sample whose magnitude exceeds `threshold`, or -1. */
export function firstLoudSample(samples: Int16Array, threshold = 3000): number {
  return samples.findIndex((s) => Math.abs(s) > threshold);
}

/** Top-level MP4 box types in file order, e.g. `["ftyp", "moov", "mdat"]`. */
export async function topLevelBoxes(path: string): Promise<string[]> {
  const handle = await open(path, "r");
  try {
    const { size } = await handle.stat();
    const boxes: string[] = [];
    const header = Buffer.alloc(16);
    for (let offset = 0; offset < size; ) {
      await handle.read(header, 0, 16, offset);
      let length = header.readUInt32BE(0);
      boxes.push(header.toString("latin1", 4, 8));
      if (length === 1) length = Number(header.readBigUInt64BE(8));
      if (length === 0) break;
      offset += length;
    }
    return boxes;
  } finally {
    await handle.close();
  }
}
