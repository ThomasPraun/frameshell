import { z } from "zod";

// `clip.verify` (ADR 0033): a generated clip's picture must be a pure function of time.

/** Most one channel of one pixel may differ between a cold frame and the same frame after a reseek (ADR 0033 decision 6). */
export const VERIFY_DEFAULT_TOLERANCE = 2;
/** Probe frames a verify captures when `probes` is not given: at `(i + 0.37) * duration / 12`. */
export const VERIFY_DEFAULT_PROBES = 12;
/** Most probes one verify may ask for; each is a page load. */
export const VERIFY_MAX_PROBES = 48;

/** The page element at the worst pixel of a verify. */
export const VerifyElementSchema = z.object({
  selector: z.string().describe("CSS selector from the nearest ancestor with an `id`, as `inspect.point` reports elements."),
  tag: z.string().describe("Tag name, lower case."),
  id: z.string().nullable(),
  classes: z.array(z.string()),
  text: z.string().describe("Rendered text, cut at 80 characters; empty when none."),
  box: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }).describe("Page pixels."),
});

/** One probe frame of a verify. */
export const VerifyProbeSchema = z.object({
  at: z.number().describe("Composition seconds of the probe (file time of the clip's render), 3 decimals."),
  reseekFrom: z.number().describe("Composition seconds of the unrelated probe the page showed just before this one in the reseek pass, 3 decimals."),
  max: z.int().min(0).max(255).describe("Largest difference of one channel (red, green, blue or alpha) of one pixel, cold against after the reseek."),
  pixels: z.int().min(0).describe("Pixels with a channel that differs by more than the tolerance."),
  ok: z.boolean().describe("True when `max` is within the tolerance."),
});

/** Result of `clip.verify`. */
export const ClipVerifyResultSchema = z.object({
  timeline: z.string().describe("Timeline id."),
  clip: z.string().describe("The verified clip, as asked."),
  type: z.string().describe("Its adapter type, e.g. `hyperframes`."),
  ok: z.boolean().describe("True when every probe is within the tolerance."),
  tolerance: z.int().min(0).max(255).describe("The largest per-channel difference that counts as the same picture."),
  size: z.object({ width: z.int(), height: z.int() }).describe("Frame size captured: the page at the project resolution."),
  probes: z.array(VerifyProbeSchema).describe("In time order."),
  distinct: z.int().min(1).describe("Different pictures among the cold probe frames. 1 with several probes means a clip that never moves."),
  worst: z
    .object({
      at: z.number().describe("Composition seconds of the probe with the largest difference."),
      max: z.int().min(1).max(255),
      pixel: z.object({ x: z.int(), y: z.int() }).describe("Page pixel of that difference, from the top left."),
      element: VerifyElementSchema.nullable().describe("What paints that pixel after the reseek; null when nothing does (transparent)."),
    })
    .nullable()
    .describe("The frame and element that differ most; null when every probe was identical."),
  warnings: z.array(z.string()),
});

// `clip.textFit` (#803): does every line of text of a generated clip stay inside its box and the frame, with its
// props as they are or with others (another language) tried for the check only.

/** Settled points of the clip's played part a text fit checks when no `at` is given, as fractions of its length. */
export const TEXT_FIT_DEFAULT_FRACTIONS = [0.5, 0.7, 0.9] as const;
/** Most times one text fit may check; each is a seek of one page. */
export const TEXT_FIT_MAX_TIMES = 12;
/** Page pixels text may pass its box or the frame by before it counts (anti-aliasing, sub-pixel layout). */
export const TEXT_FIT_SLACK_PX = 1;

/** One line of text that does not fit. */
export const TextFitProblemSchema = z.object({
  kind: z
    .enum(["outside", "overflows"])
    .describe("`outside`: the text passes the edge of the frame. `overflows`: it passes the box of its own element (a button, a card, a fixed-width line)."),
  at: z.number().describe("Composition seconds where it was worst, 3 decimals."),
  by: z.number().describe("Page pixels it passes the edge by, the most over the times checked, 1 decimal."),
  side: z.enum(["left", "right", "top", "bottom"]).describe("The edge it passes most."),
  selector: z.string().describe("CSS selector of the element, as `inspect.point` reports elements."),
  text: z.string().describe("Its text, cut at 80 characters."),
  box: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }).describe("The text's own box at `at`, page pixels."),
});

/** Result of `clip.textFit`. */
export const ClipTextFitResultSchema = z.object({
  timeline: z.string().describe("Timeline id."),
  clip: z.string().describe("The checked clip, as asked."),
  type: z.string().describe("Its adapter type, e.g. `hyperframes`."),
  ok: z.boolean().describe("True when every line of text fits at every time checked."),
  size: z.object({ width: z.int(), height: z.int() }).describe("Frame size checked: the page at the project resolution."),
  tried: z.array(z.string()).describe("Props given in `props` for this check (nothing written); empty when the clip's own were used."),
  at: z.array(z.number()).describe("Composition seconds checked, in order."),
  lines: z.int().min(0).describe("Elements with text of their own seen at the times checked."),
  problems: z.array(TextFitProblemSchema).describe("One per element and kind, worst first."),
  warnings: z.array(z.string()),
});
