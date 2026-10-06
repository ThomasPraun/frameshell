/**
 * ffmpeg recipes for derived media (SPEC §6.3, ADR 0001). Bump
 * {@link RECIPE_VERSION} whenever an output changes: it is part of the cache
 * key, so old outputs are rebuilt instead of reused.
 */
export const RECIPE_VERSION = 3;

/** PCM sidecar and proxy audio rate (SPEC §6.3). */
export const SIDECAR_SAMPLE_RATE = 48_000;
/** Mono: the preview mixes one bus; ~165 MiB per 30 min (ADR 0001). */
export const SIDECAR_CHANNELS = 1;
/** Waveform resolution: 10 ms per peak. */
export const PEAKS_PER_SECOND = 100;
/** Fixed GOP: 0.5 s at 30 fps, bounds seek pre-roll (ADR 0001). */
export const PROXY_GOP = 15;
/** Proxy short side cap: 960x540 for 16:9, the size ADR 0001 measured. */
export const PROXY_SHORT_SIDE = 540;
/** Thumbnail height in px. */
export const THUMB_HEIGHT = 90;
/** Upper bound on thumbnails per asset; long assets space them further apart. */
export const MAX_THUMBS = 100;

/**
 * Exact ffmpeg rate for a project fps: integers stay integral, NTSC rates
 * (29.97, 59.94, 23.976) become `n*1000/1001`, anything else millihertz.
 */
export function fpsRational(fps: number): string {
  if (Math.abs(fps - Math.round(fps)) < 1e-6) return `${Math.round(fps)}/1`;
  const ntsc = Math.round((fps * 1001) / 1000);
  if (Math.abs((ntsc * 1000) / 1001 - fps) < 0.001) return `${ntsc * 1000}/1001`;
  return `${Math.round(fps * 1000)}/1000`;
}

/**
 * Audio filter putting samples on the source clock at `sampleRate`.
 * Timestamps start at source time 0 in every output: ffmpeg subtracts the
 * container start time from all streams alike, `first_pts=0` pads audio that
 * starts late, and `async=1` fills gaps VFR recorders leave, so the sidecar
 * sample index and the proxy frame index share one clock. Transcription audio
 * extracted from a source file uses it too, so word times match the sidecar.
 */
export function alignedAudioFilter(sampleRate: number): string {
  return `aresample=${sampleRate}:async=1:first_pts=0`;
}

const AUDIO_FILTER = alignedAudioFilter(SIDECAR_SAMPLE_RATE);

/** Common flags: quiet, overwrite, machine-readable progress on stdout. */
const BASE = ["-hide_banner", "-nostdin", "-loglevel", "error", "-nostats", "-progress", "pipe:1", "-y"];

/**
 * CFR preview proxy. `fps` with `start_time=0` duplicates or drops frames
 * against the source timestamps (VFR in, CFR out, sync kept) and pads a video
 * stream that starts late. No B-frames: decode order = display order, so
 * sample index = frame index for the WebCodecs preview. Always BT.709,
 * limited range, tagged: the source is read the way export reads it (its
 * tags, else ffmpeg's default), so the browser shows the colors export
 * renders; an untagged proxy would be guessed differently.
 */
export function proxyArgs(input: string, output: string, fps: number): string[] {
  return [
    ...BASE,
    ...["-i", input, "-map", "0:v:0", "-map", "0:a:0?", "-map_metadata", "-1"],
    ...["-vf", proxyVideoFilter(fps, "yuv420p"), "-fps_mode", "cfr", ...PROXY_COLOR_TAGS],
    ...["-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-profile:v", "high"],
    ...["-g", String(PROXY_GOP), "-keyint_min", String(PROXY_GOP), "-sc_threshold", "0", "-bf", "0"],
    ...["-force_key_frames", `expr:eq(mod(n,${PROXY_GOP}),0)`],
    ...["-af", AUDIO_FILTER, "-c:a", "aac", "-b:a", "128k"],
    ...["-movflags", "+faststart", "-f", "mp4", output],
  ];
}

