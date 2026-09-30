import { z } from "zod";
import {
  ClipSchema,
  MAX_SNAP_WINDOW_S,
  MIN_SNAP_WINDOW_S,
  SUBTITLE_POSITIONS,
  SUBTITLE_PRESET_IDS,
  type SubtitlePosition,
  type SubtitlePresetId,
  TrackSchema,
  TransformSchema,
} from "@frameshell/schema";
import { AGENT_LABEL_PATTERN } from "./agents.js";

/**
 * Timeline operations (SPEC §6.1): the args of every mutating timeline verb,
 * the patch that expresses any inverse, and the operation record the daemon
 * returns (and #10's history journals). Method params in `methods.ts` wrap
 * these args with `cwd` and `timeline`.
 */

const Seconds = (what: string) => z.number().nonnegative().describe(`${what} Seconds; snapped to the project frame grid, 3 decimals.`);
const ClipRef = z.string().min(1).describe("Clip id from `timeline.show`, e.g. `c_1a2b3c`.");
const TrackRef = z.string().min(1).describe("Track id from `track.list`, e.g. `t_4d5e6f`.");

/** Snapping args shared by `cut` and `clip.trim` (ADR 0003). */
const snapArgs = {
  snap: z
    .boolean()
    .optional()
    .describe(
      "Move each edge into the nearest audio pause (>= 200 ms quiet) so no word is clipped; media clips with audio only. " +
        "Default true. Pass false to cut exactly at the given times.",
    ),
  snapWindow: z
    .number()
    .min(MIN_SNAP_WINDOW_S)
    .max(MAX_SNAP_WINDOW_S)
    .optional()
    .describe(
      "Search half-width for a pause, seconds, 0.5 to 10. Default: the project's `editing.snapWindow` in frameshell.json, else 0.5 (±500 ms).",
    ),
};

/** `ripple` arg of `clip.trim` and `clip.add`: the inverse of `cut`, for restoring removed material. */
const rippleArg = (what: string) =>
  z
    .boolean()
    .optional()
    .describe(
      `${what} Applies to every video and audio track, like \`cut\`, so tracks stay in sync; clips crossing the ` +
        "insertion point stay where they are. Default false: nothing else moves, and a clip that would overlap its " +
        "neighbour is refused.",
    );

/** Source-seconds range a snapped edge must stay in. */
const SnapRangeSchema = z
  .strictObject({
    min: z.number().nonnegative().optional().describe("Earliest allowed source second."),
    max: z.number().nonnegative().optional().describe("Latest allowed source second."),
  });

/** `snapBounds` arg of `clip.trim` and `clip.add`: fences for the pause search of `in` and `out`. */
const snapBoundsArg = z
  .strictObject({
    in: SnapRangeSchema.optional().describe("Range for the snapped `in`; needs `in`."),
    out: SnapRangeSchema.optional().describe("Range for the snapped `out`; needs `out`."),
  })
  .optional()
  .describe(
    "Source seconds each snapped edge must stay in; the requested time must lie inside. The pause search looks only " +
      "there; with no pause in range the edge takes the quietest frame in range (`clean: false`). Use it to keep a word " +
      "whole and off material another clip already plays, e.g. restoring a word at 3.2-3.5 between clips ending at 3.1 " +
      "and starting at 3.55: `{ out: 3.53, snapBounds: { out: { min: 3.5, max: 3.55 } } }`.",
  );

/** Subtitle look (SPEC §5.3 `style`): a built-in preset and where the line sits. */
export const SubtitleStyleArgSchema = z
  .strictObject({
    preset: z
      .enum(SUBTITLE_PRESET_IDS as [SubtitlePresetId, ...SubtitlePresetId[]])
      .optional()
      .describe(
        "`big-keyword` (default): up to three large upper-case words, the word being spoken highlighted, low in the frame. " +
          "`plain`: sentence-length white lines, no highlight.",
      ),
    position: z
      .enum(SUBTITLE_POSITIONS as [SubtitlePosition, ...SubtitlePosition[]])
      .optional()
      .describe("`top`, `center` or `bottom`. Default: the preset's (`bottom`)."),
  })
  .describe("Subtitle tracks only. Preview and export render the same style.");

