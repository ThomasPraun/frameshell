import { z } from "zod";
import { OpIdSchema, TxIdSchema } from "./timeline.js";

// UI state and navigation (SPEC §7b): the app publishes what the user sees, the daemon brokers commands to it.

/** Timeline seconds span, `from` before `to`. */
export const TimeRangeSchema = z
  .object({
    from: z.number().nonnegative().describe("Timeline seconds where the range starts."),
    to: z.number().nonnegative().describe("Timeline seconds where it ends; greater than `from`."),
  })
  .refine((range) => range.to > range.from, { message: "`to` must be greater than `from`", path: ["to"] });

/** One transcript word, as the transcript file names it. */
export const WordRefSchema = z.object({
  transcript: z.string().min(1).describe("Transcript file, project-relative, e.g. `transcripts/raw-01.words.json`."),
  word: z.string().min(1).describe("Word id in that file, e.g. `w_000123`."),
});

/** One element of a composition as the probe describes it (`ProbedElement`, ADR 0011). */
export const ProbedElementSchema = z.object({
  selector: z.string().describe("CSS selector from the nearest ancestor with an id (or from `body`), e.g. `#scene-2 > div.card:nth-child(2) > h1`."),
  tag: z.string().describe("Tag name, lower case."),
  id: z.string().nullable(),
  classes: z.array(z.string()),
  text: z.string().describe("Rendered text, whitespace collapsed, at most 200 characters; empty when none."),
  box: z
    .object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() })
    .describe("Box in the composition's page, project pixels (the page is laid out at the project resolution)."),
  styles: z.record(z.string(), z.string()).describe("Computed background, colour, font, opacity, border and radius."),
  html: z.string().describe("`outerHTML`, cut at 2048 characters."),
  data: z.record(z.string(), z.string()).describe("`data-*` attributes without the prefix."),
  adapter: z
    .record(z.string(), z.unknown())
    .nullable()
    .describe("What the clip's adapter adds: `source` (file the element comes from), `components` (React components, outermost first)."),
  generated: z.boolean().optional().describe("True when the element's id, classes and text are nowhere in its `source` file: a script created it."),
});

/** One layer under a point of the frame. */
export const PointLayerSchema = z.object({
  clip: z.string().describe("Clip id; inside a nested timeline `<nested clip>/<clip>`, e.g. `c_0200/c_0100`."),
  type: z.string().describe("`media` for footage and stills, else the adapter clip type, e.g. `hyperframes`."),
  paints: z.boolean().describe("Its picture shows at the point (not transparent there)."),
});

/** One mask of a segmented point (ADR 0022). */
export const SegmentMaskSchema = z.object({
  mask: z.string().describe("Project-relative PNG under `.frameshell/context/`: 8-bit grayscale at the asset's size, 255 inside the part, 0 outside."),
  bbox: z.tuple([z.int(), z.int(), z.int(), z.int()]).describe("`[x, y, w, h]` of the mask in the asset's pixels."),
  frameBox: z.tuple([z.number(), z.number(), z.number(), z.number()]).describe("`[x0, y0, x1, y1]` of the mask as fractions of the project frame (the asset's placement applied)."),
  area: z.number().min(0).max(1).describe("Share of the asset's pixels inside the mask."),
  score: z.number().describe("The model's own estimate of the mask's quality, 0 to 1."),
});

/** What segmenting a point of a photo found (ADR 0022). */
export const SegmentedPointSchema = z.object({
  asset: z.string().describe("Project-relative asset of the clip that was segmented."),
  size: z.object({ width: z.int(), height: z.int() }).describe("The asset's pixels, rotation applied: the unit of `mask` and `bbox`."),
  model: z.string().describe("Pinned model, `mobilesam@<revision>`."),
  chosen: z.int().describe("Index in `masks` of the one with the best score."),
  masks: z.array(SegmentMaskSchema).describe("Three answers to the point, smallest first: part of a part, a part, the whole."),
});

/** What a point of the frame shows (ADR 0011): the layers under it and the composition element there. */
export const InspectedPointSchema = z.object({
  x: z.number().min(0).max(1).describe("Fraction of the frame width, 0 = left."),
  y: z.number().min(0).max(1).describe("Fraction of the frame height, 0 = top."),
  at: z.number().nonnegative().describe("Timeline seconds of the frame."),
  layers: z.array(PointLayerSchema).describe("Every clip whose picture's box holds the point, topmost first."),
  target: z.string().nullable().describe("The clip seen there: the first layer that paints the point; null over black."),
  elements: z
    .array(ProbedElementSchema)
    .describe("In a generated target, the element painting the point, then its ancestors to the composition root; empty otherwise."),
  unavailable: z
    .string()
    .nullable()
    .describe("Why the target's elements are unknown (untrusted project, no adapter, no live page); null otherwise."),
  segment: SegmentedPointSchema.optional().describe("Masks of the part of the photo under the point; only when segmenting was asked and possible."),
  segmentUnavailable: z.string().optional().describe("Why nothing was segmented although it was asked: `not an image project`, `not a still image` or `black`."),
});

