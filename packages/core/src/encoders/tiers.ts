import type { EncoderName, QualityTier } from "@frameshell/protocol";

/** Encoders tried in this order: the first that really encodes on the machine is used. */
export const ENCODER_PREFERENCE = ["h264_videotoolbox", "h264_nvenc", "libx264"] as const satisfies readonly EncoderName[];

/** Frame size and rate an encode runs at; VideoToolbox sets its bitrate from them. */
export interface EncodeTarget {
  width: number;
  height: number;
  /** Output frames per second. */
  fps: number;
}

/** Highest frame rate each tier keeps; null = the source rate. */
const TIER_FPS_CAP: Readonly<Record<QualityTier, number | null>> = {
  master: null,
  preview: null,
  draft: 30,
  final: null,
};

interface TierSettings {
  x264: { preset: string; crf: number };
  nvenc: { preset: string; cq: number };
  /** VideoToolbox has no constant quality: bitrate = width x height x fps x bitsPerPixel. */
  bitsPerPixel: number;
  /** Tag the stream bt709 (limited range) so players read the colours the way export made them. */
  tagBt709: boolean;
}

/**
 * Master and preview numbers are the ones measured for ticket #475. Draft has none of its own: x264 is the
 * ticket's CRF 22 veryfast, NVENC and VideoToolbox sit between preview and master (review rounds read the
 * picture, not the grain). Final is the master quality with the slowest x264 preset.
 */
const SETTINGS: Readonly<Record<QualityTier, TierSettings>> = {
  master: { x264: { preset: "medium", crf: 16 }, nvenc: { preset: "p6", cq: 17 }, bitsPerPixel: 0.25, tagBt709: true },
  preview: { x264: { preset: "veryfast", crf: 26 }, nvenc: { preset: "p5", cq: 28 }, bitsPerPixel: 0.06, tagBt709: false },
  draft: { x264: { preset: "veryfast", crf: 22 }, nvenc: { preset: "p5", cq: 25 }, bitsPerPixel: 0.1, tagBt709: false },
  final: { x264: { preset: "slow", crf: 16 }, nvenc: { preset: "p6", cq: 17 }, bitsPerPixel: 0.25, tagBt709: true },
};

const BT709_TAGS = ["-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv"];

/** VideoToolbox bitrate in kbit/s for a tier at `target`: about 62 Mb/s for a master at 4K30. */
export function videoToolboxKbps(tier: QualityTier, target: EncodeTarget): number {
  return Math.round((target.width * target.height * target.fps * SETTINGS[tier].bitsPerPixel) / 1000);
}

/** Output frame rate of `tier` for a source of `fps`: capped at the tier's ceiling. */
export function tierFps(tier: QualityTier, fps: number): number {
  const cap = TIER_FPS_CAP[tier];
  return cap === null ? fps : Math.min(fps, cap);
}

/** ffmpeg video arguments (codec, rate control, pixel format, colour tags) for H.264 at `tier`. */
export function tierVideoArgs(encoder: EncoderName, tier: QualityTier, target: EncodeTarget): string[] {
  const settings = SETTINGS[tier];
  const tags = settings.tagBt709 ? BT709_TAGS : [];
  switch (encoder) {
    case "libx264":
      return ["-c:v", "libx264", "-preset", settings.x264.preset, "-crf", String(settings.x264.crf), "-profile:v", "high", "-pix_fmt", "yuv420p", ...tags];
    case "h264_nvenc":
      return [
        ...["-c:v", "h264_nvenc", "-preset", settings.nvenc.preset, "-rc", "vbr", "-cq", String(settings.nvenc.cq), "-b:v", "0"],
        ...["-profile:v", "high", "-pix_fmt", "yuv420p", ...tags],
      ];
    case "h264_videotoolbox":
      return ["-c:v", "h264_videotoolbox", "-b:v", `${videoToolboxKbps(tier, target)}k`, "-profile:v", "high", "-pix_fmt", "yuv420p", ...tags];
  }
}
