// A new project's format from its first video (#197): resolution, frame rate and sample rate it plays at.
import type { MediaProbe } from "@frameshell/protocol";

/** Frame rates footage comes in; a measured rate this close to one is that rate. Phones measure 29.6 for 30. */
const STANDARD_FPS = [23.976, 24, 25, 29.97, 30, 50, 59.94, 60];
const FPS_TOLERANCE = 0.5;

/** Sample rates exports keep; anything else becomes 48 kHz. */
const STANDARD_RATES = [44100, 48000];

/** The project format fields {@link projectFormat} sets. */
export interface ProjectFormat {
  fps?: number;
  resolution?: { width: number; height: number };
  sampleRate?: number;
}

/**
 * Format of a project made from `probe`'s file: its display size rounded
 * down to even numbers (H.264 needs them), its frame rate snapped to the
 * nearest standard one, its sample rate when standard. Fields the file
 * cannot tell (audio-only, still image) are left out, so defaults apply.
 */
export function projectFormat(probe: MediaProbe): ProjectFormat {
  const format: ProjectFormat = {};
  const video = probe.video;
  if (video && !video.still && video.width >= 2 && video.height >= 2) {
    format.resolution = { width: video.width - (video.width % 2), height: video.height - (video.height % 2) };
    if (video.fps !== null && video.fps > 0) {
      const nearest = STANDARD_FPS.reduce((best, fps) => (Math.abs(fps - video.fps!) < Math.abs(best - video.fps!) ? fps : best));
      format.fps = Math.abs(nearest - video.fps) <= FPS_TOLERANCE ? nearest : Math.max(1, Math.round(video.fps));
    }
  }
  if (probe.audio) format.sampleRate = STANDARD_RATES.includes(probe.audio.sampleRate) ? probe.audio.sampleRate : 48000;
  return format;
}