/** The user's selection in the app: one store, every kind at once. */
export const UiSelectionSchema = z.object({
  clips: z.array(z.string()).describe("Selected clip ids of `timeline`, in selection order; empty when none."),
  words: z.array(WordRefSchema).describe("Selected transcript words, in selection order; empty when none."),
  range: TimeRangeSchema.nullable().describe("Selected time range of `timeline`; null when none."),
  history: z
    .string()
    .nullable()
    .describe("Transaction `tx_…` or operation `op_…` whose changes the timeline marks (History panel); null when none."),
  person: z
    .object({
      id: z.string().describe("Person id, e.g. `p_3fa2c1` (`people.list`)."),
      name: z.string(),
      what: z.enum(["speaks", "onscreen"]).describe("Which time of theirs is selected: when they speak or when they are on screen."),
      spans: z.array(TimeRangeSchema).describe("Timeline seconds of that time (`people.ranges` of `timeline`), sorted, disjoint."),
    })
    .optional()
    .describe("Person the user picked in the People panel, with their selected spans (the words they speak are in `words`); absent when none."),
  region: z
    .object({
      x0: z.number().min(0).max(1).describe("Left edge, fraction of the frame width (0 = left)."),
      y0: z.number().min(0).max(1).describe("Top edge, fraction of the frame height (0 = top)."),
      x1: z.number().min(0).max(1).describe("Right edge, fraction of the frame width; at least `x0`."),
      y1: z.number().min(0).max(1).describe("Bottom edge, fraction of the frame height; at least `y0`."),
      at: z.number().nonnegative().describe("Timeline seconds of the frame it was drawn on."),
      clips: z
        .array(
          z.object({
            clip: z.string().describe("Clip id of `timeline`; inside a nested timeline `<nested clip>/<clip>`, e.g. `c_0200/c_0100`."),
            type: z.string().describe("`media` for footage and stills, else the adapter clip type, e.g. `hyperframes`."),
          }),
        )
        .describe("Clips whose picture meets the rectangle at `at`, topmost first; empty over black."),
    })
    .nullable()
    .describe("Rectangle the user drew on the preview frame (multiply by the project resolution for pixels); null when none."),
  points: z
    .array(
      z.object({
        x: z.number().describe("Fraction of the frame width."),
        y: z.number().describe("Fraction of the frame height."),
        at: z.number().describe("Timeline seconds of the frame it was picked on."),
        target: z.string().nullable().describe("Clip seen there; null over black."),
        element: z
          .object({ selector: z.string(), text: z.string() })
          .nullable()
          .describe("Element picked in the target's composition; `inspect.point` gives every fact about it."),
      }),
    )
    .describe("Points the user picked on the preview with the Pick tool, in pick order; empty when none."),
});

/** What the app publishes about one window: everything `ui.state` reports except connection facts. */
export const UiViewSchema = z.object({
  timeline: z.string().describe("Timeline the timeline panel shows and clip ids refer to, e.g. `main`."),
  playhead: z.number().describe("Playhead, timeline seconds."),
  playing: z.boolean().describe("True while the preview plays."),
  duration: z.number().describe("Timeline length, seconds."),
  selection: UiSelectionSchema,
  editor: z
    .object({
      active: z
        .string()
        .nullable()
        .describe("Project-relative file of the active editor tab, `frameshell:transcript` for the transcript view; null when no tab is open."),
      tabs: z.array(z.string()).describe("Open editor tabs, project-relative, left to right."),
    })
    .describe("Editor tabs."),
  visible: TimeRangeSchema.nullable().describe(
    "Timeline seconds visible in the timeline panel, left edge to right edge; null while the panel is hidden.",
  ),
});

/** App state as `ui.state` and navigation tools return it. */
export const UiStateSchema = UiViewSchema.extend({
  project: z.string().describe("Absolute project root the app shows."),
  updatedAt: z.string().describe("ISO 8601 time of the app's last report; the app reports every change within 200 ms."),
});

/** One navigation command routed daemon → app. `kind` names what the app does. */
export const UiCommandSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("seek"), at: z.number().nonnegative() }),
  z.object({ kind: z.literal("play") }),
  z.object({ kind: z.literal("pause") }),
  z.object({
    kind: z.literal("select"),
    clips: z.array(z.string()),
    words: z.array(WordRefSchema),
    range: TimeRangeSchema.nullable(),
    reveal: z.boolean(),
    /** Points the daemon already inspected (`inspect.point`): the app shows them as picks. */
    points: z.array(InspectedPointSchema).default([]),
    /** A person the daemon found in `people.json` (`id` resolved from a name): the app picks them as the People panel does. */
    person: z.object({ id: z.string(), what: z.enum(["speaks", "onscreen"]) }).nullable().default(null),
  }),
  z.object({ kind: z.literal("openFile"), path: z.string().min(1).describe("Project-relative, `/`-separated.") }),
  z.object({ kind: z.literal("showTxDiff"), timeline: z.string(), target: z.union([TxIdSchema, OpIdSchema]) }),
]);

/** Client-chosen id of one app window on a connection; one connection may serve several windows. */
export const UiViewIdSchema = z.string().min(1).max(100).describe("Window id, unique on this connection.");

/** What a window shows and has selected, as the app publishes it. */
export type UiView = z.output<typeof UiViewSchema>;
/** App state of a connected window, as navigation tools return it. */
export type UiState = z.output<typeof UiStateSchema>;
/** The selection part of {@link UiView}. */
export type UiSelection = z.output<typeof UiSelectionSchema>;
/** One navigation command for the app. */
export type UiCommand = z.output<typeof UiCommandSchema>;
/** A timeline seconds span. */
export type TimeRange = z.output<typeof TimeRangeSchema>;
/** One transcript word reference. */
export type WordRef = z.output<typeof WordRefSchema>;
/** One element as `inspect.point` and picks report it. */
export type ProbedElementInfo = z.output<typeof ProbedElementSchema>;
/** What a point of the frame shows. */
export type InspectedPoint = z.output<typeof InspectedPointSchema>;
/** What segmenting a point of a photo found (ADR 0022). */
export type SegmentedPoint = z.output<typeof SegmentedPointSchema>;