/** Timeline id param: the file is `timelines/<id>.json`. */
export const TimelineIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, "must be a timeline id like `main` or `intro` (file `timelines/<id>.json`)")
  .default("main")
  .describe("Timeline id; the file is `timelines/<id>.json`. Default `main`.");

/** Args of each timeline operation, keyed by operation name (= daemon method name). */
export const operationArgs = {
  "track.add": z.strictObject({
    kind: z
      .enum(["video", "audio", "subtitles"])
      .describe("`video` (footage, overlays), `audio` (music, voice-over) or `subtitles` (words of a followed track)."),
    name: z.string().min(1).optional().describe("Display name, e.g. `Camera`."),
    follows: z
      .string()
      .min(1)
      .optional()
      .describe("Subtitle tracks only, required for them: id of the video or audio track whose clips' transcript words it shows."),
    index: z
      .int()
      .nonnegative()
      .optional()
      .describe("Stack position, 0 = bottom layer. Default: on top of every existing track."),
    style: SubtitleStyleArgSchema.optional(),
  }),
  "track.set": z.strictObject({
    track: TrackRef,
    name: z.string().min(1).nullable().optional().describe("Display name; null clears it."),
    follows: z
      .string()
      .min(1)
      .optional()
      .describe("Subtitle tracks only: id of the video or audio track whose clips' transcript words it shows."),
    style: SubtitleStyleArgSchema.optional().describe("Subtitle tracks only: the fields given change, the others keep their value."),
  }),
  "track.remove": z.strictObject({
    track: TrackRef,
    force: z.boolean().default(false).describe("Also remove the track's clips. Default false: a track with clips is refused."),
  }),
  "clip.add": z.strictObject({
    track: TrackRef.describe("Video or audio track to place the clip on."),
    type: z
      .string()
      .min(1)
      .default("media")
      .describe("`media` (default: a file under assets/), `timeline` (nested timeline file) or an adapter clip type, e.g. `hyperframes`."),
    asset: z
      .string()
      .min(1)
      .optional()
      .describe("`media` only, required: file inside the project, absolute or relative to `cwd`, e.g. `assets/raw-01.mp4`."),
    source: z
      .string()
      .min(1)
      .optional()
      .describe("`timeline`: timeline file, e.g. `timelines/intro.json` (required). Adapter types: composition entry file."),
    start: Seconds("Timeline time of the first frame. Default: right after the track's last clip.").optional(),
    in: Seconds("Source time of the first frame. Default 0.").optional(),
    out: Seconds("`media`: source time just after the last frame. Default: end of the asset.").optional(),
    duration: z
      .number()
      .positive()
      .optional()
      .describe("Seconds on the timeline. Required for adapter types and still images; for `media` an alternative to `out`."),
    speed: z.number().positive().optional().describe("`media` only: playback rate, e.g. 1.15. Default 1."),
    props: z.record(z.string(), z.unknown()).optional().describe("Adapter types only: properties checked by the adapter's schema."),
    transform: TransformSchema.optional(),
    gain: z.number().optional().describe("Audio gain in dB, e.g. -18. Default 0."),
    muted: z.boolean().optional().describe("Mute the clip's audio. Default false."),
    scriptRef: z.string().min(1).optional().describe("Script scene, e.g. `scripts/script.md#intro`; the path alone refers to the whole script."),
    ripple: rippleArg("Make room: clips starting at or after `start` move right by the new clip's length."),
    snap: z
      .boolean()
      .optional()
      .describe(
        "`media` only: move `in` and `out` into the nearest audio pause (>= 200 ms quiet), as `cut` does, so no word is " +
          "clipped. Default false: in/out are used as given.",
      ),
    snapWindow: snapArgs.snapWindow,
    snapBounds: snapBoundsArg,
  }),
  "clip.move": z.strictObject({
    clip: ClipRef,
    start: Seconds("New timeline time of the first frame. Default: unchanged.").optional(),
    track: TrackRef.optional().describe("Track to move the clip to (same kind). Default: unchanged."),
  }),
  "clip.trim": z.strictObject({
    clip: ClipRef,
    in: Seconds("New source time of the first frame (head trim); frames that stay keep their timeline position.").optional(),
    out: Seconds("New source time just after the last frame (tail trim).").optional(),
    start: Seconds("Head trim by timeline time: the clip's new left edge. Alternative to `in`.").optional(),
    end: Seconds("Tail trim by timeline time: the clip's new right edge. Alternative to `out`.").optional(),
    ...snapArgs,
    snapBounds: snapBoundsArg,
    ripple: rippleArg(
      "Ripple: the clip keeps its left edge and later clips move by the change in length (extending pushes them right, " +
        "shortening pulls them left). Clips starting inside the clip move by the head change only.",
    ),
  }),
  "clip.split": z.strictObject({
    clip: ClipRef,
    at: Seconds("Timeline time to split at; strictly inside the clip. The left part keeps the id."),
  }),
  "clip.remove": z.strictObject({ clip: ClipRef }),
  "clip.set": z.strictObject({
    clip: ClipRef,
    speed: z.number().positive().optional().describe("`media` only: playback rate; the start stays, the end moves."),
    gain: z.number().optional().describe("Audio gain in dB."),
    muted: z.boolean().optional(),
    transform: TransformSchema.optional().describe("Fields to change; omitted fields keep their value."),
    props: z.record(z.string(), z.unknown()).optional().describe("Adapter types only: replaces all props."),
    scriptRef: z.string().min(1).nullable().optional().describe("Script scene (`scripts/script.md#intro`) or whole script (`scripts/script.md`); null clears it."),
  }),
  cut: z.strictObject({
    from: Seconds("Start of the timeline range to remove."),
    to: Seconds("End of the range; greater than `from`."),
    tracks: z
      .array(TrackRef)
      .min(1)
      .optional()
      .describe("Tracks to cut. Default: every video and audio track, which keeps them in sync."),
    ...snapArgs,
  }),
} as const;

