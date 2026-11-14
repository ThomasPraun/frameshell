import { z } from "zod";

/**
 * Ranges and defaults of a generated clip's motion blur (ADR 0041). `samples` 8 is the owner's fixed count: the
 * producer's adaptive mode costs 21x to 27x a sharp render and skips no still frame (docs/research/motion-blur.md).
 * `shutter` stops at 360 so a centred window never leaves its frame's half-frame either side (the `cuts()` guard).
 */
export const MOTION_BLUR_LIMITS = {
  shutter: { min: 1, max: 360, default: 180 },
  samples: { min: 1, max: 64, default: 8 },
} as const;

/** Space the sub-frame samples are averaged in. */
export const MOTION_BLUR_BLENDS = ["linear", "srgb"] as const;

/** {@link MotionBlur.blend} when the clip gives none. */
export const DEFAULT_MOTION_BLUR_BLEND: (typeof MOTION_BLUR_BLENDS)[number] = "linear";

/** Clip field `motionBlur` of a generated clip (ADR 0041). */
export const MotionBlurSchema = z
  .strictObject({
    shutter: z
      .number()
      .min(MOTION_BLUR_LIMITS.shutter.min)
      .max(MOTION_BLUR_LIMITS.shutter.max)
      .optional()
      .describe(`Shutter angle in degrees of one frame, centred on the frame time. Default ${MOTION_BLUR_LIMITS.shutter.default}.`),
    samples: z
      .number()
      .int()
      .min(MOTION_BLUR_LIMITS.samples.min)
      .max(MOTION_BLUR_LIMITS.samples.max)
      .optional()
      .describe(`Sub-frame pictures averaged into each frame; the render costs about this many sharp renders. Default ${MOTION_BLUR_LIMITS.samples.default}.`),
    blend: z
      .enum(MOTION_BLUR_BLENDS)
      .optional()
      .describe(`Average in \`linear\` light (physical) or \`srgb\` (the After Effects look). Default ${DEFAULT_MOTION_BLUR_BLEND}.`),
  })
  .describe(
    "Motion blur of a generated clip (ADR 0041): each frame is the average of sub-frame pictures across the shutter window, so " +
      "fast moves smear like a camera's. `{}` blurs with the defaults. Its render costs about `samples` times a sharp one.",
  );

/** Motion blur of a generated clip, as stored; see {@link MotionBlurSchema}. */
export type MotionBlur = z.infer<typeof MotionBlurSchema>;

/** {@link MotionBlur} with every default filled in: what a render gets and its cache key counts. */
export interface ResolvedMotionBlur {
  /** Degrees of one frame, centred on the frame time. */
  shutter: number;
  /** Sub-frame samples per frame. */
  samples: number;
  blend: (typeof MOTION_BLUR_BLENDS)[number];
}

/** The motion blur of a generated clip with defaults filled in; null when it has none. */
export function motionBlurOf(clip: { motionBlur?: MotionBlur | undefined }): ResolvedMotionBlur | null {
  const blur = clip.motionBlur;
  if (!blur) return null;
  return {
    shutter: blur.shutter ?? MOTION_BLUR_LIMITS.shutter.default,
    samples: blur.samples ?? MOTION_BLUR_LIMITS.samples.default,
    blend: blur.blend ?? DEFAULT_MOTION_BLUR_BLEND,
  };
}
