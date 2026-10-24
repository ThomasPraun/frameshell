import { z } from "zod";
import {
  AnyClipSchema,
  DirectorRulesSchema,
  ElementAdjustSchema,
  MAX_SNAP_WINDOW_S,
  MulticamGroupSchema,
  MIN_SNAP_WINDOW_S,
  ReframeKeySchema,
  SHOT_CORNERS,
  SHOT_LAYOUTS,
  SUBTITLE_POSITIONS,
  SUBTITLE_PRESET_IDS,
  type SubtitlePosition,
  type SubtitlePresetId,
  KEY_EASES,
  TakeIdSchema,
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
const CropSide = z.number().min(0).lt(1).optional();

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
      `${what} Applies to every video, audio and program track (or only \`rippleTracks\`), like \`cut\`, so tracks stay in sync; clips crossing the ` +
        "insertion point stay where they are. Default false: nothing else moves, and a clip that would overlap its " +
        "neighbour is refused.",
    );

/** `rippleTracks` arg of `clip.trim` and `clip.add`: which tracks a ripple moves. */
const rippleTracksArg = z
  .array(TrackRef)
  .min(1)
  .optional()
  .describe(
    "With `ripple: true`: the only video, audio and program tracks whose later clips move; the clip's own track always moves. " +
      "Default: every video, audio and program track. Leave out a track whose later clips would leave a gap (black, silence) " +
      "behind them, e.g. footage or music under a restored voice line; that track keeps its timing.",
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
    speakerNames: z
      .boolean()
      .optional()
      .describe(
        "`true`: the first cue of each speaker turn starts with the speaker's transcript name (\"Juan: …\") and a cue never spans " +
          "two speakers; words with no speaker get no name. Default `false`.",
      ),
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
    index: z
      .int()
      .nonnegative()
      .optional()
      .describe("New stack position, 0 = bottom layer; the other tracks keep their order. Moves the layer up or down."),
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
      .describe(
        "Seconds on the timeline. Required for adapter types and still images, except in an image project, where they " +
          "default to one frame; for `media` an alternative to `out`.",
      ),
    speed: z.number().positive().optional().describe("`media` only: playback rate, e.g. 1.15. Default 1."),
    props: z.record(z.string(), z.unknown()).optional().describe("Adapter types only: properties checked by the adapter's schema."),
    transform: TransformSchema.optional(),
    gain: z.number().optional().describe("Audio gain in dB, e.g. -18. Default 0."),
    muted: z.boolean().optional().describe("Mute the clip's audio. Default false."),
    scriptRef: z.string().min(1).optional().describe("Script scene, e.g. `scripts/script.md#intro`; the path alone refers to the whole script."),
    take: TakeIdSchema.optional().describe("Shoot take the clip comes from (`k_…`), as `shoot.assemble` sets it; leave it out otherwise."),
    ripple: rippleArg("Make room: clips starting at or after `start` move right by the new clip's length."),
    rippleTracks: rippleTracksArg,
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
    rippleTracks: rippleTracksArg,
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
    elements: z
      .record(z.string().min(1), ElementAdjustSchema.nullable())
      .nullable()
      .optional()
      .describe(
        "Adapter types whose plugin applies element styles only (ADR 0021). Merged per CSS selector: an object sets or replaces that selector's " +
          "`{ x, y, scale }` (composition CSS px, scale about the centre); `null` removes it. `null` instead of the map clears every adjustment.",
      ),
    scriptRef: z.string().min(1).nullable().optional().describe("Script scene (`scripts/script.md#intro`) or whole script (`scripts/script.md`); null clears it."),
  }),
  cut: z.strictObject({
    from: Seconds("Start of the timeline range to remove."),
    to: Seconds("End of the range; greater than `from`."),
    tracks: z
      .array(TrackRef)
      .min(1)
      .optional()
      .describe("Tracks to cut. Default: every video, audio and program track, which keeps them in sync."),
    ...snapArgs,
  }),
  "transition.set": z.strictObject({
    at: Seconds("Timeline time of a clip edge: where two clips meet, or a clip's start or end."),
    kind: z
      .enum(["dissolve", "fade"])
      .default("dissolve")
      .describe(
        "`dissolve` (default): the clips mix, sound crossfades. `fade`: dip through black (transparent on upper tracks, silence for sound). " +
          "A clip edge with nothing butted fades in or out for either kind.",
      ),
    duration: z.number().positive().default(0.5).describe("Total seconds the transition plays. Default 0.5; short material shortens it (a warning says so)."),
    tracks: z
      .array(TrackRef)
      .min(1)
      .optional()
      .describe("Tracks to change. Default: every video and audio track that has an edge at `at`, like `cut`."),
  }),
  "transition.remove": z.strictObject({
    at: Seconds("Timeline time of the clip edge to clear."),
    tracks: z.array(TrackRef).min(1).optional().describe("Tracks to change. Default: every video and audio track that has an edge at `at`."),
  }),
  "clip.key": z.strictObject({
    clip: ClipRef,
    prop: z
      .enum(["x", "y", "scale", "opacity", "gain"])
      .describe("Property to animate: `x`, `y` (project pixels), `scale` (factor), `opacity` (0 to 1) or `gain` (dB). Audio tracks take only `gain`."),
    time: Seconds("Timeline time of the key, inside the clip. Give it unless `clear`.").optional(),
    value: z.number().optional().describe("Value at `time`. Default: the value playing there now."),
    ease: z.enum(KEY_EASES).optional().describe("How the value moves from this key to the next: `linear` (default), `in`, `out` or `in-out`."),
    remove: z.boolean().optional().describe("True removes the key at `time` (the one in that frame) instead of setting one."),
    clear: z.boolean().optional().describe("True removes every key of `prop`: its static value plays again. Takes no other field."),
  }),
  "multicam.create": z.strictObject({
    angles: z
      .array(
        z.strictObject({
          asset: z.string().min(1).describe("Project-relative media file with a picture, e.g. `assets/ana.mp4`."),
          name: z.string().min(1).optional().describe("Person or camera, e.g. `Ana`. Default: the file name without extension."),
          offset: Seconds("Group-clock second at which the asset's time 0 plays."),
          mic: z
            .number()
            .int()
            .nonnegative()
            .nullable()
            .optional()
            .describe("Index into `mics` of the mic that carries this angle's sound; null for no sound. Default: the angle's own file."),
        }),
      )
      .min(2)
      .describe("The synced cameras, each with a picture. The `multicam.create` method measures the offsets and passes them here."),
    mics: z
      .array(
        z.strictObject({
          asset: z.string().min(1).describe("Project-relative file with sound, e.g. `assets/ana.wav`."),
          name: z.string().min(1).optional().describe("Person or recorder. Default: the file name without extension."),
          offset: Seconds("Group-clock second at which the asset's time 0 plays."),
        }),
      )
      .optional()
      .describe("Separate sound files, synced like the cameras; angles pick one with `mic`."),
    name: z.string().min(1).optional().describe("Group and program track name. Default: the track is named `Multicam`."),
  }),
  "multicam.gallery": z.strictObject({
    asset: z.string().min(1).describe("Project-relative gallery-view call recording with a picture, e.g. `assets/call.mp4`."),
    tiles: z
      .array(
        z.strictObject({
          name: z.string().min(1).optional().describe("Person in the tile, e.g. `Ana`. Default `Tile <n>`, in reading order."),
          crop: z
            .strictObject({ left: CropSide, top: CropSide, right: CropSide, bottom: CropSide })
            .describe("Fractions of the recording's picture cut off each side to keep this tile."),
        }),
      )
      .min(2)
      .describe("One angle per tile, each a crop of `asset`. The `multicam.gallery` method finds the tiles and passes them here."),
    name: z.string().min(1).optional().describe("Group and program track name. Default: the track is named `Multicam`."),
  }),
  "multicam.offset": z.strictObject({
    group: z.string().min(1).describe("Group id from `timeline.show` (`groups`), e.g. `g_1a2b3c`."),
    angle: z.string().min(1).describe("Angle id of that group."),
    offset: Seconds("New group-clock second at which the angle's asset time 0 plays (absolute, not a nudge)."),
  }),
  "multicam.mic": z.strictObject({
    group: z.string().min(1).describe("Group id from `timeline.show` (`groups`), e.g. `g_1a2b3c`."),
    mic: z.string().min(1).describe("Mic id of that group (`mics`); it never changes, angles keep naming it."),
    name: z.string().min(1).optional().describe("New display name."),
    offset: Seconds("New group-clock second at which the mic's file time 0 plays (absolute, not a nudge).").optional(),
    gain: z.number().optional().describe("Gain of the mic's sound in dB, under every shot. 0 = unchanged level."),
    muted: z.boolean().optional().describe("Mute the mic's sound under every shot."),
  }),
  "multicam.angle": z.strictObject({
    group: z.string().min(1).describe("Group id from `timeline.show` (`groups`), e.g. `g_1a2b3c`."),
    angle: z.string().min(1).describe("Angle id of that group; it never changes, shots keep naming it."),
    name: z.string().min(1).optional().describe("New display name, e.g. `Ana`."),
    crop: z
      .strictObject({
        left: CropSide,
        top: CropSide,
        right: CropSide,
        bottom: CropSide,
      })
      .nullable()
      .optional()
      .describe("Sides to change, fractions of the picture cut off (0 to below 1); omitted sides keep their value, null removes the crop."),
    gain: z.number().optional().describe("Gain of the angle's own file sound in dB, under every shot. 0 = unchanged level. Not for angles with a mic: use `multicam.mic`."),
    muted: z.boolean().optional().describe("Mute the angle's own file sound under every shot. Not for angles with a mic: use `multicam.mic`."),
    mic: z
      .string()
      .min(1)
      .optional()
      .describe("Where the angle is heard: a mic id of the group, `camera` (its own file's sound) or `none` (no sound, e.g. a wide camera)."),
    screen: z
      .boolean()
      .optional()
      .describe("True marks the angle as a screen share (shown by `screen` and `pip` shots, never a speaker); false clears it."),
    speaker: z
      .string()
      .regex(/^s\d+$/, "must look like `s1`")
      .nullable()
      .optional()
      .describe(
        "Speaker id (`s1`, from `transcribe.speakers`) in the transcript of the angle's sound (its mic's file, else its own file) whose " +
          "words are this person's turns, for a file or mic people share; null clears it (turns from energy again, unless the sound is shared).",
      ),
  }),
  "multicam.reframe": z.strictObject({
    group: z.string().min(1).describe("Group id from `timeline.show` (`groups`), e.g. `g_1a2b3c`."),
    angle: z.string().min(1).describe("Angle id of that group."),
    at: Seconds("Group-clock second of the key. Give this or `time`.").optional(),
    time: Seconds("Timeline second of the key: it goes at the group second the group's program track plays then. Give this or `at`.").optional(),
    x: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe("Point to center on across the picture, fraction of the source width (0 left, 1 right). Default: the point there now."),
    y: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe("Point to center on down the picture, fraction of the source height (0 top, 1 bottom). Default: the point there now."),
    remove: z.boolean().optional().describe("True removes the key at `at` or `time` (the one in that frame) instead of setting one."),
    clear: z.boolean().optional().describe("True removes every key: the picture is cut centered again. Takes no other field."),
    keys: z
      .array(ReframeKeySchema)
      .min(1)
      .max(10_000)
      .optional()
      .describe("Replace every key with these (group seconds, any order; one per frame, the last wins). Takes no other field."),
  }),
  "multicam.paint": z.strictObject({
    group: z.string().min(1).describe("Group id from `timeline.show` (`groups`), e.g. `g_1a2b3c`."),
    angle: z
      .string()
      .min(1)
      .optional()
      .describe("Angle id of that group. Left out only with `speaking: null`, which then clears the painted turns of every angle in the range."),
    start: z.number().nonnegative().describe("Group-clock second where the range starts, 3 decimals."),
    end: z.number().positive().describe("Group-clock second where the range ends, after `start`, 3 decimals."),
    speaking: z
      .boolean()
      .nullable()
      .describe("true: the angle speaks in the range. false: it does not, even where its sound is loud. null: back to the measured turns."),
    alone: z
      .boolean()
      .optional()
      .describe("With `speaking: true`: every other angle that can speak is marked silent in the range too, so the person takes the floor. Default false."),
  }),
  "shot.set": z.strictObject({
    clip: ClipRef.describe("Shot id: a clip of a program track, from `timeline.show`."),
    shot: z
      .enum(SHOT_LAYOUTS)
      .optional()
      .describe("New layout: `solo` (one angle), `two-up` (two), `grid` (two or more), `screen` (one angle whole), `pip` (screen + inset). Default: unchanged."),
    corner: z.enum(SHOT_CORNERS).optional().describe("Corner of a `pip` inset. Default: unchanged, else `bottom-right`."),
    angles: z
      .array(z.string().min(1))
      .min(1)
      .optional()
      .describe("Angle ids of the track's group to show, in layout order (left to right, then top to bottom). Default: unchanged."),
  }),
  "multicam.direct": z.strictObject({
    group: z.string().min(1).describe("Group id from `timeline.show` (`groups`), e.g. `g_1a2b3c`."),
    from: Seconds("Timeline time where directing starts. Default 0.").optional(),
    to: Seconds("Timeline time where it ends; greater than `from`. Default: the program track's end.").optional(),
    turns: z
      .array(
        z.strictObject({
          angle: z.string().min(1),
          start: z.number().nonnegative().describe("Group-clock seconds."),
          end: z.number().nonnegative().describe("Group-clock seconds; greater than `start`."),
        }),
      )
      .describe("Speaking turns of the group's angles. The `multicam.direct` method measures them and passes them here."),
    motion: z
      .array(
        z.strictObject({
          angle: z.string().min(1),
          start: z.number().nonnegative().describe("Group-clock seconds."),
          end: z.number().nonnegative().describe("Group-clock seconds; greater than `start`."),
        }),
      )
      .optional()
      .describe("Stretches in which a screen angle changes. The `multicam.direct` method measures them and passes them here."),
    rules: DirectorRulesSchema.describe("Resolved rules: a template with `director.json` on top."),
    keep: z.array(z.string().min(1)).describe("Shot ids left exactly as they are: the shots a person chose."),
  }),
} as const;