/** Name of a public timeline operation. */
export type OperationName = keyof typeof operationArgs;

/**
 * Change that restores or replaces parts of a timeline. Every operation's
 * inverse is a patch, so one `apply` undoes any operation.
 * Applied in order: `tracks` (replace, insert or delete whole tracks), then
 * `clips` (upsert or delete one clip in a track), then `order`.
 */
export const TimelinePatchSchema = z.strictObject({
  tracks: z
    .array(z.strictObject({ id: z.string().min(1), track: TrackSchema.nullable().describe("Full track; null deletes it.") }))
    .optional(),
  clips: z
    .array(
      z.strictObject({
        track: z.string().min(1),
        id: z.string().min(1),
        clip: ClipSchema.nullable().describe("Full clip; null deletes it."),
      }),
    )
    .optional(),
  order: z.array(z.string().min(1)).optional().describe("Track ids in stacking order after the patch."),
});

/** See {@link TimelinePatchSchema}. */
export type TimelinePatch = z.output<typeof TimelinePatchSchema>;

/** Transaction id: `tx_` + 8 hex digits. */
export const TxIdSchema = z
  .string()
  .regex(/^tx_[0-9a-f]{8}$/, "must be a transaction id like `tx_1a2b3c4d`")
  .describe("Transaction id from a mutation result or `history`, e.g. `tx_1a2b3c4d`.");

/** Operation id: `op_` + 8 hex digits. */
export const OpIdSchema = z
  .string()
  .regex(/^op_[0-9a-f]{8}$/, "must be an operation id like `op_1a2b3c4d`")
  .describe("Operation id from a mutation result or `history`, e.g. `op_1a2b3c4d`.");

/**
 * SPEC §6.2 author: `ui` (desktop app), `cli:<session>` (terminal session,
 * `FRAMESHELL_SESSION`), `cli` (terminal without session), `file` (direct
 * file edit), `plugin:<name>`.
 */
export const AuthorSchema = z
  .string()
  .regex(
    new RegExp(`^(ui|cli|file|cli:.+|plugin:.+|agent:${AGENT_LABEL_PATTERN}(:.+)?)$`),
    "must be `ui`, `cli`, `cli:<session>`, `agent:<label>:<session>`, `file` or `plugin:<name>`",
  )
  .describe(
    "Who made the change: `ui`, `cli:<session>`, `cli`, `agent:<label>:<session>` (an agent CLI such as `claude` " +
      "ran it in that terminal session), `file` or `plugin:<name>`.",
  );

