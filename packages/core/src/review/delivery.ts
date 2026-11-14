import type { MediaProbe, ReviewFinding, ReviewDelivery, ReviewLoudness } from "@frameshell/protocol";
import type { ExportPreset } from "@frameshell/schema";
import { DELIVERY_FPS, DELIVERY_FRAMES, DELIVERY_LOUDNESS_LU } from "./thresholds.js";

// Delivery check (#457, from the 2.5D shorts course): the exported file read back with ffprobe against what the export plan
// said it would be. Pure: the plan, the preset and the probe in, the comparisons out.

/** What the export plan promises of the file; from `RenderResult`. */
export interface Planned {
  width: number;
  height: number;
  /** Output frame rate as an ffmpeg rational, e.g. `30/1`. */
  fps: string;
  /** Seconds. */
  duration: number;
  /** Integrated loudness target, LUFS. */
  loudness: number;
}

/** ffprobe's codec name for each video codec of a preset. */
const VIDEO_CODEC: Record<ExportPreset["video"]["codec"], string> = { h264: "h264", h265: "hevc", vp9: "vp9", prores: "prores", gif: "gif" };

/** The value of an ffmpeg rational such as `30000/1001`; NaN for anything else. */
export function rational(value: string): number {
  const [num, den] = value.split("/").map(Number);
  return num !== undefined && den !== undefined && den !== 0 ? num / den : Number.NaN;
}

const round = (value: number) => Math.round(value * 1000) / 1000;

/**
 * Compare a file with its plan. Size, frame rate, length (within {@link DELIVERY_FRAMES} output frames: the container
 * runs a little past its picture), video codec, whether it has the preset's audio and, for a file with sound, its
 * integrated loudness against the target (within {@link DELIVERY_LOUDNESS_LU}; silence, which reads null, is not compared).
 */
export function deliveryChecks(plan: Planned, preset: Pick<ExportPreset, "video" | "audio">, probe: MediaProbe, loudness: ReviewLoudness | null): ReviewDelivery["checks"] {
  const video = probe.video;
  const fps = rational(plan.fps);
  const checks: ReviewDelivery["checks"] = [
    { field: "width", expected: plan.width, actual: video?.width ?? null, ok: video?.width === plan.width },
    { field: "height", expected: plan.height, actual: video?.height ?? null, ok: video?.height === plan.height },
    { field: "fps", expected: round(fps), actual: video?.fps == null ? null : round(video.fps), ok: video?.fps != null && Math.abs(video.fps - fps) <= DELIVERY_FPS },
    {
      field: "duration",
      expected: round(plan.duration),
      actual: probe.duration == null ? null : round(probe.duration),
      ok: probe.duration != null && Math.abs(probe.duration - plan.duration) <= DELIVERY_FRAMES / fps + 1e-6,
    },
    { field: "codec", expected: VIDEO_CODEC[preset.video.codec], actual: video?.codec ?? null, ok: video?.codec === VIDEO_CODEC[preset.video.codec] },
  ];
  const audio = preset.audio?.codec ?? null;
  checks.push({
    field: "audio",
    expected: audio ?? "none",
    actual: probe.audio?.codec ?? "none",
    ok: audio === null ? probe.audio === null : probe.audio?.codec.startsWith(audio) === true,
  });
  if (probe.audio && loudness?.integrated != null) {
    checks.push({ field: "loudness", expected: plan.loudness, actual: loudness.integrated, ok: Math.abs(loudness.integrated - plan.loudness) <= DELIVERY_LOUDNESS_LU });
  }
  return checks;
}

/** One craft warning for a delivery that differs from its plan; none when every check holds. */
export function deliveryWarnings(delivery: ReviewDelivery): ReviewFinding[] {
  const wrong = delivery.checks.filter((check) => !check.ok);
  if (wrong.length === 0) return [];
  const list = wrong.map((check) => `${check.field} is ${check.actual ?? "missing"}, the plan says ${check.expected}`);
  return [
    {
      check: "delivery",
      from: null,
      to: null,
      message: `the file differs from the export plan of ${delivery.timeline} with preset ${delivery.preset} (format ${delivery.format}): ${list.join("; ")}. Render it again, or review it against the preset it was made with (a draft-quality render caps the frame rate by design).`,
    },
  ];
}
