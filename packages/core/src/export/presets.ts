import type { ExportPreset } from "@frameshell/schema";

/** Integrated loudness target when neither the preset nor `frameshell.json` sets one (SPEC §3.5). */
export const DEFAULT_LOUDNESS_LUFS = -17;

/** Preset used when neither the caller nor `export.defaultPreset` names one. */
export const DEFAULT_PRESET_ID = "youtube-1080p";

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
];

/**
 * Loudness target for a render: the preset's own `loudness`, else the
 * project's `export.loudness`, else {@link DEFAULT_LOUDNESS_LUFS}.
 */
export function loudnessTarget(preset: ExportPreset, projectLoudness: number | undefined): number {
  return preset.loudness ?? projectLoudness ?? DEFAULT_LOUDNESS_LUFS;
}
