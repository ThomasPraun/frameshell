// PROTOTYPE, throwaway. ffmpeg-static / ffprobe-static helpers.
import { execFileSync } from "node:child_process";
import ffmpegPath from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";

/** Local ffmpeg binary; nothing system-wide. */
export const FFMPEG = ffmpegPath;
/** Local ffprobe binary. */
export const FFPROBE = ffprobeStatic.path;

/**
 * Pixels checked at t=3 s. Expected alpha: corner 0 (empty), panel ~153
 * (rgba 0.6), dot 255 (opaque). Coordinates follow composition/index.html.
 */
export const SAMPLES = [
  { name: "empty corner", t: 3, x: 10, y: 10 },
  { name: "panel (rgba 0.6)", t: 3, x: 1550, y: 900 },
  { name: "dot (opaque)", t: 3, x: 2130, y: 340 },
];

/** Stream facts for the first video stream. */
export function probe(file) {
  const out = execFileSync(FFPROBE, [
    "-v", "error", "-select_streams", "v:0", "-count_packets",
    "-show_entries", "stream=codec_name,profile,pix_fmt,width,height,nb_read_packets:stream_tags=alpha_mode:format=duration",
    "-of", "json", file,
  ]);
  const j = JSON.parse(out);
  const s = j.streams[0];
  return {
    codec: s.codec_name,
    profile: s.profile,
    pixFmt: s.pix_fmt,
    alphaModeTag: s.tags?.alpha_mode ?? s.tags?.ALPHA_MODE,
    width: s.width,
    height: s.height,
    frames: Number(s.nb_read_packets),
    duration: Number(j.format?.duration),
  };
}

/**
 * Decoded alpha (0-255) of one pixel. VP9 needs the libvpx decoder: ffmpeg's
 * native vp9 decoder ignores the alpha side-channel and returns opaque frames.
 */
export function alphaAt(file, t, x, y, codec) {
  const args = ["-v", "error"];
  if (t != null) args.push("-ss", String(t));
  if (codec === "vp9") args.push("-c:v", "libvpx-vp9");
  args.push("-i", file, "-frames:v", "1", "-vf", `crop=1:1:${x}:${y},format=rgba`, "-f", "rawvideo", "-");
  const buf = execFileSync(FFMPEG, args);
  return buf[3];
}

/** Runs ffmpeg with array args (never a shell string). */
export function ffmpeg(args) {
  return execFileSync(FFMPEG, ["-hide_banner", "-v", "error", "-y", ...args], { stdio: ["ignore", "inherit", "inherit"] });
}
