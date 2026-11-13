import type { ExportPreset } from "@frameshell/schema";

/** Integrated loudness target when neither the preset nor `frameshell.json` sets one (SPEC §3.5). */
export const DEFAULT_LOUDNESS_LUFS = -17;

/** Preset used when neither the caller nor `export.defaultPreset` names one. */
export const DEFAULT_PRESET_ID = "youtube-1080p";

/** Side of the box the `gif` preset fits a format inside, px. */
const GIF_BOX = 1200;

/**
 * Presets shipped with the core, as data (SPEC §8.2 shape). No `loudness`:
 * the project's `export.loudness` or {@link DEFAULT_LOUDNESS_LUFS} applies.
 * `crf` sets quality; `bitrateKbps` caps peaks (YouTube's upload guidance).
 */
export const BUILTIN_PRESETS: readonly ExportPreset[] = [
  {
    id: "youtube-1080p",
    label: "YouTube 1080p (16:9, H.264 + AAC)",
    container: "mp4",
    video: { codec: "h264", width: 1920, height: 1080, crf: 18, bitrateKbps: 12_000 },
    audio: { codec: "aac", bitrateKbps: 320, sampleRate: 48_000 },
  },
  {
    id: "youtube-1440p",
    label: "YouTube 1440p (16:9, H.264 + AAC)",
    container: "mp4",
    video: { codec: "h264", width: 2560, height: 1440, crf: 18, bitrateKbps: 24_000 },
    audio: { codec: "aac", bitrateKbps: 320, sampleRate: 48_000 },
  },
  {
    id: "vertical-1080x1920",
    label: "Vertical 1080x1920 (9:16 shorts/reels, H.264 + AAC)",
    container: "mp4",
    video: { codec: "h264", width: 1080, height: 1920, crf: 18, bitrateKbps: 12_000 },
    audio: { codec: "aac", bitrateKbps: 320, sampleRate: 48_000 },
  },
  {
    id: "gif",
    label: "GIF (loops, no sound, at most 1200 px, 350 frames, 30 fps)",
    container: "gif",
    video: { codec: "gif", width: GIF_BOX, height: GIF_BOX, fit: "inside" },
  },
];

/** Highest frame rate of a GIF export: browsers raise the delays 1/100 s cannot hold above this (ADR 0039). */
export const GIF_MAX_FPS = 30;

/** Most frames a GIF export renders; more is refused before rendering (ADR 0039). */
export const GIF_MAX_FRAMES = 350;

/** Size above which a finished GIF gets a warning, bytes: platforms and READMEs stop previewing around here. */
export const GIF_WARN_BYTES = 15 * 1024 * 1024;

/**
 * Size of `frame` fitted inside the `box` of a `fit: "inside"` preset: the frame's aspect, scaled down to fit the box
 * and never up. Odd sizes are kept (GIF has no chroma subsampling).
 */
export function fitInside(box: { width: number; height: number }, frame: { width: number; height: number }): { width: number; height: number } {
  const scale = Math.min(1, box.width / frame.width, box.height / frame.height);
  return { width: Math.max(1, Math.round(frame.width * scale)), height: Math.max(1, Math.round(frame.height * scale)) };
}

/**
 * Loudness target for a render: the preset's own `loudness`, else the
 * project's `export.loudness`, else {@link DEFAULT_LOUDNESS_LUFS}.
 */
export function loudnessTarget(preset: ExportPreset, projectLoudness: number | undefined): number {
  return preset.loudness ?? projectLoudness ?? DEFAULT_LOUDNESS_LUFS;
}
