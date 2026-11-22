import { z } from "zod";
import { ViewedShape } from "../proposals.js";
import { BeatsEditsSchema, DIRECTOR_TEMPLATE_IDS } from "@frameshell/schema";
import {
  CaptionsSetResultSchema,
  MulticamCreateResultSchema,
  MulticamDirectResultSchema,
  ClipReframeResultSchema,
  ClipZoomResultSchema,
  MulticamFacesResultSchema,
  MulticamGalleryResultSchema,
  MulticamTurnsResultSchema,
  OperationResultSchema,
  TimeRef,
  TimelineIdSchema,
  TimelineProblemSchema,
  TimelineViewSchema,
  TrackSummarySchema,
  operationArgs,
} from "../timeline.js";
import { type MethodSpec, BeatsSummarySchema, CwdParam, ViewParam } from "./shared.js";

/** Daemon methods: timeline reads, tracks, multicam, segmentation, beats and captions. */
export const timelineMethods = {
  "timeline.show": {
    description:
      "Compact dump of a timeline for agents: revision, project fps, derived duration, and every track with its clips " +
      "(ids, type, asset/source, `start`/`end` in timeline seconds, `in`/`out` in source seconds, speed, audio, transform). " +
      "Read this before editing and use the returned ids. A clip whose nested timeline file is missing or invalid has " +
      "`end: null` and is listed in `problems` with the fix. In review mode, `view` picks the file or the open " +
      "proposal's version (default: yours when the proposal is yours). Fails with TimelineNotFound or InvalidProjectFile.",
    params: z.strictObject({
      cwd: CwdParam,
      timeline: TimelineIdSchema,
      view: ViewParam,
      grid: z
        .boolean()
        .optional()
        .describe("True adds `grid`: the beat grid of the timeline's `tempo` with every beat and bar start in timeline seconds (can be long). Default false; `tempo.show` reads it alone."),
    }),
    result: TimelineViewSchema.extend(ViewedShape),
  },
  "track.list": {
    description:
      "List a timeline's tracks in stacking order (first video track = bottom layer): id, kind, name, followed track, " +
      "clip count and end time (null while a clip's nested timeline is missing or invalid; see `problems`). " +
      "In review mode, `view` picks the file or the open proposal's version. Fails with TimelineNotFound or InvalidProjectFile.",
    params: z.strictObject({ cwd: CwdParam, timeline: TimelineIdSchema, view: ViewParam }),
    result: z.object({
      ...ViewedShape,
      timeline: z.string(),
      revision: z.int(),
      tracks: z.array(TrackSummarySchema),
      problems: z.array(TimelineProblemSchema),
    }),
  },
  "track.add": {
    mutating: true,
    description:
      "Add a track and return its new id (`t_…`). Example: `{ kind: \"video\", name: \"Camera\" }`; subtitle tracks need " +
      "`follows`: `{ kind: \"subtitles\", follows: \"t_4d5e6f\", style: { preset: \"big-keyword\" } }`. A subtitle track " +
      "copies no words: it shows the transcript words (`transcribe` first) inside each clip of the followed track, on " +
      "the timeline clock, so cuts update it and text corrections go in the transcript's `edits`. Placed on top unless " +
      "`index` is given.",
    params: operationArgs["track.add"].extend({ cwd: CwdParam, timeline: TimelineIdSchema }),
    result: OperationResultSchema,
  },
  "track.set": {
    mutating: true,
    description:
      "Change a track: `name` (any track; null clears it), and for subtitle tracks the followed track (`follows`) and " +
      "`style` (`preset`: `big-keyword` or `plain`; `position`: `top`, `center` or `bottom`; `speakerNames`: true shows the " +
      "speaker's name at each turn; `entry`: `none`, `chars`, `words` or `line` softly fades the text in; `keywordColor` / " +
      "`keywordScale` style the keyword `captions.set` marks, null colour = none; given fields change, others stay) and `gaps` " +
      "(timeline-second ranges in which no cue shows, e.g. while a graphic says the same; replaces them, `[]` clears). " +
      "Example: `{ track: \"t_4d5e6f\", style: { position: \"top\" }, gaps: [{ from: 12, to: 15.5 }] }`. Preview and export use the same style. " +
      "`muted: true` silences a video, audio or program track whatever its clips' own audio; `hidden: true` leaves a video or " +
      "program track's pictures out (the tracks below show through, its sound still plays); false undoes either. " +
      "`behind: \"<plate track>\"` puts a video track's pictures behind the person in front on a lower video track (ADR 0032): " +
      "a big word or a logo between the background and the person. Export draws the plate's media clips again above this " +
      "track through each asset's subject matte (`matte.prepare`), waiting for a matte that is not made yet (about 2 min " +
      "per min of video); the preview does not show it yet. Keep the word 30-55 % covered and never over the face. " +
      "`behind: null` clears it; removing or moving the plate track so it is no longer below clears it too, with a warning. " +
      "`format` (ADR 0027, a format other than the primary) with `style` sets a subtitle track's captions in that format only, " +
      "e.g. `{ track, format: \"9x16\", style: { position: \"center\" } }` (a vertical format still draws them 1.3x larger); " +
      "`reset: true` drops that format's style first. " +
      "Fails with TrackNotFound, FormatNotFound or InvalidOperation (style or follows on a clip track, muted on a subtitle track, hidden on an " +
      "audio or subtitle track, behind on a track that is not video, a plate that is not a lower video track, or in an image " +
      "project, `format` on a clip track or with another field than `style`, nothing to change).",
    params: operationArgs["track.set"].extend({ cwd: CwdParam, timeline: TimelineIdSchema }),
    result: OperationResultSchema,
  },
  "track.remove": {
    mutating: true,
    description:
      "Remove a track. A track with clips needs `force: true`; a track followed by a subtitle track is refused until that " +
      "subtitle track is removed. Fails with TrackNotFound or InvalidOperation.",
    params: operationArgs["track.remove"].extend({ cwd: CwdParam, timeline: TimelineIdSchema }),
    result: OperationResultSchema,
  },
  "clip.add": {
    mutating: true,
    description:
      "Place a clip on a video or audio track and return its new id (`c_…`) in `changes.added`. Media example: " +
      "`{ track: \"t_4d5e6f\", asset: \"assets/raw-01.mp4\", start: 0, in: 3.2, out: 15.733 }` (in/out are source seconds, " +
      "default the whole asset; start defaults to right after the track's last clip). Adapter example: " +
      "`{ track, type: \"hyperframes\", source: \"compositions/hyperframes/intro/index.html\", duration: 8, props: {…} }`. " +
      "Times snap to the project frame grid. `ripple: true` inserts: clips at or after `start` on every video and audio " +
      "track (or only `rippleTracks`) move right to make room (e.g. to restore removed words: `{ track, asset, start: 12.4, " +
      "in: 30.1, out: 30.9, ripple: true, snap: true }`). `snap: true` moves media `in`/`out` into audio pauses and reports them in `snaps`. " +
      "Fails with InvalidOperation (overlap, out beyond the source duration, wrong " +
      "track kind, unknown clip type; data says the valid range), AssetNotFound, TrackNotFound.",
    params: operationArgs["clip.add"].extend({ cwd: CwdParam, timeline: TimelineIdSchema }),
    result: OperationResultSchema,
  },
  "multicam.create": {
    mutating: true,
    description:
      "Make a multicam group from cameras (one file per camera or person) and, optionally, separate mic files (ADR 0016). Measures " +
      "every file's offset by audio cross-correlation (the sound they share: a clap, the room, bleed from the other mic) against " +
      "ALL the others, not only the first: each file is placed by its best match with a file already placed, so a camera whose " +
      "sound is faint still lands through the mic that hears the same room. The earliest file starts at 0, then the group, a " +
      "program track and one `grid` shot over the cameras' length are added. A camera's sound is its own file's unless a mic " +
      "carries it: `soundOf` has one entry per camera, a 1-based index into `mics`, `none` (wide camera: no sound) or `camera` " +
      "(its own file). Default: the camera n takes mic n while there are mics, the rest keep their own file; one mic may serve " +
      "several cameras. Example: `{ assets: [\"assets/wide.mp4\", \"assets/ana.mp4\", \"assets/ben.mp4\"], mics: [\"assets/ana.wav\", " +
      "\"assets/ben.wav\"], soundOf: [\"none\", \"1\", \"2\"] }`. `sync` reports each file's offset, `confidence` (0 to 1) and the file it " +
      "was matched `against`. Below 0.5 no trustworthy match was found: that file is not shifted (it starts with the reference), " +
      "`synced` is false and a warning says so; check it by ear or eye, then fix it with `multicam.offset` (cameras) or " +
      "`multicam.mic` (mics). Only the first ten minutes of each file are matched. Needs two or more cameras with a picture; " +
      "the reference is the first file with sound; a file without sound is not synced. With `offsets` (known start times, e.g. " +
      "from one recorder's clock) nothing is matched: one camera is enough (its shot is then `solo`), no file needs sound, and " +
      "`sync` reports `confidence` and `against` null. `screens` marks cameras that are screen shares (as `multicam.angle` `screen`). " +
      "Fails with InvalidOperation (file missing or unreadable, no picture, no file with sound, outside the project, bad `soundOf`).",
    params: z.strictObject({
      cwd: CwdParam,
      timeline: TimelineIdSchema,
      assets: z
        .array(z.string().min(1))
        .min(1)
        .describe(
          "Camera files with a picture, inside the project, absolute or relative to `cwd`; the first one sets the clock unless it has no sound. " +
            "Two or more unless `offsets` is given.",
        ),
      names: z.array(z.string().min(1)).optional().describe("Angle names in the same order, e.g. the people. Default: file names."),
      mics: z.array(z.string().min(1)).optional().describe("Separate sound files (audio or video files; only the sound is used), same rules as `assets`."),
      micNames: z.array(z.string().min(1)).optional().describe("Mic names in the same order as `mics`. Default: file names."),
      soundOf: z
        .array(z.string().min(1))
        .optional()
        .describe("One entry per camera, in order: a 1-based index into `mics`, `none` or `camera`. Default: see the description."),
      name: z.string().min(1).optional().describe("Name of the group and its program track. Default track name `Multicam`."),
      offsets: z
        .array(z.number().nonnegative())
        .optional()
        .describe(
          "Known offsets instead of matching sound: one per file, cameras then mics, the group-clock second at which the file's time 0 plays, " +
            "e.g. `[0, 0.012, 0.003]`. Default: measured.",
        ),
      screens: z
        .array(z.int().min(1))
        .optional()
        .describe("1-based numbers of the cameras that are screen shares, e.g. `[2]`. Default: none."),
    }),
    result: MulticamCreateResultSchema,
  },
  "multicam.gallery": {
    mutating: true,
    description:
      "Make a multicam group from one gallery-view call recording (Zoom, Meet, Teams: every person in a tile of one picture; " +
      "ADR 0016). Finds the tile grid by its gutters (lines of one flat colour between tiles) on frames sampled across the " +
      "whole file, then adds one angle per tile, each a `crop` of the same file in reading order (rows top to bottom, each " +
      "left to right), a program track and one `grid` shot over the recording. The file's sound plays once for all tiles " +
      "through one group mic (`mic`): every tile hears the same mixed track, so they speak together for `multicam.turns` " +
      "until that file's transcript has speakers (`transcribe`, then `transcribe.speakers`; then name each tile's `speaker` " +
      "with `multicam.angle`). Each tile reports a `confidence` (0 to 1); below 0.5 check it on a frame and fix it with " +
      "`multicam.angle` `crop`. `layouts` lists the stretches of the call with their tile count: when the layout changes " +
      "mid-call (someone joins or leaves, a screen share) a warning gives the times; the angles follow the layout held " +
      "longest, or the one playing at `at`. Gallery recordings only: a speaker-view or single-camera file has no grid. " +
      "A call recorded in the app's Shoot view (ADR 0024) is already a group with the call window as a screen angle: pass " +
      "`group` (and `mic`, the group mic of the call's system audio) to add the tiles to that group at the window's offset, " +
      "keeping its shots. " +
      "Example: `{ asset: \"assets/call.mp4\", names: [\"Ana\", \"Ben\", \"Zoe\"] }`. Fails with InvalidOperation (file " +
      "missing, outside the project or without a picture, no tile grid found, `at` in a stretch without one, wrong number " +
      "of `names`: data has the tile count; with `group`, no such group or mic, no angle of it playing `asset`, or its tiles added already), or the Binary* errors when ffmpeg cannot be fetched.",
    params: z.strictObject({
      cwd: CwdParam,
      timeline: TimelineIdSchema,
      asset: z.string().min(1).describe("Gallery recording inside the project, absolute or relative to `cwd`, e.g. `assets/call.mp4`."),
      names: z
        .array(z.string().min(1))
        .optional()
        .describe("Angle names in reading order, one per tile, e.g. the people. Default `Tile 1`, `Tile 2`, …"),
      name: z.string().min(1).optional().describe("Name of the group and its program track. Default track name `Multicam`."),
      at: z
        .number()
        .nonnegative()
        .optional()
        .describe("Recording second whose layout the tiles are cut from. Default: the layout held longest."),
      group: operationArgs["multicam.gallery"].shape.group,
      mic: operationArgs["multicam.gallery"].shape.mic,
    }),
    result: MulticamGalleryResultSchema,
  },
  "multicam.offset": {
    mutating: true,
    description:
      "Fix one angle's sync by hand: set `offset`, the group-clock second at which its file's time 0 plays (absolute, not a nudge: " +
      "a smaller offset makes the angle play earlier against the others). Offsets cannot be negative: to start an angle before " +
      "the others, raise the others' offsets. Example: `{ group: \"g_1a2b3c\", angle: \"ben\", offset: 1.42 }`. " +
      "Fails with InvalidOperation when the group or angle does not exist, or when a shot would then play past the group's end " +
      "(trim those shots first).",
    params: operationArgs["multicam.offset"].extend({ cwd: CwdParam, timeline: TimelineIdSchema }),
    result: OperationResultSchema,
  },
  "multicam.mic": {
    mutating: true,
    description:
      "Change one separate mic of a multicam group: `name`, `offset` (group-clock second at which its file's time 0 plays, absolute; " +
      "fixes its sync) and its sound under every shot (`gain` dB, `muted`). The mic plays once, whichever angles use it. " +
      "Example: `{ group: \"g_1a2b3c\", mic: \"ana-lav\", offset: 0.84, gain: -2 }`. Pick which mic an angle uses with `multicam.angle`. " +
      "Fails with InvalidOperation when the group or mic does not exist or nothing is given.",
    params: operationArgs["multicam.mic"].extend({ cwd: CwdParam, timeline: TimelineIdSchema }),
    result: OperationResultSchema,
  },
  "multicam.angle": {
    mutating: true,
    description:
      "Change one angle of a multicam group: `name`, `crop` (fractions of its picture cut off each side, merged side by side; " +
      "null removes it), its sound under every shot (`gain` dB, `muted`: the angle's own file; with a mic they belong to the mic, see " +
      "`multicam.mic`), where it is heard (`mic`: a mic id of the group, `camera` for its own file, `none` for no sound), `screen` " +
      "(true: a screen share, which the director shows while it moves, never as a speaker) and `speaker`: the transcript speaker (`s1`, from " +
      "`transcribe.speakers` on the angle's sound: its mic's file, else its own) whose words are this person's turns when people share " +
      "a file or mic (null clears it). The angle id stays, so shots keep showing it. " +
      "Example: `{ group: \"g_1a2b3c\", angle: \"ben\", crop: { left: 0.1, right: 0.1 }, gain: -3 }`. Sync is `multicam.offset`. " +
      "Fails with InvalidOperation when the group, angle or mic does not exist, nothing is given, gain or muted is given for an angle that takes its sound from a mic or none, or the crop would leave no picture " +
      "(left + right, top + bottom must stay below 1).",
    params: operationArgs["multicam.angle"].extend({ cwd: CwdParam, timeline: TimelineIdSchema }),
    result: OperationResultSchema,
  },
  "multicam.reframe": {
    mutating: true,
    description:
      "Reframe one angle of a multicam group over time: set or remove a key of its `reframe`, the point of its picture (`x`, `y`: " +
      "fractions of the source width and height) that a tile cutting the picture to its aspect centers on. This is how a 9:16 export " +
      "(`vertical-1080x1920`) of 16:9 cameras keeps each face in its solo and two-up shots. Keys live in the group, on the group clock, " +
      "so every shot of that angle follows them and ripple cuts keep them on the same picture; between keys the point moves in a " +
      "straight line, before the first and after the last it holds. Give the key time as `at` (group seconds) or `time` (timeline " +
      "seconds, mapped through the program track's shot playing then). A key in the same frame is replaced; an omitted `x` or `y` " +
      "keeps the point there now. `remove: true` deletes the key in that frame, `clear: true` every key, `keys` replaces them " +
      "all at once (`multicam.faces` proposes them from faces). A 16:9 frame of 16:9 " +
      "cameras is not cut, so keys change nothing there; screens are never cut. " +
      "Example: `{ group: \"g_1a2b3c\", angle: \"ana\", time: 12.5, x: 0.32 }`. " +
      "Fails with InvalidOperation when the group or angle does not exist, neither or both of `at` and `time` are given, no shot of " +
      "the group plays at `time`, nothing is given to set, or `remove` finds no key in that frame.",
    params: operationArgs["multicam.reframe"].extend({ cwd: CwdParam, timeline: TimelineIdSchema }),
    result: OperationResultSchema,
  },
  "multicam.faces": {
    mutating: true,
    description:
      "Propose `reframe` keys for the angles of a multicam group from the faces in their pictures (ADR 0016), so a 9:16 export " +
      "(`vertical-1080x1920`) of 16:9 cameras keeps each person in frame. Looks at 2 frames per second of each angle's file " +
      "(locally, on CPU: the YuNet face detector run by ONNX Runtime; the first run downloads both, about 33 MB, from their " +
      "builders), follows the largest face inside the angle's crop, and writes keys only where it moves: one key per still " +
      "stretch, a quick glide between them. One `multicam.reframe` operation per angle (with `keys`), all in one transaction, " +
      "so one revert undoes the lot; the person corrects keys in the app or with `multicam.reframe` as usual. Angles that " +
      "already have keys are skipped (`kept`) unless `replace: true`; screens are never looked at. An angle where no face is " +
      "found is left as it was, with a warning. Takes a while on long recordings (progress arrives as `progress` " +
      "notifications). It runs as a background job of kind `faces` (`job.list`), so it goes on if the caller disconnects. Example: `{ group: \"g_1a2b3c\", angles: [\"ana\"] }`. Fails with InvalidOperation (group or angle " +
      "missing, an angle named that is a screen), TimelineNotFound, AssetNotFound, or the Binary* errors when ffmpeg, ONNX " +
      "Runtime or the model cannot be fetched.",
    params: z.strictObject({
      cwd: CwdParam,
      timeline: TimelineIdSchema,
      group: z.string().min(1).describe("Group id (`g_…`) from `timeline.show` `groups` or `multicam.create`."),
      angles: z
        .array(z.string().min(1))
        .min(1)
        .optional()
        .describe("Angle ids to look at. Default: every angle of the group that is not a screen."),
      replace: z.boolean().optional().describe("Also redo angles that already have reframe keys, replacing them. Default false."),
    }),
    result: MulticamFacesResultSchema,
  },
  "clip.reframe": {
    mutating: true,
    description:
      "Frame one video clip for another aspect, vertical (`9x16`) by default, keeping a face in it (epic #451, reels). The picture is " +
      "scaled to cover the frame (`transform.scale`) and positioned so the face center sits at the middle and 30 % from the top, " +
      "never showing outside the picture. Without `person` or `anchor` it looks at 2 frames per second of the clip's own stretch " +
      "of its file (locally, on CPU: YuNet face detection; the first run downloads it, about 33 MB), follows the largest face, " +
      "and writes `x`/`y` keys only where the face moves: a still stretch holds, a move glides with ease in-out; a face that never " +
      "moves gives a static `transform` and no keys. `person` (id or name) follows that person's face from the cached face scan " +
      "(`people scan`, with the person's face linked) instead, with no detection. `anchor` (0 to 1) skips faces: a fixed " +
      "horizontal position of the picture (0 left edge, 1 right edge) in the middle of the frame, for footage with no face. " +
      "Rotation metadata is applied to the picture first. One transaction labelled `Reframe <file name>` (yours when one is open): " +
      "`revert` undoes it, the person edits the keys in the inspector or with `clip.key`, and in review mode it is one proposal. " +
      "It replaces the clip's `x`, `y` and `scale` (static and keys; a warning says so) and leaves its other fields. When " +
      "`format` is the id of a format of the project other than the primary (`format.list`, ADR 0027), the framing goes into " +
      "the clip's override there (`formats.<id>`, as `clip.set`/`clip.key` with `format` write it; `inFormat` in the result) " +
      "and the clip itself, the primary and every other format keep theirs, so each format can follow the face its own way. " +
      "Otherwise `format` is an aspect and the framing goes into the clip, for every format: with a project of another " +
      "aspect the preview shows the project frame zoomed; a warning says so. `9:16` always means the aspect. For landscape footage with no face, look at a frame " +
      "(`frame.capture`) and pick `anchor`. A clip with no face found is left as it was, with a warning. Runs as a background " +
      "job of kind `faces` (`job.list`) with `progress` notifications. " +
      "Example: `{ clip: \"c_0003\", format: \"9x16\" }`. Fails with InvalidOperation (not a media clip on a video track, " +
      "no moving picture to look at, bad `format`, `person` and `anchor` together, `person` unknown or its file not scanned), " +
      "ClipNotFound, TimelineNotFound, AssetNotFound, or the Binary* errors when ffmpeg, ONNX Runtime or the model cannot be fetched.",
    params: z.strictObject({
      cwd: CwdParam,
      timeline: TimelineIdSchema,
      clip: z.string().min(1).describe("Id of a media clip on a video track, from `timeline.show`."),
      format: z
        .string()
        .min(1)
        .optional()
        .describe(
          "A format id of the project (`format.list`; one other than the primary takes the framing in its override), else the aspect " +
            "of the frame, `<w>x<h>` or `<w>:<h>`: `9x16` (default), `1x1`, `4x5`, `16x9`…",
        ),
      person: z.string().min(1).optional().describe("Follow this person's face (id or exact name from `people.list`) from the cached scan of the clip's file."),
      anchor: z.number().min(0).max(1).optional().describe("Fixed horizontal position of the picture in the frame, 0 (left edge) to 1 (right edge); no face detection."),
    }),
    result: ClipReframeResultSchema,
  },
  "clip.zoom": {
    mutating: true,
    description:
      "Zoom a screen recording to where the action is (ADR 0049, tutorials): push in where the mouse pointer rests and ease back " +
      "out when it moves on, from the pointer track Shoot records next to each screen file (`.<name>.pointer.json` in its folder; " +
      "`pointer` names another file of the same shape). A rest is the pointer staying within a small circle for 0.8 s or more; " +
      "quick moves never zoom. Each zoom eases in 0.5 s before the pointer arrives, holds while it rests, and eases back 0.4 s after " +
      "it leaves; rests less than 1.2 s apart stay in one zoom that glides from spot to spot. The zoom brings the spot to the frame's " +
      "center as far as it can without showing past the picture's edge. It writes `scale`, `x` and `y` keys on the clip (the three " +
      "move together, ease in-out), replacing the clip's own keys of those three (a warning says so), and starts from its static " +
      "placement. `scale` is the zoom factor over that placement (default 1.8). One transaction labelled `Zoom <file name>` (yours " +
      "when one is open): `revert` undoes it, the keys stay editable in the inspector or with `clip.key`, and in review mode it is " +
      "one proposal. Only the pointer's position is recorded, not its clicks. A clip whose pointer never rests is left as it was, " +
      "with a warning. A Shoot `screen` shot (or a `solo` shot of a screen angle) of a multicam group is zoomed too: its screen " +
      "file is placed over the shot as a muted media clip on a new video track `Screen zoom` right above the program track, in the " +
      "same transaction, and that clip is zoomed (`clip` in the result is its id). Example: `{ clip: \"c_0007\", follow: \"pointer\" }`. " +
      "Fails with InvalidOperation (not a media clip on a video track nor a screen shot, a shot of another layout, a still picture, no pointer track (record the screen in Shoot, or pass `pointer`), an unreadable track), " +
      "ClipNotFound, TimelineNotFound.",
    params: z.strictObject({
      cwd: CwdParam,
      timeline: TimelineIdSchema,
      clip: z.string().min(1).describe("Id of a media clip on a video track, or of a Shoot `screen` shot, from `timeline.show`: a screen recording."),
      follow: z.literal("pointer").describe("What the zoom follows: the recorded mouse pointer (the only kind so far)."),
      scale: z.number().min(1.1).max(4).optional().describe("Zoom factor over the clip's own scale, 1.1 to 4. Default 1.8."),
      pointer: z
        .string()
        .min(1)
        .optional()
        .describe("Pointer track to read, relative to `cwd` or absolute, inside the project. Default: the one next to the clip's file."),
    }),
    result: ClipZoomResultSchema,
  },
  "segment.prepare": {
    description:
      "Get a still image ready to be pointed into (ADR 0022, photo segmentation): encodes it once with MobileSAM and keeps the " +
      "result in memory by content hash (the last 8 photos), so the first click costs about 0.2 s instead of 3 s. Called by the " +
      "app when Pick turns on in an image project; `inspect.point` prepares on demand, so agents never call it. The first run " +
      "downloads the model (two files, about 45 MB) and ONNX Runtime Web (33 MB, if face detection never ran). " +
      "Fails with AssetNotFound, OutsideProject, InvalidOperation (not an image project, not a still image), or the Binary* errors.",
    internal: true,
    params: z.strictObject({
      cwd: CwdParam,
      asset: z.string().min(1).describe("Still image, absolute or relative to `cwd`."),
    }),
    result: z.object({
      asset: z.string().describe("Project-relative asset path."),
      size: z.object({ width: z.int(), height: z.int() }).describe("The image's pixels, rotation applied."),
      hash: z.string().describe("`sha256:<hex>` of the asset's content, the key of the cached embedding."),
      model: z.string().describe("Pinned model, `mobilesam@<revision>`."),
      cached: z.boolean().describe("True when the image was prepared already."),
    }),
  },
  "matte.prepare": {
    description:
      "Compute the subject matte of a video asset (ADR 0032): which pixels of each frame are the person in front, so text " +
      "or graphics can later sit behind them. Locally on CPU: MediaPipe's selfie segmenter (Apache-2.0; the first run " +
      "downloads 0.5 MB, plus ONNX Runtime Web, 33 MB, if face detection never ran) on every frame of the asset's proxy, " +
      "smoothed over time and snapped to the picture's colour edges. The whole asset is matted once per content: the result is a " +
      "grayscale video at proxy size (white = subject, black = background, same frames as the proxy) cached in " +
      "`.frameshell/cache/mattes/` (regenerable, swept by `gc`); a later call returns it at once (`cached: true`). A source " +
      "with a short side above 1080 px (1440p, 4K) also gets a matte refined on its own frames at its own size (short side " +
      "at most 2160), which export uses (`full`). " +
      "Waits for the asset's ingest when its proxy is not built yet. Takes an estimated 2 minutes per minute of 30 fps video, " +
      "about 11 more for a 4K source's full-size matte, on an Apple M3 (`progress` notifications carry an ETA). It runs as a background job of kind `matte` (`job.list`), so " +
      "it goes on if the caller disconnects. Known limits: one merged matte for two or more people; thin hair strands " +
      "and mic stands are often left out. Export and frame captures use it for tracks `behind` a plate (`track.set`) and make " +
      "it when missing; calling this first lets them start at once. " +
      "Example: `{ asset: \"assets/interview.mp4\" }`. Fails with AssetNotFound, OutsideProject, InvalidOperation " +
      "(reason `not a video`: audio or a still picture; `image project`; `ingest failed`), or the Binary* errors when ffmpeg, " +
      "ONNX Runtime or the model cannot be fetched.",
    params: z.strictObject({
      cwd: CwdParam,
      asset: z.string().min(1).describe("Video asset, absolute or relative to `cwd`, e.g. `assets/interview.mp4`."),
    }),
    result: z.object({
      asset: z.string().describe("Project-relative asset path."),
      hash: z.string().describe("`sha256:<hex>` of the asset's content, part of the cache key."),
      model: z.string().describe("Model that made it: `mediapipe-selfie@<revision>`, or `stand-in` in tests."),
      matte: z
        .string()
        .describe(
          "Project-relative matte video, `.frameshell/cache/mattes/<key>.mp4`: H.264, luma = matte (full range, 0 " +
            "background to 255 subject, chroma neutral), frame N = proxy frame N.",
        ),
      size: z.object({ width: z.int(), height: z.int() }).describe("Matte pixels: the proxy's size (short side at most 540)."),
      fps: z.number().describe("Frames per second: the project fps, as the proxy."),
      frames: z.int().describe("Frames in the matte."),
      full: z
        .object({
          matte: z.string().describe("Project-relative matte video, `.frameshell/cache/mattes/<key>.full.mp4`, encoded as `matte`."),
          size: z.object({ width: z.int(), height: z.int() }).describe("Matte pixels: the source's size, short side at most 2160."),
        })
        .nullable()
        .describe("Full-size matte export uses, frame N = proxy frame N; null for a source with a short side of 1080 px or less."),
      cached: z.boolean().describe("True when the mattes of this content existed already and nothing was computed."),
      seconds: z.number().describe("Seconds it took to compute (when it was computed, for a cached one)."),
    }),
  },
  "beats.measure": {
    mutating: true,
    description:
      "Measure the beat grid of a music asset (ADR 0029) and write `beats/<asset minus extension>.beats.json` " +
      "(`beats/<asset>.beats.json`, extension kept, when another asset with the same base name owns the first name): the " +
      "tempo, every beat in source-asset seconds, which beat starts a bar, the strong hits (onsets), a confidence and the " +
      "largest gap between the straight grid and a hit it matched (`residualMs`, under 15 on a clean track). Locally, no " +
      "download: an onset envelope (spectral flux) of the asset's PCM sidecar, a tempo from its autocorrelation, one straight " +
      "period fitted through the hits, each beat snapped to a hit within 8 ms, the bar start taken from the low band. " +
      "The grid stands where there is rhythm (from the first matched hit to the last). Calm or sparse music gets a double-time " +
      "grid: that shows as `low: true` (confidence under 0.5); `alternatives` then lists the other tempi, best supported first, and " +
      "you or the person pick one with `edits.tempo` (`double` or `half`) in the file; a low grid is never snapped to. " +
      "Pass `bpm` when you know the tempo: the grid is the octave nearest to it (a 60 BPM song stays 60, not 120). " +
      "Audio comes from the asset's PCM sidecar; without a finished ingest the asset is decoded at 16 kHz and the result is " +
      "capped at low confidence. Human `edits` (tempo, downbeat, offset; see `beats.show`) are kept across a new " +
      "measure unless `resetEdits` or the asset content changed since. Runs as a background job of kind `beats` (`job.list`) in a worker thread; the onset " +
      "envelope is cached by content in `.frameshell/beats/` (swept by `gc`), so measuring again with another `bpm` takes " +
      "about a second; a 3-minute track takes about 5 seconds the first time. Not for speech or long recordings: tracks over 10 " +
      "minutes are refused. Example: `{ asset: \"assets/music/theme.mp3\", bpm: 120 }`. Fails with AssetNotFound, " +
      "OutsideProject, InvalidOperation (reason `no audio`, `too long`, `no beats`: silence or no rhythm, or `name taken`), " +
      "InvalidProjectFile (the existing beats file is broken: fix or delete it), or the Binary* errors when ffmpeg cannot be fetched.",
    params: z.strictObject({
      cwd: CwdParam,
      asset: z.string().min(1).describe("Music file inside the project, absolute or relative to `cwd`, e.g. `assets/music/theme.mp3`."),
      bpm: z.number().min(20).max(400).optional().describe("Tempo you expect, in BPM; the measured tempo is moved by octaves toward it. Default: the detector's choice, 70-170 BPM."),
      resetEdits: z.boolean().default(false).describe("Drop the human `edits` of the previous file instead of keeping them. Default false."),
    }),
    result: BeatsSummarySchema.extend({
      cached: z.boolean().describe("True when the cached onset envelope was reused and only the grid was worked out again."),
      keptEdits: z.boolean().describe("True when human `edits` of the previous file were carried over (they are dropped when the asset content changed since)."),
      seconds: z.number().describe("Seconds it took."),
    }),
  },
  "beats.show": {
    description:
      "The beat grid of a music asset (ADR 0029): what `beats.measure` wrote to `beats/<asset>.beats.json`, with the human " +
      "`edits` applied, in source-asset seconds. `beats` are the beat times, `downbeats` the ones that start a bar; the `edits` " +
      "(`tempo`: `double` or `half`, `downbeat`: index of the first bar start, `offset`: seconds) are in the file, which you " +
      "change with `file.write` (the content is validated). `low` means the grid may be double time or a bar off: look at " +
      "`alternatives`, tell the person, and do not cut to it without their say. `current: false` means the asset changed " +
      "since: measure again. Pure read; no audio is analysed. Example: `{ asset: \"assets/music/theme.mp3\" }`. " +
      "Fails with AssetNotFound, OutsideProject, InvalidOperation (reason `not measured`: run `beats.measure`), InvalidProjectFile.",
    params: z.strictObject({
      cwd: CwdParam,
      asset: z.string().min(1).describe("Music file inside the project, absolute or relative to `cwd`."),
    }),
    result: BeatsSummarySchema.extend({
      current: z.boolean().describe("True when the asset's content is the one that was measured."),
      edits: BeatsEditsSchema.describe("Human corrections in the file; empty when none."),
      beats: z.array(z.number()).describe("Beat times in source-asset seconds, `edits` applied, increasing."),
      downbeats: z.array(z.number()).describe("The beats that start a bar, source-asset seconds."),
    }),
  },
  "image.cutout": {
    mutating: true,
    description:
      "Cut a part out of a photo as a new layer (ADR 0022). `clip` is a still media clip of an image project; `mask` is a " +
      "project-relative 8-bit grayscale PNG at the photo's own pixel size, white (255) where the part is: the `mask` of a point's " +
      "`segment.masks` from `inspect.point`, or one you made. The photo with the mask as its transparency, cropped to the mask's " +
      "box, is written as a new file `assets/<photo name>-cutout-<n>.png` (the photo itself is never changed) and placed on a new " +
      "video track right above the photo's: same start, length and opacity, position and scale set so the part covers its own " +
      "pixels of the photo. One transaction labelled `Cut out <photo name>` (yours when one is open): reverting removes the " +
      "layer; the PNG stays in `assets/`. Background removal is this followed by `clip.set` `opacity: 0` on the photo (or " +
      "`clip.remove`). Keyframes and fades of the photo are not copied (a warning says so). " +
      "Example: `{ clip: \"c_0003\", mask: \".frameshell/context/m_0_1210_1530_3.png\" }`. Fails with InvalidOperation (video " +
      "project, not a still media clip, mask not a grayscale PNG of the photo's size, empty mask), ClipNotFound, AssetNotFound, " +
      "OutsideProject, or the Binary* errors.",
    params: z.strictObject({
      cwd: CwdParam,
      timeline: TimelineIdSchema,
      clip: z.string().min(1).describe("Id of the photo's clip, from `timeline.show`."),
      mask: z.string().min(1).describe("Grayscale PNG at the photo's size, project-relative or absolute inside the project; white = keep."),
    }),
    result: OperationResultSchema.extend({
      asset: z.string().describe("Project-relative path of the new PNG with transparency."),
      track: z.string().describe("Id of the new track, right above the photo's."),
      clip: z.string().describe("Id of the new clip on it."),
    }),
  },
  "multicam.paint": {
    mutating: true,
    description:
      "Correct who speaks in a multicam group by hand (ADR 0016 decision 3: a manual correction always overrides the measured " +
      "turns). Marks a range of the group clock as spoken (`speaking: true`) or silent (`speaking: false`) for one angle, or takes " +
      "it back to the measured turns (`speaking: null`; with `angle` left out, for every angle). The marks live in the group " +
      "(`painted`) and replace the angle's measured turns inside their range, for `multicam.turns` and `multicam.direct`, so " +
      "re-directing keeps them; undo reverts them like any operation. `alone: true` with `speaking: true` also marks every other " +
      "angle that can speak as silent in the range: the person takes the floor. A mark overlapping an earlier one of the " +
      "angle replaces it where they overlap; touching marks of the same kind merge. Screen angles are never speakers, so they " +
      "cannot be marked as speaking. Example: `{ group: \"g_1a2b3c\", angle: \"ana\", start: 12, end: 15.5, speaking: true, alone: true }`. " +
      "Fails with InvalidOperation when the group or angle does not exist, `end` is not after `start`, `angle` is missing with " +
      "`speaking` set, `alone` is used without `speaking: true`, or a screen angle is marked as speaking.",
    params: operationArgs["multicam.paint"].extend({ cwd: CwdParam, timeline: TimelineIdSchema }),
    result: OperationResultSchema,
  },
  "shot.set": {
    mutating: true,
    description:
      "Change a shot of a program track (ADR 0016): its layout `shot` (`solo` 1 angle, `two-up` 2, `grid` 2 or more, `screen` 1 " +
      "angle whole with bars, never cropped, `pip` 2: the screen first, then a speaker as an inset in `corner`) and/or the " +
      "`angles` it shows, in layout order. Only `shot`: the angles are kept, cut to the layout's count, or filled with the group's " +
      "next angles in group order (`screen` and `pip` put angles marked `screen` first). Only `angles`: the layout stays when it " +
      "takes that many, else it follows the count (1 `solo`, 2 `two-up`, more `grid`). Both: they must fit. `corner` " +
      "(`top-left`, `top-right`, `bottom-left`, `bottom-right`; default `bottom-right`) only fits a `pip` shot. " +
      "The shot becomes one a person chose: `confidence` and `reason` are removed. " +
      "Timing does not change: split the shot first (`clip.split`) to change only part of it. Examples: " +
      "`{ clip: \"c_0301\", shot: \"solo\", angles: [\"ana\"] }`, `{ clip: \"c_0301\", shot: \"pip\", angles: [\"screen\", \"ana\"], corner: \"top-right\" }`. " +
      "Fails with InvalidOperation (not a shot, unknown or repeated angle, angle without a picture, wrong count for the layout).",
    params: operationArgs["shot.set"].extend({ cwd: CwdParam, timeline: TimelineIdSchema }),
    result: OperationResultSchema,
  },
  "multicam.turns": {
    description:
      "Who speaks when in a multicam group (ADR 0016): the speaking turns of every angle, from the energy of the angle's sound " +
      "(its `mic` of the group's `mics`, with the mic's offset and gain, else its own file; the cached envelopes cut snapping uses), " +
      "on the group clock (each angle's `offset` applied). Example: " +
      "`{ group: \"g_1a2b3c\" }` gives `turns: [{ angle: \"ana\", name: \"Ana\", start: 0.4, end: 5.2 }, …]` sorted by `start`. " +
      "A voice heard in another person's mic (bleed, more than 12 dB below the loudest mic at that time) does not count as " +
      "that person's turn; people talking at once keep overlapping turns. Pauses under 0.5 s stay inside a turn, sounds under " +
      "0.3 s are not turns. Read-only. Each angle's `audio.gain` (dB) is added to its mic level before mics are compared. An angle without sound has no turns and a " +
      "warning (`mic: null`: no warning); screen angles are never speakers. Shared sound: angles that hear the same file, angles that hear the same mic once its transcript has speakers (else they " +
      "speak together: two cameras of one person), and angles with a `speaker`, take their turns from the " +
      "words of that speaker in that sound's transcript (`transcribe.speakers` first; corrections in `edits` count); an angle " +
      "of a shared sound with no `speaker` takes the first speaker no other angle names, in order, and a warning says so " +
      "(set it with `multicam.angle`). `speakers` lists the angles measured that way. Stretches a person painted " +
      "(`multicam.paint`, `painted` in the group) replace the measured turns of their angle inside their range. Fails with InvalidOperation (group does not exist; data lists the groups), TimelineNotFound, AssetNotFound, " +
      "or the Binary* errors when ffmpeg cannot be fetched.",
    params: z.strictObject({
      cwd: CwdParam,
      timeline: TimelineIdSchema,
      group: z.string().min(1).describe("Group id (`g_…`) from `timeline.show` `groups` or `multicam.create`."),
    }),
    result: MulticamTurnsResultSchema,
  },
  "multicam.direct": {
    mutating: true,
    description:
      "Direct a multicam group (ADR 0016): turn its speaking turns (`multicam.turns`, measured here) into shots on its program " +
      "track by rules, in one operation. Deterministic: the same turns and rules give the same shots. Rules: the `template` " +
      "(`interview` default, `podcast-calm`, `panel-dynamic`) with `director.json` in the project (or `rules`) on top: shortest " +
      "and longest solo, two-up on quick exchanges and on two people talking at once, wide (`grid`) on silence and laughter, cut " +
      "lead (the voice leads the cut, J-cut), weight per angle. Angles marked `screen` (`multicam.angle`) are measured for motion " +
      "(the picture changing): a stretch of motion becomes a `screen` shot while nobody speaks and a `pip` (screen with the " +
      "speaker as an inset) while someone does; screens never speak. The program track keeps what plays where: each shot in range is " +
      "replaced by directed shots over the same group time, gaps stay gaps; an empty track is filled over the whole group. " +
      "Shots a person chose in the app (`shot.set` by author `ui`, and pieces cut out of them) are kept unless " +
      "`replaceHuman: true`; `kept` lists those in the range. Every shot gets " +
      "`confidence` and `reason`; `low` lists those below 0.5 to review (e.g. a reaction worth holding), then fix them with " +
      "`shot.set`. `operation.args.turns` is the number of turns used (the journal keeps them all). " +
      "Example: `{ group: \"g_1a2b3c\", template: \"podcast-calm\", from: 60, to: 120 }`. Fails with " +
      "InvalidOperation (group or program track missing, invalid rules file, nothing to direct in the range: data says why), " +
      "TimelineNotFound, AssetNotFound, or the Binary* errors when ffmpeg cannot be fetched.",
    params: z.strictObject({
      cwd: CwdParam,
      timeline: TimelineIdSchema,
      group: z.string().min(1).describe("Group id (`g_…`) from `timeline.show` `groups` or `multicam.create`."),
      template: z
        .enum(DIRECTOR_TEMPLATE_IDS)
        .optional()
        .describe("Rule set to start from; replaces the rules file's `template`. Default: the file's, else `interview`."),
      rules: z
        .string()
        .min(1)
        .optional()
        .describe("Rules file inside the project, absolute or relative to `cwd`. Default `director.json` at the project root, when it exists."),
      from: TimeRef("Timeline time where directing starts. Default 0.").optional(),
      to: TimeRef("Timeline time where it ends. Default: the end of the program track.").optional(),
      replaceHuman: z.boolean().optional().describe("Also replace shots a person chose in the app. Default false."),
    }),
    result: MulticamDirectResultSchema,
  },
  "captions.set": {
    mutating: true,
    description:
      "Write hand-chunked captions with chosen keywords on a subtitle track. `text` (or a project file, `file`) holds one phrase per " +
      "line: chunks (one cue each) separated by `|`, the phrase's ONE emphasised word between asterisks, e.g. " +
      "`No need to | open any | *editor*`; an optional `[chars]`, `[words]`, `[line]` or `[none]` at the start of a line sets that " +
      "phrase's entry; blank lines and `#` lines are skipped. The text covers every word the track shows between `from` and `to` " +
      "(timeline times, default the whole track), in order: the words are matched by position, so a text that loses or repeats a " +
      "word fails (the error names the first difference); typed words that differ from the transcript after case, accents and " +
      "punctuation only warn. Mapped onto transcript word ids, so cuts and transcript corrections keep the phrases (a word a cut " +
      "removed just leaves its chunk). Words no phrase holds keep the style's automatic grouping. A chunk lasts until the next cue " +
      "starts, at most 0.35 s past its last word and never under 0.4 s. The keyword takes the style's `keywordColor` " +
      "(`track.set` `style`; default the preset's accent) and, with an `entry`, settles from `keywordScale`. Phrases that share a " +
      "word with the new ones are replaced; `replace: true` drops all the track's other phrases first, and with no text clears them. " +
      "`cues` lists what the range shows now. Example: `{ track: \"t_4d5e6f\", text: \"No need to | open any | *editor*\", from: 12, to: 15 }`. " +
      "Fails with TrackNotFound or InvalidOperation (not a subtitle track, no text, a second keyword in a phrase, an empty chunk, a " +
      "phrase across two assets, word counts that differ).",
    params: z.strictObject({
      cwd: CwdParam,
      timeline: TimelineIdSchema,
      track: z.string().min(1).describe("Subtitle track id from `track.list`, e.g. `t_4d5e6f`."),
      text: z.string().optional().describe("The captions, one phrase per line. Give this or `file`; neither with `replace: true` clears the phrases."),
      file: z.string().min(1).optional().describe("Text file inside the project with the same format, absolute or relative to `cwd`."),
      from: TimeRef("Timeline time where the captioned range starts: words from this frame on. Default 0.").optional(),
      to: TimeRef("Timeline time where it ends: words that start before this frame. Default: the end of the track's words.").optional(),
      replace: z.boolean().optional().describe("Also drop every other phrase of the track. Default false."),
    }),
    result: CaptionsSetResultSchema,
  },
} as const satisfies Record<string, MethodSpec>;