/**
 * One applied operation (SPEC §6.1). `inverse` applied to the timeline right
 * after this operation restores it as it was before.
 */
export const OperationRecordSchema = z.object({
  op: z.string().describe("Operation name, e.g. `clip.trim`."),
  args: z.record(z.string(), z.unknown()).describe("Validated args, defaults filled in."),
  inverse: z
    .object({ op: z.literal("timeline.patch"), args: TimelinePatchSchema })
    .describe("Undoes this operation when applied right after it."),
  id: OpIdSchema,
  author: AuthorSchema,
  tx: TxIdSchema.describe("Transaction the operation belongs to; `revert` takes it to undo the whole transaction."),
  revisionBefore: z.int().describe("Timeline revision the operation was applied to."),
});

/** See {@link OperationRecordSchema}. */
export type OperationRecord = z.output<typeof OperationRecordSchema>;

/** One edge moved by energy snapping (ADR 0003). */
export const SnapReportSchema = z.object({
  field: z.enum(["from", "to", "in", "out", "start", "end"]).describe("Arg the edge came from."),
  clip: z.string().nullable().describe("Trimmed clip; null for `cut`."),
  requested: z.number().describe("Time asked for, seconds, same clock as the arg."),
  applied: z.number().describe("Time used, on the frame grid."),
  clean: z
    .boolean()
    .describe("True: inside an audio pause. False: no pause within the window, cut at the quietest frame; speech may be clipped."),
  window: z.number().describe("Search half-width used, seconds: the op's `snapWindow`, else the project's `editing.snapWindow`, else 0.5."),
});

/** See {@link SnapReportSchema}. */
export type SnapReport = z.output<typeof SnapReportSchema>;

/** Result of every mutating timeline method. */
export const OperationResultSchema = z.object({
  timeline: z.string().describe("Timeline id."),
  revision: z.int().describe("New revision after the operation."),
  operation: OperationRecordSchema,
  changes: z
    .object({
      added: z.array(z.string()).describe("Ids of tracks and clips created."),
      updated: z.array(z.string()).describe("Ids of tracks and clips changed."),
      removed: z.array(z.string()).describe("Ids of tracks and clips deleted."),
      range: z
        .object({
          from: z.number(),
          to: z
            .number()
            .nullable()
            .describe("Null when a touched clip's end is unknown (its nested timeline is missing or invalid): re-read from `from` on."),
        })
        .nullable()
        .describe("Timeline seconds touched, before or after; null when no clip changed."),
    })
    .describe("What changed, for the caller to re-read only that."),
  snaps: z
    .array(SnapReportSchema)
    .describe("`cut` and `clip.trim`: edges placed by audio energy, requested vs applied; empty when none was snapped."),
  warnings: z
    .array(z.string())
    .describe("Applied anyway, but worth fixing: e.g. a `scriptRef` naming a script or scene that does not exist. Empty when none."),
});

/** See {@link OperationResultSchema}. */
export type OperationResult = z.output<typeof OperationResultSchema>;

/** Clip as stored plus derived timing. */
const ClipViewSchema = z
  .looseObject({
    id: z.string(),
    type: z.string(),
    start: z.number(),
    end: z
      .number()
      .nullable()
      .describe("Derived: timeline time just after the last frame. Null when its nested timeline is missing or invalid (see `problems`)."),
  })
  .describe("Clip as stored in the timeline file (asset/source, in/out, speed, …) plus derived `end`.");

/** A clip whose timing cannot be derived; `timeline.show` and `track.list` still answer and list it here. */
export const TimelineProblemSchema = z.object({
  clip: z.string(),
  track: z.string(),
  source: z.string().describe("Nested timeline file the clip references."),
  message: z.string().describe("What is wrong and how to fix it."),
});