/** Name of a public timeline operation. */
export type OperationName = keyof typeof operationArgs;

/**
 * Change that restores or replaces parts of a timeline. Every operation's
 * inverse is a patch, so one `apply` undoes any operation.
 * Applied in order: `groups` (replace, insert or delete whole multicam
 * groups), `tracks` (replace, insert or delete whole tracks), then `clips`
 * (upsert or delete one clip in a track), then `order`.
 */
export const TimelinePatchSchema = z.strictObject({
  groups: z
    .array(z.strictObject({ id: z.string().min(1), group: MulticamGroupSchema.nullable().describe("Full group; null deletes it.") }))
    .optional(),
  tracks: z
    .array(z.strictObject({ id: z.string().min(1), track: TrackSchema.nullable().describe("Full track; null deletes it.") }))
    .optional(),
  clips: z
    .array(
      z.strictObject({
        track: z.string().min(1),
        id: z.string().min(1),
        clip: AnyClipSchema.nullable().describe("Full clip; null deletes it."),
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
      added: z.array(z.string()).describe("Ids of multicam groups, tracks and clips created."),
      updated: z.array(z.string()).describe("Ids of multicam groups, tracks and clips changed."),
      removed: z.array(z.string()).describe("Ids of multicam groups, tracks and clips deleted."),
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

/**
 * Below this a measured sync is not trusted: the file starts with the reference (the first file with sound)
 * and a warning is given.
 */
export const SYNC_LOW_CONFIDENCE = 0.5;

/** How one file was synced (`multicam.create`). */
export const AngleSyncSchema = z.object({
  kind: z.enum(["camera", "mic"]).describe("`camera`: an angle; `mic`: a separate sound file."),
  angle: z.string().describe("Angle id (`camera`) or mic id (`mic`) in the new group."),
  name: z.string(),
  asset: z.string(),
  offset: z.number().describe("Group-clock second at which the asset's time 0 plays, as stored."),
  confidence: z
    .number()
    .min(0)
    .max(1)
    .nullable()
    .describe("0 (no shared sound found) to 1 (unmistakable) for the audio match with `against`; null for the reference file itself."),
  against: z.string().nullable().describe("Id of the already placed file this one was matched with (the best match of all); null for the reference or when nothing matched."),
  synced: z
    .boolean()
    .describe(
      "False when the confidence is below 0.5 against every other file: no trustworthy match, so the offset was not measured (the file starts with the reference) " +
        "and a warning says so. Fix it with `multicam.offset` (camera) or `multicam.mic` (mic).",
    ),
});

/** Result of `multicam.create`: the operation plus the new ids and every angle's sync. */
export const MulticamCreateResultSchema = OperationResultSchema.extend({
  group: z.string().describe("Id of the new group."),
  track: z.string().describe("Id of the new program track."),
  clip: z.string().describe("Id of the initial `grid` shot, which covers the whole group."),
  sync: z.array(AngleSyncSchema).describe("One entry per file: the cameras in the order given, then the mics."),
});

/** See {@link MulticamCreateResultSchema}. */
export type MulticamCreateResult = z.output<typeof MulticamCreateResultSchema>;

/** Result of `multicam.gallery`: the operation plus the tiles found and the layouts of the call. */
export const MulticamGalleryResultSchema = OperationResultSchema.extend({
  group: z.string().describe("Id of the new group."),
  track: z.string().describe("Id of the new program track."),
  clip: z.string().describe("Id of the initial `grid` shot, which covers the whole recording."),
  mic: z
    .string()
    .nullable()
    .describe("Id of the group mic that plays the recording's sound once for every tile; null when the file has no sound (tiles are then silent)."),
  confidence: z.number().describe("Lowest tile confidence, 0 to 1. Below 0.5: look at the tiles before directing."),
  samples: z.int().describe("Frames analysed, evenly spread over the whole recording."),
  tiles: z
    .array(
      z.object({
        angle: z.string().describe("Angle id."),
        name: z.string(),
        crop: z
          .object({ left: z.number().optional(), top: z.number().optional(), right: z.number().optional(), bottom: z.number().optional() })
          .describe("Fractions of the picture cut off each side, as stored on the angle."),
        confidence: z
          .number()
          .describe("0 to 1: share of the frames of this layout that showed this tile, lowered when its size differs from the other tiles'."),
      }),
    )
    .describe("One per angle, in reading order (rows top to bottom, each left to right)."),
  layouts: z
    .array(
      z.object({
        start: z.number().describe("Recording seconds (= group seconds: the angles start at 0)."),
        end: z.number(),
        tiles: z.int().describe("Tiles of the grid in this stretch; 0 where no tile grid was found (speaker view, a shared screen)."),
        used: z.boolean().describe("True for stretches with the layout the group's angles were cut from."),
      }),
    )
    .describe("The recording from start to end, one entry per stretch with one layout; more than one entry means the layout changed mid-call."),
});

/** See {@link MulticamGalleryResultSchema}. */
export type MulticamGalleryResult = z.output<typeof MulticamGalleryResultSchema>;

/** One stretch of speech of one angle's person, on the group clock. */
export const SpeakingTurnSchema = z.object({
  angle: z.string().describe("Angle id in the group."),
  name: z.string().describe("Angle name, e.g. the person."),
  start: z.number().describe("Group-clock seconds where the person starts speaking."),
  end: z.number().describe("Group-clock seconds where the turn ends; greater than `start`."),
});

/** Result of `multicam.turns`. */
export const MulticamTurnsResultSchema = z.object({
  timeline: z.string(),
  revision: z.int(),
  group: z.string(),
  duration: z.number().describe("Group-clock seconds where the last angle's file ends."),
  turns: z
    .array(SpeakingTurnSchema)
    .describe("Every angle's turns sorted by `start`. Turns of different angles may overlap: both people spoke at once."),
  warnings: z
    .array(z.string())
    .describe("Angles that could not be measured (no sound, unreadable, no transcript speakers) and guessed speakers of a shared mic."),
  speakers: z
    .array(
      z.object({
        angle: z.string(),
        speaker: z.string().describe("Transcript speaker id whose words are the angle's turns."),
        transcript: z.string().describe("Transcript file, project-relative."),
      }),
    )
    .describe("Angles whose turns come from transcript speakers instead of their own mic. Empty when every angle has its own mic."),
});

/** See {@link MulticamTurnsResultSchema}. */
export type MulticamTurnsResult = z.output<typeof MulticamTurnsResultSchema>;

/** A shot the director wrote, placed on the timeline. */
export const DirectedShotSchema = z.object({
  clip: z.string().describe("Shot id."),
  start: z.number().describe("Timeline seconds."),
  end: z.number().describe("Timeline seconds."),
  shot: z.enum(SHOT_LAYOUTS),
  angles: z.array(z.string()),
  confidence: z.number().describe("0 (a guess) to 1 (sure)."),
  reason: z.string(),
});

/** Result of `multicam.direct`: the operation plus what the director did. */
export const MulticamDirectResultSchema = OperationResultSchema.extend({
  group: z.string(),
  track: z.string().describe("Program track the shots were written to."),
  template: z.string().describe("Template the rules started from."),
  rulesFile: z.string().nullable().describe("Project-relative rules file read on top of the template; null when none was."),
  shots: z.int().describe("Shots written."),
  kept: z.array(z.string()).describe("Ids of the shots a person chose in the range, left as they were."),
  low: z
    .array(DirectedShotSchema)
    .describe("Written shots with `confidence` below 0.5, by `start`: the ones to review (watch them, then `shot.set` where the rules guessed wrong)."),
});

/** See {@link MulticamDirectResultSchema}. */
export type MulticamDirectResult = z.output<typeof MulticamDirectResultSchema>;

/** Result of `multicam.faces`: what was found per angle and the operations that wrote the keys. */
export const MulticamFacesResultSchema = z.object({
  timeline: z.string(),
  revision: z.int().describe("Revision after the last write; the one read at the start when nothing was written."),
  group: z.string(),
  angles: z
    .array(
      z.object({
        angle: z.string(),
        name: z.string(),
        samples: z.int().describe("Frames looked at (2 per second of the angle's file)."),
        faces: z.int().describe("Of those, frames where a face was found inside the angle's crop."),
        keys: z.int().describe("Reframe keys written; 0 when no face was found, which leaves the angle as it was."),
        operation: z.string().nullable().describe("Id of the `multicam.reframe` operation that wrote them; null when none did."),
      }),
    )
    .describe("Angles looked at, in group order."),
  kept: z.array(z.string()).describe("Angles skipped because they already had reframe keys (pass `replace: true` to redo them)."),
  tx: z.string().nullable().describe("Transaction of the writes, revertible as one; null when nothing was written."),
  warnings: z.array(z.string()).describe("Angles with few or no faces found. Empty when none."),
});

/** See {@link MulticamFacesResultSchema}. */
export type MulticamFacesResult = z.output<typeof MulticamFacesResultSchema>;

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
  .looseObject({ preset: z.string().optional(), position: z.enum(["top", "center", "bottom"]).optional(), speakerNames: z.boolean().optional() })
  .optional()
  .describe("Subtitle tracks: `style` as stored (unset fields use the preset's; no preset = `big-keyword`); absent for clip tracks and when unset.");

/** Track kinds as `timeline.show` and `track.list` report them. */
const TrackKindSchema = z
  .enum(["video", "audio", "program", "subtitles"])
  .describe("`program`: the shots of a multicam group (ADR 0016), its angles' sound under every shot.");

/** Group id of a program track in track views. */
const ProgramGroupSchema = z.string().optional().describe("Program tracks: id of the multicam group in `groups`; absent for other tracks.");

/** Compact track summary of `track.list`. */
export const TrackSummarySchema = z.object({
  id: z.string(),
  kind: TrackKindSchema,
  name: z.string().nullable(),
  follows: z.string().nullable().describe("Subtitle tracks: followed track id; null otherwise."),
  group: ProgramGroupSchema,
  style: StoredStyleSchema,
  clips: z.int().describe("Number of clips (shots on a program track); 0 for subtitle tracks."),
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
      kind: TrackKindSchema,
      name: z.string().nullable(),
      follows: z.string().nullable(),
      group: ProgramGroupSchema,
      style: StoredStyleSchema,
      clips: z.array(ClipViewSchema).describe("Sorted by start; empty for subtitle tracks."),
    }),
  ),
  groups: z
    .array(MulticamGroupSchema)
    .optional()
    .describe("Multicam groups as stored (angles with asset, offset, crop, audio); absent when the timeline has none."),
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
    .enum(["stale", "invalid", "proposal-pending"])
    .describe(
      "`stale`: the edited file's `revision` was not the current one (edited from an old copy, or the revision was changed). " +
        "`invalid`: not JSON, fails the timeline schema, or breaks a timeline rule (e.g. overlapping clips). " +
        "`proposal-pending`: review mode (ADR 0019) and another proposal waits for review; reapply the edit once it is decided.",
    ),
  message: z.string().describe("What was wrong, precise enough to fix the edit (schema path, clip ids, revisions)."),
  preserved: z
    .string()
    .describe("Project-relative copy of the rejected content, `.frameshell/rejected/<timestamp>-<timeline>.json`."),
  revision: z.int().nullable().describe("`revision` the edit carried; null when unreadable."),
  current: z
    .int()
    .nullable()
    .describe("Revision of the daemon's version, restored on disk; null when it has none (a new or unreadable file, put back as it was)."),
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
    .enum(["stale", "invalid", "proposal-pending", "unknown"])
    .describe(
      "`stale`: the edit's `revision` was not the current one. `invalid`: not JSON, fails the schema, or breaks a " +
        "timeline rule. `proposal-pending`: another proposal waited for review (ADR 0019). `unknown`: the copy is on " +
        "disk but no reason was recorded; compare it with the timeline file.",
    ),
  current: z.int().nullable().describe("Revision of the daemon's version, restored on disk; null when not recorded."),
});

/** See {@link RejectionRecordSchema}. */
export type RejectionRecord = z.output<typeof RejectionRecordSchema>;
