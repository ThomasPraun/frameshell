import { BrandCaptureSchema } from "@frameshell/schema";
import { z } from "zod";

/** One `style set` a brand capture suggests; never applied by the capture (ADR 0044 decision 7). */
export const StyleSuggestionSchema = z.object({
  path: z.string().describe("Style path, as `style.set` takes it, e.g. `colors.accent`."),
  value: z.unknown().describe("Value for `style.set`."),
  why: z.string().describe("What on the page it comes from."),
});

/** Result of `brand.capture`. */
export const BrandCaptureResultSchema = z.object({
  dir: z.string().describe("Project root."),
  manifest: z.string().describe("Project-relative manifest the capture was added to: `brand.json`."),
  capture: BrandCaptureSchema.describe("What was found and written, as recorded in `brand.json`."),
  style: z
    .array(StyleSuggestionSchema)
    .describe("Suggested `style set` calls (colours, fonts, brand.product, brand.url, brand.mustShow). Show the findings to the person and apply only what they agree to."),
  bytes: z.int().describe("Bytes transferred through the capture proxy."),
});