/** A subtitle track's stored `style`, as `timeline.show` and `track.list` report it. */
const StoredStyleSchema = z
  .looseObject({ preset: z.string().optional(), position: z.enum(["top", "center", "bottom"]).optional() })
  .nullable()
  .describe("Subtitle tracks: `style` as stored (unset fields use the preset's; no preset = `big-keyword`); null otherwise or when unset.");

/** Compact track summary of `track.list`. */
export const TrackSummarySchema = z.object({
  id: z.string(),
  kind: z.enum(["video", "audio", "subtitles"]),
  name: z.string().nullable(),
  follows: z.string().nullable().describe("Subtitle tracks: followed track id; null otherwise."),
  style: StoredStyleSchema,
  clips: z.int().describe("Number of clips; 0 for subtitle tracks."),
  end: z.number().nullable().describe("Timeline time just after the last clip; 0 when empty; null when a clip's end is unknown."),
});

/** Result of `timeline.show`. */
export const TimelineViewSchema = z.object({
  timeline: z.string(),
  path: z.string().describe("Project-relative file, e.g. `timelines/main.json`."),
  revision: z.int(),
  fps: z.number().describe("Project frame rate: every time is a multiple of 1/fps, 3 decimals."),
  duration: z.number().nullable().describe("Derived: end of the last clip on any track; null when a clip's end is unknown."),
  tracks: z.array(
    z.object({
      id: z.string(),
      kind: z.enum(["video", "audio", "subtitles"]),
      name: z.string().nullable(),
      follows: z.string().nullable(),
      style: StoredStyleSchema,
      clips: z.array(ClipViewSchema).describe("Sorted by start; empty for subtitle tracks."),
    }),
  ),
  problems: z.array(TimelineProblemSchema).describe("Clips whose nested timeline is missing or invalid; empty when none."),
});

/** See {@link TimelineViewSchema}. */
export type TimelineView = z.output<typeof TimelineViewSchema>;
/** See {@link TrackSummarySchema}. */
export type TrackSummary = z.output<typeof TrackSummarySchema>;
/** See {@link TimelineProblemSchema}. */
export type TimelineProblem = z.output<typeof TimelineProblemSchema>;

/**
 * A direct edit of a timeline file the daemon refused (SPEC §6.4). The file
 * on disk holds the daemon's version again; the edit is kept at `preserved`.
 */
export const TimelineRejectionSchema = z.object({
  timeline: z.string().describe("Timeline id; the file is `timelines/<id>.json`."),
  reason: z
    .enum(["stale", "invalid"])
    .describe(
      "`stale`: the edited file's `revision` was not the current one (edited from an old copy, or the revision was changed). " +
        "`invalid`: not JSON, fails the timeline schema, or breaks a timeline rule (e.g. overlapping clips).",
    ),
  message: z.string().describe("What was wrong, precise enough to fix the edit (schema path, clip ids, revisions)."),
  preserved: z
    .string()
    .describe("Project-relative copy of the rejected content, `.frameshell/rejected/<timestamp>-<timeline>.json`."),
  revision: z.int().nullable().describe("`revision` the edit carried; null when unreadable."),
  current: z.int().describe("Revision of the daemon's version, restored on disk."),
  at: z.string().describe("ISO 8601 time of the rejection."),
});

/** See {@link TimelineRejectionSchema}. */
export type TimelineRejection = z.output<typeof TimelineRejectionSchema>;

/**
 * A rejection as `status` lists it, read back from `.frameshell/` so it
 * survives daemon restarts. A preserved copy without recorded details (its
 * log line lost, or kept by an older daemon) has reason `unknown`.
 */
export const RejectionRecordSchema = TimelineRejectionSchema.extend({
  reason: z
    .enum(["stale", "invalid", "unknown"])
    .describe(
      "`stale`: the edit's `revision` was not the current one. `invalid`: not JSON, fails the schema, or breaks a " +
        "timeline rule. `unknown`: the copy is on disk but no reason was recorded; compare it with the timeline file.",
    ),
  current: z.int().nullable().describe("Revision of the daemon's version, restored on disk; null when not recorded."),
});

/** See {@link RejectionRecordSchema}. */
export type RejectionRecord = z.output<typeof RejectionRecordSchema>;
