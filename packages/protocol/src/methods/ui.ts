import { z } from "zod";
import { OpIdSchema, TimelineIdSchema, TxIdSchema } from "../timeline.js";
import { TimeRangeSchema, UiStateSchema, UiViewIdSchema, UiViewSchema, WordRefSchema } from "../ui.js";
import { type MethodSpec, CwdParam } from "./shared.js";

/** Daemon methods: app window state and navigation. */
export const uiMethods = {
  "ui.state": {
    description:
      "What the user sees in the Frameshell app for this project: the playhead and whether it plays, the selection " +
      "(clip ids, transcript words, a time range, the History entry whose changes the timeline marks, and the person picked " +
      "in the People panel with their spans), the " +
      "editor tabs and the timeline seconds visible in the timeline panel. Read it to resolve \"this clip\", \"here\" " +
      "or \"the selected words\" before acting. The app reports every change within 200 ms. `connected: false` (and " +
      "no other field) when no app window shows the project; the other `ui.*` tools then fail with UiNotConnected.",
    params: z.strictObject({ cwd: CwdParam }),
    result: z.object({
      connected: z.boolean().describe("True when an app window shows the project; every other field is absent otherwise."),
      ...UiStateSchema.partial().shape,
    }),
  },
  "ui.seek": {
    description:
      "Move the app's playhead to timeline second `at` so the preview shows that frame (snapped to the frame, clamped " +
      "to the timeline; playback continues from there if it was playing). Example: `{ at: 12.5 }`. Returns `ui.state` " +
      "after the move. Fails with UiNotConnected when no app window shows the project.",
    params: z.strictObject({
      cwd: CwdParam,
      at: z.number().nonnegative().describe("Timeline seconds, e.g. `12.5`."),
    }),
    result: UiStateSchema,
  },
  "ui.play": {
    description:
      "Start playback in the app's preview from the playhead (from the start when it is at the end). Returns " +
      "`ui.state`. Fails with UiNotConnected when no app window shows the project.",
    params: z.strictObject({ cwd: CwdParam }),
    result: UiStateSchema,
  },
  "ui.pause": {
    description:
      "Pause playback in the app's preview; the playhead stays where it stopped. Returns `ui.state`. Fails with " +
      "UiNotConnected when no app window shows the project.",
    params: z.strictObject({ cwd: CwdParam }),
    result: UiStateSchema,
  },
  "ui.select": {
    description:
      "Replace the user's selection in the app, to point at what you mean: clips (ids of the timeline `ui.state` " +
      "names, from `timeline.show`), transcript words, and/or a time range; or a person with their spans and words. " +
      "Omitted parts are cleared; nothing given clears the selection. With `reveal` (default true) the timeline scrolls " +
      "to the first clip (or span) and, unless playing, the playhead moves to its start. Examples: `{ clips: [\"c_1a2b3c\"] }`, `{ range: { from: 12.4, to: 13.1 } }`, " +
      "`{ person: { id: \"Juan\" } }`. Returns `ui.state`. Fails with UiCommandFailed naming clip ids the timeline does " +
      "not have, InvalidOperation for an unknown person, UiNotConnected.",
    params: z.strictObject({
      cwd: CwdParam,
      clips: z.array(z.string().min(1)).default([]).describe("Clip ids to select, e.g. `[\"c_1a2b3c\"]`. Default none."),
      words: z
        .array(WordRefSchema)
        .default([])
        .describe("Transcript words to select, e.g. `[{ transcript: \"transcripts/raw-01.words.json\", word: \"w_000123\" }]`. Default none."),
      range: TimeRangeSchema.nullable()
        .default(null)
        .describe("Timeline seconds to select, `{ from, to }` with `to` greater than `from`. Default none."),
      reveal: z.boolean().default(true).describe("Scroll the timeline to the first clip and move the playhead there. Default true."),
      points: z
        .array(
          z.object({
            at: z.number().nonnegative().describe("Timeline seconds."),
            x: z.number().min(0).max(1).describe("Fraction of the frame width."),
            y: z.number().min(0).max(1).describe("Fraction of the frame height."),
          }),
        )
        .default([])
        .describe(
          "Points of the preview to show as picks (ADR 0011), e.g. `[{ at: 12.4, x: 0.71, y: 0.14 }]`, each inspected as " +
            "`inspect.point` does, so the user sees the element you mean outlined. Replaces clips, words and range. Default none.",
        ),
      person: z
        .object({
          id: z.string().min(1).describe("Person id `p_…` or the exact name, as `people.list` reports them."),
          what: z.enum(["speaks", "onscreen"]).default("speaks").describe("Their time to select: when they speak (default) or when they are on screen."),
        })
        .nullable()
        .default(null)
        .describe(
          "A person to select as the People panel does (ADR 0020): their spans of the main timeline (`people.ranges`) and, " +
            "with `speaks`, the words of their linked voices; `ui.state` then reports `person`. Replaces clips, words and range. Default none.",
        ),
    }),
    result: UiStateSchema,
  },
  "ui.openFile": {
    description:
      "Open a project file in an app editor tab and make it the active tab, e.g. the script `scripts/launch.md` or " +
      "`timelines/main.json`. Returns `ui.state`. Fails with OutsideProject for a path outside the project, " +
      "UiCommandFailed when the app cannot read the file, UiNotConnected.",
    params: z.strictObject({
      cwd: CwdParam,
      file: z
        .string()
        .min(1)
        .describe("File relative to the project root, or absolute inside the project, e.g. `scripts/launch.md`."),
    }),
    result: UiStateSchema,
  },
  "ui.showTxDiff": {
    description:
      "Show the user what a transaction (`tx_…`) or operation (`op_…`) from `history` changed: the app opens its " +
      "History panel on that entry, selects the clips it left and marks every added, removed, moved and changed clip " +
      "on the timeline. Use it to walk the user through your changes. The app shows the `main` timeline only. " +
      "Returns `ui.state` (`selection.history` is the target). Fails with UiCommandFailed when the id is not in the " +
      "timeline's journal, UiNotConnected.",
    params: z.strictObject({
      cwd: CwdParam,
      timeline: TimelineIdSchema,
      target: z.union([TxIdSchema, OpIdSchema]).describe("Transaction id `tx_…` or operation id `op_…` to show."),
    }),
    result: UiStateSchema,
  },
  "ui.publish": {
    description:
      "App window reports what it shows for the project enclosing `cwd`: registers the window (`view`) as that " +
      "project's UI, so `ui.state` answers from it and navigation commands reach it as `ui.command`. Send on every change.",
    internal: true,
    params: z.strictObject({
      cwd: CwdParam,
      view: UiViewIdSchema,
      state: UiViewSchema,
      focused: z
        .boolean()
        .optional()
        .describe(
          "The window is the one the user focused last among the app's project windows (still true after the app loses " +
            "focus). False: it reports in the background, e.g. while playing, and does not become `ui.active`. Default true.",
        ),
    }),
    result: z.object({ dir: z.string().describe("Project root the window is registered for.") }),
  },
  "ui.active": {
    description:
      "Project of the app window the user works in: the one focused last (else the one that reported last), the same " +
      "window `ui.*` commands for that project reach. `dir` is null when no app window shows a project. The MCP server " +
      "resolves a call without `cwd` to it when the server's own directory is in no project (ADR 0014).",
    internal: true,
    params: z.strictObject({}),
    result: z.object({
      dir: z.string().nullable().describe("Absolute project root the window shows; null when no window shows one."),
    }),
  },
  "ui.reply": {
    description:
      "App window answers `ui.command` `id`: `error` null when done, else why not; `state` is its state after the command.",
    internal: true,
    params: z.strictObject({
      view: UiViewIdSchema,
      id: z.string().min(1).describe("`id` of the `ui.command` answered."),
      error: z.string().nullable(),
      state: UiViewSchema,
    }),
    result: z.object({}),
  },
  "ui.detach": {
    description: "App window stops showing its project (closed, or another project opened). Unknown windows are ignored.",
    internal: true,
    params: z.strictObject({ view: UiViewIdSchema }),
    result: z.object({}),
  },
} as const satisfies Record<string, MethodSpec>;