/**
 * CFR preview proxy of a source with alpha (#90): VP9 WebM with the alpha
 * plane as a second VP9 stream (`alpha_mode=1`), the format the preview
 * already decodes for generated clip renders (ADR 0002). Same frame grid,
 * scale, colour tags and fixed GOP as {@link proxyArgs}; keyframes are forced
 * in colour and alpha alike, so every GOP start is a decode start. No
 * alt-ref frames (libvpx cannot encode them with alpha; without them every
 * block is one shown frame). No audio: the preview plays the PCM sidecar.
 * `decoder` comes from the probe: VP8/VP9 alpha is lost unless libvpx decodes it.
 */
export function alphaProxyArgs(input: string, output: string, fps: number, decoder: string | null): string[] {
  return [
    ...BASE,
    ...(decoder ? ["-c:v", decoder] : []),
    ...["-i", input, "-map", "0:v:0", "-an", "-map_metadata", "-1"],
    ...["-vf", proxyVideoFilter(fps, "yuva420p"), "-fps_mode", "cfr", ...PROXY_COLOR_TAGS],
    // Realtime: about 3x faster than `good` at 540p for a 35 % larger file; preview quality only.
    ...["-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-deadline", "realtime", "-cpu-used", "8", "-row-mt", "1"],
    ...["-crf", "32", "-b:v", "0", "-auto-alt-ref", "0"],
    ...["-g", String(PROXY_GOP), "-keyint_min", String(PROXY_GOP), "-force_key_frames", `expr:eq(mod(n,${PROXY_GOP}),0)`],
    ...["-f", "webm", output],
  ];
}

/** Output colour tags of every proxy: BT.709, limited range. */
const PROXY_COLOR_TAGS = ["-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv"];

/** CFR at `fps` from source time 0, short side capped, converted to BT.709 limited `pixFmt`. */
function proxyVideoFilter(fps: number, pixFmt: "yuv420p" | "yuva420p"): string {
  const shortSide = `min(iw\\,ih)`;
  const scale = `scale=w='trunc(iw*min(1\\,${PROXY_SHORT_SIDE}/${shortSide})/2)*2':h='trunc(ih*min(1\\,${PROXY_SHORT_SIDE}/${shortSide})/2)*2'`;
  return `fps=${fpsRational(fps)}:start_time=0,${scale}:out_color_matrix=bt709:out_range=tv,format=${pixFmt}`;
}

/** Raw s16le PCM sidecar of the first audio stream, same clock as the proxy. */
export function sidecarArgs(input: string, output: string): string[] {
  return [
    ...BASE,
    ...["-i", input, "-map", "0:a:0", "-vn", "-af", AUDIO_FILTER, "-ac", String(SIDECAR_CHANNELS)],
    ...["-c:a", "pcm_s16le", "-f", "s16le", output],
  ];
}

/**
 * JPEG thumbnails `dir/0001.jpg`… every `interval` seconds, the first at time 0.
 * image2 muxer reads every `%` in its output path as format specifier, so `%` in `dir` is escaped as `%%`.
 */
export function thumbnailArgs(input: string, dir: string, interval: number | null): string[] {
  const pattern = `${dir.replaceAll("%", "%%")}/%04d.jpg`;
  // `select`, not `fps`: always keeps the first frame, even of an asset shorter than one interval.
  const sample =
    interval === null ? [] : [`select='isnan(prev_selected_t)+gte(t-prev_selected_t\\,${interval - 0.001})'`];
  return [
    ...BASE,
    ...["-i", input, "-map", "0:v:0", "-vf", [...sample, `scale=-2:${THUMB_HEIGHT}`].join(",")],
    ...(interval === null ? ["-frames:v", "1"] : ["-fps_mode", "passthrough"]),
    ...["-q:v", "5", "-f", "image2", pattern],
  ];
}

/** Seconds between thumbnails: one per second, spread out to {@link MAX_THUMBS} for long assets. */
export function thumbnailInterval(duration: number): number {
  return Math.max(1, Math.ceil((duration / MAX_THUMBS) * 1000) / 1000);
}
