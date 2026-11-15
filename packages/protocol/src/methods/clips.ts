import { z } from "zod";
import { ViewedShape } from "../proposals.js";
import { TempoSchema } from "@frameshell/schema";
import {
  MarkerListResultSchema,
  OperationResultSchema,
  TimelineIdSchema,
  TempoGridSchema,
  TrackDuckResultSchema,
  operationArgs,
} from "../timeline.js";
import { type MethodSpec, CwdParam, ViewParam } from "./shared.js";

/** Daemon methods: clip edits, transitions, keys, ducking, markers, tempo and letterbox. */
export const clipMethods = {
  "clip.move": {
    mutating: true,
    description:
      "Move a clip to a new timeline `start` and/or another track of the same kind, keeping its content and length. " +
      "Example: `{ clip: \"c_1a2b3c\", start: 12.5 }`. Refused when it would overlap another clip.",
    params: operationArgs["clip.move"].extend({ cwd: CwdParam, timeline: TimelineIdSchema }),
    result: OperationResultSchema,
  },
  "clip.trim": {
    mutating: true,
    description:
      "Trim or extend a clip's head and/or tail. By source time: `{ clip, in: 4.0 }` drops source before 4.0 s, the kept " +
      "frames stay where they were on the timeline (start moves right). By timeline time: `{ clip, end: 20.0 }`. Does not " +
      "ripple: use `cut` to close gaps. Media clips with audio: each edge snaps into the nearest audio pause within " +
      "±`snapWindow` (default: project `editing.snapWindow`, else 0.5 s); `snaps` reports requested vs applied and `clean: false` when no pause was in " +
      "reach. `snap: false` trims exactly. `ripple: true` keeps the left edge and moves later clips on every video and " +
      "audio track (or only `rippleTracks`) by the change in length: extend a clip over removed material with `{ clip, out: 18.4, ripple: true }` " +
      "(the inverse of `cut`). Fails with InvalidOperation giving the valid range.",
    params: operationArgs["clip.trim"].extend({ cwd: CwdParam, timeline: TimelineIdSchema }),
    result: OperationResultSchema,
  },
  "clip.split": {
    mutating: true,
    description:
      "Split a clip in two at timeline time `at`. The left part keeps the id; the right part's new id is in " +
      "`changes.added`. The left part keeps the clip's dissolve and fade in, the right part its fade out, the new cut has none; both keep every keyframe. Example: `{ clip: \"c_1a2b3c\", at: 7.5 }`.",
    params: operationArgs["clip.split"].extend({ cwd: CwdParam, timeline: TimelineIdSchema }),
    result: OperationResultSchema,
  },
  "clip.remove": {
    mutating: true,
    description: "Remove a clip, leaving a gap. To remove a time range and close the gap on every track, use `cut`.",
    params: operationArgs["clip.remove"].extend({ cwd: CwdParam, timeline: TimelineIdSchema }),
    result: OperationResultSchema,
  },
  "clip.set": {
    mutating: true,
    description:
      "Change clip properties: `speed` (media; end moves), `gain` (dB), `muted`, `audioFadeInMs`/`audioFadeOutMs` (media; sample-accurate " +
      "equal-power sound ramps at the clip's edges in ms, e.g. 12 to de-click a cut, 0 removes; a split drops them at the new cut), " +
      "`audioEffects` (media; replaces the effect list, " +
      "`null` clears; see below), `backdrop` (generated clips; see below), `transform` (merged field by field), " +
      "`props` (adapter clips; replaced), `elements` (adapter clips whose plugin supports it: move or scale an element inside a generated " +
      "clip by CSS selector, e.g. `{ \"#title\": { y: -40, scale: 1.2 } }`; merged per selector, `null` for a selector removes it, `null` for " +
      "the field clears all; the composition file stays untouched), `scriptRef` (script scene `ref` from `script.outline`, or the script path " +
      "alone for the whole script; null clears). A `scriptRef` whose script or scene does not exist is still stored, with a `warnings` entry naming the scenes " +
      "there are; a `scriptRef` path that is absolute or uses `..` fails with InvalidOperation. " +
      "`audioEffects` (ADR 0031) process the clip's sound in order before gain and fades: the voice chain is " +
      "`[{ kind: \"highpass\", frequency: 85 }, { kind: \"denoise\", floor: -30, reduction: 8 }, { kind: \"compressor\", threshold: -20, ratio: 2.5, " +
      "attack: 8, release: 140, makeup: 2 }]`. The asset is baked once per chain in the background; export waits for it, the preview plays " +
      "dry until it is ready. Energy snapping and transcription keep the dry sound. Integrated loudness stays the export's (`export.loudness`). " +
      "`backdrop` (ADR 0031) makes a generated clip glass: export and preview blur (`blur`, Gaussian sigma in project px), saturate " +
      "(`saturate`, 1 unchanged) and dim (`dim`, 0 to 1) the picture below the clip wherever the clip's alpha shows, then draw the clip; " +
      "its render does not change. Merged field by field, `null` clears. Glass is a style choice, never a default: use it when the " +
      "style's `glass.cards` is true, with the style's `glass` numbers (`style_show`), else only when asked. On the bottom video track " +
      "nothing is below: stored with a warning, not drawn. " +
      "`motionBlur` (ADR 0041, generated clips) renders each frame as the average of `samples` (default 8) pictures across a shutter of " +
      "`shutter` degrees (default 180, centred on the frame), averaged in `blend` space (default `linear`): fast moves smear like a camera's. " +
      "`{}` turns it on with the defaults, merged field by field, `null` clears. The clip keeps two renders: the sharp one first (live " +
      "preview, `render` with `quality: \"draft\"`), then the blurred one in the background, about `samples` times as long " +
      "(`clip.renders` `final`); the preview swaps it in when ready, and `render` with `quality: \"final\"` or none, and `frame`, " +
      "wait for it. When the plugin refuses to blur the composition (HDR content, shader transitions) they use the sharp render, " +
      "with a warning on the render job. Use it on fast motion graphics, not on text that should read sharp while it " +
      "moves. A composition that cuts between scenes inside itself declares the cut with the motion runtime's `cuts()`, else the frame " +
      "at the cut blends both scenes. " +
      "`format` (ADR 0027, a format of `format.list` other than the primary) sets the clip in that format only, stored in its " +
      "`formats` override: `transform`, `props` (checked over the clip's own), `elements` and `hidden` (no picture there, the sound " +
      "still plays); `reset: true` drops the override first. Use it where the automatic layout of a format is wrong, e.g. a lower " +
      "third that sits too low in 9:16: `{ clip, format: \"9x16\", transform: { y: 520 } }`. Timing and sound are every format's: " +
      "with `format`, speed, gain, muted, audio fades, audioEffects, backdrop, motionBlur and scriptRef are refused. Check it with `frame` and `projectFormat`. " +
      "Example: `{ clip: \"c_1a2b3c\", gain: -6 }`.",
    params: operationArgs["clip.set"].extend({ cwd: CwdParam, timeline: TimelineIdSchema }),
    result: OperationResultSchema,
  },
  "transition.set": {
    mutating: true,
    description:
      "Put a transition on a clip edge (ADR 0018, ADR 0030). Only `at` is needed: `{ at: 12.5 }` dissolves into the clip starting at " +
      "12.5 s on every video and audio track that has an edge there (sound crossfades), 0.5 s long. `kind: \"fade\"` dips through black " +
      "instead (transparent on upper tracks, silence for sound). `kind: \"wipe\"` (a straight edge uncovers the incoming clip) and " +
      "`kind: \"push\"` (the incoming clip slides in and pushes the outgoing one out) move the picture instead of mixing it; `direction` " +
      "`left` (default), `right`, `up` or `down` is the way the incoming picture travels: `{ at: 12.5, kind: \"push\", direction: \"up\" }`. " +
      "`kind: \"iris\"` opens the incoming clip in a circle growing from the centre of `origin`, `[x0, y0, x1, y1]` in fractions of the " +
      "frame (the element that just lit up, from `inspect.point`; default the frame's centre): `{ at: 12.5, kind: \"iris\", origin: [0.6, 0.2, 0.8, 0.4] }`. " +
      "`kind: \"zoom\"` dives the outgoing clip into the centre of `origin` (up to 4 times larger, by the size of `origin`: its larger side " +
      "fills the frame; default the middle half) while the incoming clip grows out of that point, so use it where the eye is on one element " +
      "and the next shot is about it. `kind: \"slats\"` uncovers the incoming clip in `count` strips at once (default 8, 2 to 64), each the " +
      "`direction` way, on a rhythm beat. `kind: \"grid\"` shows it in square cells switching on in a scattered order, `count` across " +
      "(default 12), to end a section on a grid image. " +
      "They play on every video track with an edge there, like a dissolve: on an upper track the outgoing clip shows only where the " +
      "incoming one does not (the shape cuts both, keeping a render's own alpha), so a title can wipe or push off over the picture below. " +
      "At an edge of a nested timeline clip the shape plays on its clips too, its upper tracks included. Audio tracks crossfade. " +
      "`kind: \"dip-cut\"` makes the edge a hard cut on the bottom " +
      "video track and darkens the clip ending there by 40 % over its last 3 frames, as `opacity` keys on it (`duration` is ignored; " +
      "sound and other tracks are not touched; another video track named in `tracks` is refused); `transition.remove` there takes the " +
      "dip keys away again. Pick the kind by why the picture changes (see the skill's transitions reference); " +
      "a `warnings` entry flags three transitions of one kind in a row, or more than a third hard cuts, on the bottom track. " +
      "`duration` is the total seconds; `tracks` limits it. The clips stay where they are and the timeline length never changes: a " +
      "transition is centered on the cut and borrows source from before the incoming clip's `in` and after the outgoing clip's `out`. " +
      "An edge with no clip butted to it (a clip's start or end) fades in or out for any kind: `{ at: 58, kind: \"fade\", duration: 1 }` " +
      "fades the last clip out. Replaces any transition already on that edge. Multicam program tracks are skipped with a warning (hard " +
      "cuts). Short material never fails: it shortens the transition, or plays a dissolve with no spare source as a dip, and a `warnings` " +
      "entry says so; a shape with no spare source holds the outgoing clip's last frame or the incoming clip's first instead. " +
      "Fails with InvalidOperation when no targeted track has a clip edge at `at` (the message lists the edges), `direction` comes " +
      "with another kind than `wipe`, `push` or `slats`, `origin` with another kind than `iris` or `zoom`, `count` with another kind than " +
      "`slats` or `grid`, or a dip cut finds no clip ending at `at` on " +
      "the bottom video track; TrackNotFound.",
    params: operationArgs["transition.set"].extend({ cwd: CwdParam, timeline: TimelineIdSchema }),
    result: OperationResultSchema,
  },
  "transition.remove": {
    mutating: true,
    description:
      "Clear the transition on the clip edge at `at` (dissolve and its shape, fade in, fade out, a dip cut's keys on the clip ending " +
      "there) on every video and audio track that has one, or only `tracks`. Example: `{ at: 12.5 }`. The clips stay where they are. Fails with InvalidOperation when no targeted track has a " +
      "clip edge at `at`; an edge without a transition adds a warning.",
    params: operationArgs["transition.remove"].extend({ cwd: CwdParam, timeline: TimelineIdSchema }),
    result: OperationResultSchema,
  },
  "clip.key": {
    mutating: true,
    description:
      "Animate a clip property over time with keyframes (ADR 0018). `prop`: `x`, `y` (project pixels), `scale`, `opacity` (0 to 1) or " +
      "`gain` (dB; the only one audio tracks take). `time` is timeline seconds inside the clip, snapped to the frame; the key is added " +
      "or replaced there, `value` defaults to what plays there now. Between keys the value moves linearly or by the leaving key's " +
      "`ease` (`in`, `out`, `in-out`); before the first key and after the last it holds. A keyed property ignores its static " +
      "value (`clip.set`). `remove: true` deletes the key at `time`; `clear: true` deletes every key of `prop`. Keys stay on the same " +
      "frames of the clip's picture through trim, split and cut. Example, a slow zoom over a clip at 10 to 20 s: " +
      "`{ clip, prop: \"scale\", time: 10, value: 1 }` then `{ clip, prop: \"scale\", time: 20, value: 1.2 }`. " +
      "`format` (ADR 0027) keys `x`, `y`, `scale` or `opacity` in that format only (its first key there starts from the clip's own " +
      "keys of `prop`); `clear` with `format` drops that format's keys of `prop`, so it follows the clip's own keys there " +
      "again (unless that format's `transform` sets `prop`). Fails with " +
      "InvalidOperation (time outside the clip, no key to remove, audio track with a picture property, shots, `gain` with `format`, the primary format) or FormatNotFound.",
    params: operationArgs["clip.key"].extend({ cwd: CwdParam, timeline: TimelineIdSchema }),
    result: OperationResultSchema,
  },
  "track.duck": {
    mutating: true,
    description:
      "Duck music under speech: write gain keys (ADR 0018, `clip.key` `gain`) on the clips of the audio track `track` so they dip " +
      "while someone speaks on the `under` tracks. Speech is found from the energy of the `under` tracks' sound (muted clips and " +
      "tracks are ignored): a stretch is where it stays above `threshold`, stretches closer than `gap` merge. Each stretch " +
      "gets a dip of `depth` dB that is complete when the voice starts (`attackMs` before) and lets go `releaseMs` after it ends, " +
      "straight lines in between. The keys are the clip's level (its `audio.gain`, or its own keys) minus the dip, with a key at the " +
      "clip's start and end so the lane never holds a dip by accident. They are marked `auto: \"duck\"`: running it again replaces " +
      "those and keeps the keys you set by hand; clips with no speech over them lose their old ones. The person sees and edits the " +
      "curve in the clip; preview and export play it like any gain key. One operation, one revert. Voice in nested timeline clips " +
      "is not heard (a warning says so), nor are multicam angles and mics: a program track in `under` is refused. A voice file " +
      "that cannot be decoded is named in the warnings. A hand key where someone speaks is dipped too and its level comes back on the next run. " +
      "`level` first sets each clip's static gain (`audio.gain`) so the music's integrated loudness (EBU R128, measured once per file and cached) " +
      "sits `level` dB under the voice's: the voice is every clip of the `under` tracks, its file's loudness plus its gain, averaged by the time it plays " +
      "(about 12 dB under is a start; the style's `sound.musicUnderVoice`); a clip with gain keys of its own is left alone and named in the warnings. " +
      "The depth, attack, release, threshold, gap and `level` are kept in `audio.duck` of each clip that gets duck keys, so `music.fit` runs the same duck again after it moves one. " +
      "Example: `{ track: \"t_music\", under: [\"t_voice\"], depth: 8, level: 12 }`. Fails with InvalidOperation (`track` is not an audio " +
      "track, `under` names it or a program track), TrackNotFound, or the Binary* errors when ffmpeg cannot be fetched.",
    params: z.strictObject({
      cwd: CwdParam,
      timeline: TimelineIdSchema,
      track: operationArgs["track.duck"].shape.track,
      under: z.array(z.string().min(1).describe("Track id from `track.list`.")).min(1).describe("Video or audio tracks whose speech the music ducks under."),
      depth: z.number().positive().max(60).default(7).describe("dB the clips dip below their level while someone speaks. Default 7."),
      attackMs: z.number().min(1).max(5000).default(40).describe("Milliseconds the dip takes to reach full depth, ending as the voice starts. Default 40."),
      releaseMs: z.number().min(1).max(10000).default(450).describe("Milliseconds the level takes to come back after the voice stops. Default 450."),
      threshold: z.number().min(-90).max(0).default(-38).describe("dBFS above which sound counts as speech. Default -38."),
      gap: z.number().min(0).max(30).default(0.6).describe("Seconds: speech stretches closer than this merge, so the music does not pump between words. Default 0.6."),
      level: z
        .number()
        .min(0)
        .max(40)
        .optional()
        .describe("dB the music's integrated loudness sits under the voice's: sets the static gain of each clip of `track` first. Default: the gains stay as they are."),
    }),
    result: TrackDuckResultSchema,
  },
  cut: {
    mutating: true,
    description:
      "Remove the timeline range [from, to) and close the gap (ripple): clips inside are removed, clips crossing an edge " +
      "are trimmed or split, later clips move left by `to - from`. Applies to every video, audio and program track unless " +
      "`tracks` is given (cutting only some tracks shifts them against the rest). Example: `{ from: 12.4, to: 13.1 }` " +
      "removes a 0.7 s silence. Where media clips with audio (or a program track's angles) lie under an edge, it snaps into the nearest audio pause " +
      "within ±`snapWindow` (default: project `editing.snapWindow`, else 0.5 s) so no word is clipped; `snaps` reports requested vs applied and " +
      "`clean: false` when no pause was in reach (speech may be clipped there). `snap: false` cuts exactly. " +
      "A cut that trims or splits an adapter clip (e.g. `hyperframes`) adds a `warnings` entry naming its id, type and `scriptRef`: edit audio before building visuals.",
    params: operationArgs.cut.extend({ cwd: CwdParam, timeline: TimelineIdSchema }),
    result: OperationResultSchema,
  },
  "marker.list": {
    description:
      "List a timeline's markers (ADR 0029): named points on the timeline clock, each with id (`m_…`), timeline second `at`, " +
      "label and optional colour, sorted by `at`. Markers paint nothing and play nothing; they name moments (a hook, a beat to land on) " +
      "for the person and the agent. `timeline.show` lists them too. In review mode, `view` picks the file or the open proposal's version. " +
      "Fails with TimelineNotFound or InvalidProjectFile.",
    params: z.strictObject({ cwd: CwdParam, timeline: TimelineIdSchema, view: ViewParam }),
    result: MarkerListResultSchema.extend(ViewedShape),
  },
  "marker.add": {
    mutating: true,
    description:
      "Add a marker: a named point on the timeline clock (ADR 0029), e.g. `{ at: 12.5, label: \"hook\" }`; `at` snaps to the frame grid. " +
      "Labels are unique in the timeline ignoring case, at most 80 characters, no space at either end, never shaped like an id " +
      "(`m_1a2b3c`) or a grid reference (`beat:8`, `bar:2`, any case). `color`: `red`, `orange`, `yellow`, `green`, `blue` or `purple`. `cut` moves markers after the cut with the " +
      "material and deletes markers strictly inside the removed range (a marker on the range's first frame stays; only when it cuts " +
      "every video, audio and program track, otherwise markers stay); `ripple` inserts and trims move them the same way, and a ripple " +
      "trim deletes markers inside the material it removes. The new id is in `changes.added`. Fails with InvalidOperation (label taken; " +
      "the message names the marker holding it).",
    params: operationArgs["marker.add"].extend({ cwd: CwdParam, timeline: TimelineIdSchema }),
    result: OperationResultSchema,
  },
  "marker.set": {
    mutating: true,
    description:
      "Move, rename or recolour a marker (ADR 0029): `{ marker: \"hook\", at: 14 }`, `{ marker: \"m_1a2b3c\", label: \"cta\" }`; " +
      "`color: null` clears its colour. `marker` is the id or the label (ignoring case). Fields left out keep their value. Fails with " +
      "InvalidOperation (no such marker, the message lists them; label taken; nothing to change).",
    params: operationArgs["marker.set"].extend({ cwd: CwdParam, timeline: TimelineIdSchema }),
    result: OperationResultSchema,
  },
  "marker.remove": {
    mutating: true,
    description:
      "Delete a marker (ADR 0029): `{ marker: \"hook\" }`, by id or label (ignoring case). Fails with InvalidOperation when there is no " +
      "such marker (the message lists them).",
    params: operationArgs["marker.remove"].extend({ cwd: CwdParam, timeline: TimelineIdSchema }),
    result: OperationResultSchema,
  },
  "tempo.show": {
    description:
      "The beat grid of a timeline (ADR 0029): its stored `tempo` and, on the timeline clock, every beat and bar start in timeline " +
      "seconds. The grid is the measured one in the beats file of the `tempo.clip` music clip (`beats.measure`), carried through the " +
      "clip's start, `in` and speed so it follows the music when it moves, or a nominal grid from `bpm`. `grid` is null with " +
      "`problem` when a clip has no beats file yet or the file is broken, and null with no `problem` when the timeline has no tempo. " +
      "`low` means the measured grid may be double time or a bar off: `snapTo` refuses it until `edits` in the beats file correct it. " +
      "In review mode, `view` picks the file or the open proposal's version. Fails with TimelineNotFound or InvalidProjectFile.",
    params: z.strictObject({ cwd: CwdParam, timeline: TimelineIdSchema, view: ViewParam }),
    result: z.object({
      timeline: z.string(),
      revision: z.int(),
      tempo: TempoSchema.nullable().describe("The stored `tempo`; null when the timeline has none."),
      grid: TempoGridSchema.nullable().describe("The grid on the timeline clock; null when there is none (see `problem`)."),
      problem: z.string().nullable().describe("Why a `tempo` has no grid yet; null otherwise."),
      ...ViewedShape,
    }),
  },
  "tempo.set": {
    mutating: true,
    description:
      "Set or clear the timeline's beat grid (ADR 0029): `{ clip }` follows the measured grid in the beats file of that music clip's " +
      "asset (run `beats.measure` first; moving or trimming the clip moves the grid), `{ bpm, offset?, meter? }` is a nominal grid " +
      "on the timeline clock for blocking a film before music exists (beat `i` at `offset + 60 i / bpm`, each frame rounded once), " +
      "`{ clip, bpm, offset? }` a nominal grid riding on a clip (`offset` in its source seconds), `{ clear: true }` removes it. " +
      "Replaces the whole tempo. The app draws bars stronger than beats, drags snap to them, and any time argument takes `snapTo: " +
      "\"beat\" | \"bar\" | \"marker\"`. Removing the `clip` clears the tempo with a warning. Fails with InvalidOperation (not a media clip " +
      "of a video or audio track, nothing to set).",
    params: operationArgs["tempo.set"].extend({ cwd: CwdParam, timeline: TimelineIdSchema }),
    result: OperationResultSchema,
  },
  "letterbox.set": {
    mutating: true,
    description:
      "Set or clear the timeline's letterbox (ADR 0043): black bars over the whole finished picture, above every video track and " +
      "under the captions, which stay where they are (over a bar when placed there). `{ aspect: 2.39 }` keeps a 2.39:1 picture: bars " +
      "top and bottom when the aspect is wider than the frame, at the sides when narrower; `{ clear: true }` removes them. Export " +
      "and the app's preview draw the same bars. Primary format only: other formats re-block without bars. Fails with " +
      "InvalidOperation (nothing to set, `clear` with `aspect`).",
    params: operationArgs["letterbox.set"].extend({ cwd: CwdParam, timeline: TimelineIdSchema }),
    result: OperationResultSchema,
  },
} as const satisfies Record<string, MethodSpec>;
