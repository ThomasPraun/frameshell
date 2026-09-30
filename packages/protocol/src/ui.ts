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

/** The user's selection in the app: one store, every kind at once. */
export const UiSelectionSchema = z.object({
  clips: z.array(z.string()).describe("Selected clip ids of `timeline`, in selection order; empty when none."),
  words: z.array(WordRefSchema).describe("Selected transcript words, in selection order; empty when none."),
  range: TimeRangeSchema.nullable().describe("Selected time range of `timeline`; null when none."),
  history: z
    .string()
    .nullable()
    .describe("Transaction `tx_…` or operation `op_…` whose changes the timeline marks (History panel); null when none."),
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
