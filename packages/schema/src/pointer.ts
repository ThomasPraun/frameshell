import { z } from "zod";
import { type ParseResult, formatIssues } from "./common.js";

/**
 * A pointer track (ADR 0049): where the mouse pointer was over a screen recording, sampled while it recorded. Shoot
 * writes one next to each screen file it records; `clip.zoom` reads it to push in where the pointer rests.
 */
export const PointerTrackSchema = z.strictObject({
  version: z.literal(1),
  width: z.number().positive().describe("Width of the captured screen, in the points the samples were read in (informational)."),
  height: z.number().positive().describe("Height of the captured screen, in the same points."),
  samples: z
    .array(
      z
        .tuple([z.number().nonnegative(), z.number(), z.number()])
        .describe("`[t, x, y]`: second on the recording's own clock, then the position as fractions of the picture (0 left or top, 1 right or bottom; outside 0 to 1: off the captured screen)."),
    )
    .describe("Samples in time order, about 20 per second."),
});

/** See {@link PointerTrackSchema}. */
export type PointerTrack = z.output<typeof PointerTrackSchema>;

/** One sample of a {@link PointerTrack}: `[t, x, y]`. */
export type PointerSample = PointerTrack["samples"][number];

/** Samples per second Shoot records the pointer at. */
export const POINTER_SAMPLE_HZ = 20;

/**
 * Project-relative pointer track of media file `asset`: `.<name without extension>.pointer.json` in the same folder
 * (`assets/shoot/<id>/screen.webm` → `assets/shoot/<id>/.screen.pointer.json`). The leading dot keeps the asset
 * watcher from ingesting it.
 */
export function pointerFileOf(asset: string): string {
  const slash = asset.lastIndexOf("/");
  const folder = slash < 0 ? "" : asset.slice(0, slash + 1);
  const name = asset.slice(slash + 1);
  const dot = name.lastIndexOf(".");
  return `${folder}.${dot > 0 ? name.slice(0, dot) : name}.pointer.json`;
}

/** Parse a pointer track; samples out of time order are an error. */
export function parsePointerTrack(input: unknown): ParseResult<PointerTrack> {
  const result = PointerTrackSchema.safeParse(input);
  if (!result.success) return { ok: false, error: formatIssues(result.error) };
  const samples = result.data.samples;
  for (let i = 1; i < samples.length; i++) {
    if (samples[i]![0] < samples[i - 1]![0]) return { ok: false, error: `samples.${i}: time goes back (${samples[i]![0]} after ${samples[i - 1]![0]})` };
  }
  return { ok: true, value: result.data };
}
