import { z } from "zod";
import { SCHEMA_VERSION, type ParseResult, formatIssues } from "./common.js";
import { AUDIO_EFFECT_LIMITS, MAX_AUDIO_EFFECTS } from "./effects.js";
import { ElementsSchema } from "./element-styles.js";
import { TakeIdSchema } from "./shoot.js";

/** Canonical `$schema` URL for `timelines/*.json`. */
export const TIMELINE_SCHEMA_URL = `https://frameshell.dev/schema/v${SCHEMA_VERSION}/timeline.json`;

/** Clip types the core owns; every other `type` belongs to an adapter plugin (SPEC §5.3). */
export const CORE_CLIP_TYPES = ["media", "timeline", "shot"] as const;

/** Adapter clip type name: lowercase, not a core type. */
export const ADAPTER_CLIP_TYPE_PATTERN = /^(?!(?:media|timeline|shot)$)[a-z][a-z0-9-]*$/;

/**
 * Shot layouts (ADR 0016): `solo` takes one angle, `two-up` two, `grid` two or more;
 * `screen` one angle whole (never cropped), `pip` a screen angle with a second angle as an inset.
 */
export const SHOT_LAYOUTS = ["solo", "two-up", "grid", "screen", "pip"] as const;

/** Corners of a `pip` shot's inset. */
export const SHOT_CORNERS = ["top-left", "top-right", "bottom-left", "bottom-right"] as const;

/** Corner of a `pip` inset when the shot has no `corner`. */
export const DEFAULT_SHOT_CORNER: (typeof SHOT_CORNERS)[number] = "bottom-right";

/** Angles a shot of each layout takes: `[min, max]`. */
export const SHOT_ANGLE_COUNTS: Readonly<Record<(typeof SHOT_LAYOUTS)[number], readonly [number, number]>> = {
  solo: [1, 1],
  "two-up": [2, 2],
  grid: [2, Number.POSITIVE_INFINITY],
  screen: [1, 1],
  pip: [2, 2],
};

/** A director's shot below this `confidence` is a doubtful one: the timeline marks it for review. */
export const SHOT_LOW_CONFIDENCE = 0.5;

const Seconds = z.number().nonnegative();
const Id = z.string().min(1);

/**
 * Slack for a shot's end (`start + out - in`): start, in and out are each rounded to 3 decimals, so the sum can sit
 * a millisecond above the frame the next shot starts on. Far below one frame at any rate.
 */
const SHOT_END_EPSILON = 0.002;

/** Overlay placement. Omitted fields keep their default. */
export const TransformSchema = z
  .strictObject({
    x: z.number().optional().describe("Horizontal offset in project pixels from the centered position. Default 0."),
    y: z.number().optional().describe("Vertical offset in project pixels from the centered position. Default 0."),
    scale: z.number().positive().optional().describe("Uniform scale factor. Default 1."),
    opacity: z.number().min(0).max(1).optional().describe("0 (invisible) to 1 (opaque). Default 1."),
  })
  .describe("Overlay placement (video tracks only).");

/** Clip audio settings. */
export const ClipAudioSchema = z.strictObject({
  gain: z.number().optional().describe("Gain in dB; 0 = unchanged, negative = quieter. Default 0."),
  muted: z.boolean().optional().describe("Default false."),
});

const effectParam = (limit: { min: number; max: number; default: number }, what: string) =>
  z.number().min(limit.min).max(limit.max).optional().describe(`${what}, ${limit.min} to ${limit.max}. Default ${limit.default}.`);

const { highpass: HPF, denoise: DENOISE, compressor: COMP } = AUDIO_EFFECT_LIMITS;

/** One audio effect of a media clip; see {@link AudioEffectSchema}. */
export type AudioEffect =
  | { kind: "highpass"; frequency?: number | undefined }
  | { kind: "denoise"; floor?: number | undefined; reduction?: number | undefined }
  | { kind: "compressor"; threshold?: number | undefined; ratio?: number | undefined; attack?: number | undefined; release?: number | undefined; makeup?: number | undefined };

/**
 * One audio effect of a media clip (ADR 0031); `kind` selects it, omitted parameters take the voice chain's number.
 * Typed explicitly: inferred, it pushes the `methods` registry past the declaration size the compiler can print.
 */
export const AudioEffectSchema: z.ZodType<AudioEffect> = z.discriminatedUnion("kind", [
  z
    .strictObject({ kind: z.literal("highpass"), frequency: effectParam(HPF.frequency, "Cutoff in Hz: rumble below it is removed") })
    .describe("High-pass filter: removes rumble and handling noise below `frequency`."),
  z
    .strictObject({
      kind: z.literal("denoise"),
      floor: effectParam(DENOISE.floor, "Noise floor in dB"),
      reduction: effectParam(DENOISE.reduction, "Noise reduction in dB"),
    })
    .describe("FFT noise reduction of steady background noise (hiss, hum, room tone)."),
  z
    .strictObject({
      kind: z.literal("compressor"),
      threshold: effectParam(COMP.threshold, "Level in dB above which the sound is compressed"),
      ratio: effectParam(COMP.ratio, "Compression ratio, e.g. 2.5 = 2.5:1"),
      attack: effectParam(COMP.attack, "Attack in ms"),
      release: effectParam(COMP.release, "Release in ms"),
      makeup: effectParam(COMP.makeup, "Gain in dB added after compression"),
    })
    .describe("Compressor: evens out loud and quiet passages."),
]);

/** Sound of a media clip: {@link ClipAudioSchema} plus its audio effects (ADR 0031). */
export const MediaClipAudioSchema = ClipAudioSchema.extend({
  effects: z
    .array(AudioEffectSchema)
    .min(1)
    .max(MAX_AUDIO_EFFECTS)
    .optional()
    .describe(
      `Audio effects applied in order (at most ${MAX_AUDIO_EFFECTS}), e.g. the voice chain highpass, denoise, compressor. ` +
        "Baked once per asset and chain into `.frameshell/audio-fx/`; export and preview play the bake.",
    ),
});

/** Eases between two keys (ADR 0018): the value follows the leaving key's ease. */
export const KEY_EASES = ["linear", "in", "out", "in-out"] as const;

/** Name of an ease in {@link KEY_EASES}. */
export type KeyEase = (typeof KEY_EASES)[number];

const keyList = (value: z.ZodNumber, unit: string) =>
  z
    .array(
      z.strictObject({
        at: Seconds.describe("Clip-clock second of the key: the seconds the clip's `in` counts (source, composition or nested-timeline seconds)."),
        value,
        ease: z
          .enum(KEY_EASES)
          .optional()
          .describe("How the value moves from this key to the next: `linear` (default), `in` (slow start), `out` (slow end), `in-out`."),
        auto: z
          .literal("duck")
          .optional()
          .describe(
            "Set by the command that wrote this key (`duck`: `track.duck`). Running that command again replaces keys with this mark and keeps the others; " +
              "setting or moving a key by hand (`clip.key`) clears it.",
          ),
        base: z
          .number()
          .optional()
          .describe(
            "Only on an `auto` key written over a key set by hand: the level that key was set to, before the dip. " +
              "Running the command again puts that level back as the hand key and takes the dip from it.",
          ),
      }),
    )
    .min(1)
    .superRefine((keys, ctx) => {
      keys.forEach((key, k) => {
        if (k > 0 && key.at <= keys[k - 1]!.at) {
          ctx.addIssue({ code: "custom", message: "keys must be sorted by `at`, each later than the one before", path: [k, "at"] });
        }
      });
    })
    .optional()
    .describe(`Keys of this property (${unit}), sorted by \`at\`; held before the first and after the last. Replaces the static value.`);

/** Keyframes of a clip (ADR 0018): one sorted list per property; audio tracks take only `gain`. */
export const ClipKeysSchema = z
  .strictObject({
    x: keyList(z.number(), "project pixels"),
    y: keyList(z.number(), "project pixels"),
    scale: keyList(z.number().positive(), "factor"),
    opacity: keyList(z.number().min(0).max(1), "0 to 1"),
    gain: keyList(z.number(), "dB"),
  })
  .describe("Keyframes per property, on the clip's own clock. A keyed property ignores its static value (`transform`, `audio.gain`).");

const TransitionSeconds = z.number().positive();

/** Shapes a dissolve can take instead of mixing the pictures (ADR 0030). */
export const TRANSITION_SHAPE_KINDS = ["wipe", "push"] as const;

/** Name of a shape in {@link TRANSITION_SHAPE_KINDS}. */
export type TransitionShapeKind = (typeof TRANSITION_SHAPE_KINDS)[number];

/** Ways a shape travels: the way the incoming picture moves across the frame. */
export const TRANSITION_DIRECTIONS = ["left", "right", "up", "down"] as const;

/** Name of a direction in {@link TRANSITION_DIRECTIONS}. */
export type TransitionDirection = (typeof TRANSITION_DIRECTIONS)[number];

/** How a clip's `dissolve` moves the pictures instead of mixing them (ADR 0030); `shapeAt` evaluates it. */
export const TransitionShapeSchema = z
  .strictObject({
    kind: z
      .enum(TRANSITION_SHAPE_KINDS)
      .describe("`wipe`: a straight edge crosses the frame and uncovers the incoming clip. `push`: the incoming clip slides in and pushes the outgoing one out."),
    direction: z
      .enum(TRANSITION_DIRECTIONS)
      .optional()
      .describe("Way the incoming picture travels: `left` (default: it enters from the right edge), `right`, `up` (enters from the bottom) or `down`."),
  })
  .describe("Shape of this clip's `dissolve` instead of a mix (needs `dissolve`); plays on the bottom video track only. Sound still crossfades.");

const ClipIdSchema = Id.describe("Stable, core-generated (`c_…`); reference clips by it.");
const ClipStartSchema = Seconds.describe("Timeline seconds of the first frame.");
const ScriptRefSchema = z
  .string()
  .min(1)
  .optional()
  .describe("Script scene this clip realizes: `scripts/<file>.md#<anchor>`; without `#anchor`, the whole script.");

/** Fields every video and audio clip carries. Times are seconds snapped by the core to the project frame grid, 3 decimals. */
const clipBase = {
  id: ClipIdSchema,
  start: ClipStartSchema,
  scriptRef: ScriptRefSchema,
  take: TakeIdSchema.optional().describe(
    "Shoot take this clip was placed from by `shoot.assemble` (ADR 0023); re-assembly replaces only clips that carry a take of its shoot.",
  ),
  transform: TransformSchema.optional(),
  audio: ClipAudioSchema.optional(),
  dissolve: TransitionSeconds.optional().describe(
    "Seconds: mix from the clip that ends where this one starts, centered on the cut (a crossfade for sound). " +
      "Short material shortens it; with no clip butted before, it plays as a fade in.",
  ),
  shape: TransitionShapeSchema.optional(),
  fadeIn: TransitionSeconds.optional().describe("Seconds: fade in from black (transparent on upper tracks; silence for sound) at the clip's start."),
  fadeOut: TransitionSeconds.optional().describe("Seconds: fade out to black (transparent on upper tracks; silence for sound) at the clip's end."),
  keys: ClipKeysSchema.optional(),
};

/** Footage, audio or image file. Duration on the timeline = `(out - in) / speed`. */
export const MediaClipSchema = z
  .strictObject({
    ...clipBase,
    audio: MediaClipAudioSchema.optional(),
    type: z.literal("media"),
    asset: z.string().min(1).describe("Project-relative, `/`-separated, e.g. `assets/raw-01.mp4`."),
    in: Seconds.describe("Source seconds of the first frame."),
    out: z.number().positive().describe("Source seconds just after the last frame; greater than `in`."),
    speed: z.number().positive().optional().describe("Playback rate; 1 = normal, 2 = twice as fast. Default 1."),
  })
  .refine((clip) => clip.out > clip.in, { message: "must be after `in`", path: ["out"] });

/** Another timeline file embedded as one clip. */
export const TimelineClipSchema = z.strictObject({
  ...clipBase,
  type: z.literal("timeline"),
  source: z.string().min(1).describe("Project-relative timeline file, e.g. `timelines/intro.json`."),
  in: Seconds.optional().describe("Nested-timeline seconds of the first frame. Default 0."),
  duration: z.number().positive().optional().describe("Seconds played. Default: the rest of the nested timeline after `in`."),
});

/** Clip rendered by an adapter plugin (`hyperframes`, `remotion`, …); `props` follow the adapter's schema. */
export const AdapterClipSchema = z.strictObject({
  ...clipBase,
  // abort: a failed type must not leave this as the only "non-aborted" union branch, hiding the matching variant's errors.
  type: z
    .string()
    .regex(ADAPTER_CLIP_TYPE_PATTERN, {
      message: "must be an adapter clip type (lowercase, not `media`, `timeline` or `shot`)",
      abort: true,
    })
    .describe("Clip type registered by an adapter plugin, e.g. `hyperframes`."),
  source: z
    .string()
    .min(1)
    .optional()
    .describe("Project-relative composition entry, e.g. `compositions/hyperframes/intro/index.html`."),
  in: Seconds.optional().describe("Composition seconds of the first frame. Default 0."),
  duration: z.number().positive().describe("Seconds on the timeline."),
  props: z.record(z.string(), z.unknown()).optional().describe("Adapter-specific properties, validated by the adapter."),
  elements: ElementsSchema.optional(),
});

/** Clip of a video or audio track. `type` selects the variant. */
export const ClipSchema = z.union([MediaClipSchema, TimelineClipSchema, AdapterClipSchema]);

/**
 * Clip of a program track (ADR 0016): chosen angles of the track's multicam
 * group in a layout, over `[in, out)` of the group clock; duration on the
 * timeline = `out - in`. Pictures only: every angle's sound plays under every
 * shot, so a shot has no `audio`, `transform` or `speed`.
 */
export const ShotClipSchema = z
  .strictObject({
    id: ClipIdSchema,
    type: z.literal("shot"),
    start: ClipStartSchema,
    in: Seconds.describe("Group-clock seconds of the first frame."),
    out: z.number().positive().describe("Group-clock seconds just after the last frame; greater than `in`."),
    shot: z
      .enum(SHOT_LAYOUTS)
      .describe("Layout: `solo` (one angle), `two-up` (two), `grid` (two or more), `screen` (one angle whole), `pip` (screen angle + inset)."),
    angles: z
      .array(Id)
      .min(1)
      .describe(
        "Angle ids of the track's group, in layout order (left to right, then top to bottom); no repeats. `pip`: the screen first, then the inset.",
      ),
    corner: z.enum(SHOT_CORNERS).optional().describe("`pip` only: corner of the inset. Default `bottom-right`."),
    confidence: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe("Set by the director: 0 (a guess) to 1 (sure). Absent on shots a person chose."),
    reason: z.string().min(1).optional().describe("Set by the director: why it chose this shot, in a few words."),
    scriptRef: ScriptRefSchema,
    take: TakeIdSchema.optional().describe("Shoot take this shot was placed from by `shoot.assemble` (a take recorded in the app, ADR 0024)."),
  })
  .superRefine((shot, ctx) => {
    if (shot.out <= shot.in) ctx.addIssue({ code: "custom", message: "must be after `in`", path: ["out"] });
    const [min, max] = SHOT_ANGLE_COUNTS[shot.shot];
    if (shot.angles.length < min || shot.angles.length > max) {
      const count = min === max ? `exactly ${min}` : `at least ${min}`;
      ctx.addIssue({ code: "custom", message: `a ${shot.shot} shot takes ${count} angle(s), got ${shot.angles.length}`, path: ["angles"] });
    }
    if (shot.corner !== undefined && shot.shot !== "pip") ctx.addIssue({ code: "custom", message: "only a pip shot has a corner", path: ["corner"] });
    shot.angles.forEach((angle, a) => {
      if (shot.angles.indexOf(angle) !== a) ctx.addIssue({ code: "custom", message: `angle "${angle}" is listed twice`, path: ["angles", a] });
    });
  });

/** Clip of any track kind. */
export const AnyClipSchema = z.union([MediaClipSchema, TimelineClipSchema, AdapterClipSchema, ShotClipSchema]);

/** Part of an angle's picture to keep, as fractions of the source frame cut off each side. */
export const AngleCropSchema = z
  .strictObject({
    left: z.number().min(0).lt(1).optional().describe("Default 0."),
    top: z.number().min(0).lt(1).optional().describe("Default 0."),
    right: z.number().min(0).lt(1).optional().describe("Default 0."),
    bottom: z.number().min(0).lt(1).optional().describe("Default 0."),
  })
  .superRefine((crop, ctx) => {
    if ((crop.left ?? 0) + (crop.right ?? 0) >= 1) ctx.addIssue({ code: "custom", message: "left + right must leave some width", path: ["right"] });
    if ((crop.top ?? 0) + (crop.bottom ?? 0) >= 1) ctx.addIssue({ code: "custom", message: "top + bottom must leave some height", path: ["bottom"] });
  })
  .describe("Fractions of the source picture (0 to below 1) cut off each side before a shot fills its tile with it.");

/**
 * One key of an angle's reframing: from group second `at`, tiles that cut the
 * angle's picture to their aspect keep the part centered on (`x`, `y`).
 */
export const ReframeKeySchema = z.strictObject({
  at: Seconds.describe("Group-clock second of the key."),
  x: z.number().min(0).max(1).describe("Point to center on across the picture: fraction of the source width, 0 left edge, 1 right edge."),
  y: z.number().min(0).max(1).describe("Point to center on down the picture: fraction of the source height, 0 top edge, 1 bottom edge."),
});

/** Ids a mic cannot take: `multicam.angle` reads them as "the camera's own sound" and "no sound". */
export const RESERVED_MIC_IDS: readonly string[] = ["camera", "none"];

/** One synced source of a multicam group (ADR 0016): usually one person's picture and mic. */
export const AngleSchema = z.strictObject({
  id: Id.describe("Unique within the group; shots name angles by it."),
  name: z.string().min(1).describe("Person or camera, e.g. `Ana`."),
  asset: z.string().min(1).describe("Project-relative media file, e.g. `assets/ana.mp4`."),
  offset: Seconds.describe("Group-clock seconds at which the asset's time 0 plays: source time = group time - offset."),
  crop: AngleCropSchema.optional(),
  reframe: z
    .array(ReframeKeySchema)
    .min(1)
    .optional()
    .describe(
      "Where the picture is cut when a tile's aspect differs from it (a solo of a 16:9 camera in a 9:16 export): keys sorted by " +
        "`at`, the point moving in a straight line between keys and held before the first and after the last; the cut never " +
        "leaves the cropped picture. Absent: centered. Screens (`screen` shots, a `pip` screen) are never cut.",
    ),
  audio: ClipAudioSchema.optional().describe(
    "Gain and mute of the sound of this angle's own file, which plays under every shot. Absent with `mic` set: the mic carries the level.",
  ),
  mic: Id.nullable()
    .optional()
    .describe(
      "Where this angle's person is heard. Absent: the sound of its own file. An id of the group's `mics`: that mic " +
        "(one mic may serve several angles and plays once); the file's own sound is then not played. null: no sound " +
        "(a wide camera); its own file's sound is not played either.",
    ),
  screen: z
    .boolean()
    .optional()
    .describe("True: a screen share, not a person. The director shows it (`screen`, `pip`) while it moves and never as a speaker. Default false."),
  speaker: z
    .string()
    .regex(/^s\d+$/, "must look like `s1`")
    .optional()
    .describe(
      "Speaker id (`s1`) in the transcript of this angle's sound (its `mic`'s asset, else `asset`) whose words are this person's " +
        "speaking turns, instead of the energy: for a mic several people share. Angles hearing the same file (or the same mic, once its transcript " +
        "has speakers) take their turns from speakers anyway; screens never do.",
    ),
});

/**
 * A sound file synced to the group apart from any picture (ADR 0016): a lavalier
 * or recorder with its own start time.
 */
export const MicSchema = z.strictObject({
  id: Id.describe("Unique among the group's angles and mics; angles name it in `mic`. Not `camera` or `none`."),
  name: z.string().min(1).describe("Person or recorder, e.g. `Ana lav`."),
  asset: z.string().min(1).describe("Project-relative file with sound, e.g. `assets/ana.wav`. Only its sound is used."),
  offset: Seconds.describe("Group-clock seconds at which the asset's time 0 plays: source time = group time - offset."),
  audio: ClipAudioSchema.optional().describe("Gain and mute of this mic's sound, which plays under every shot, once even when several angles use it."),
});

/**
 * A stretch of the group clock where a person said who speaks (ADR 0016 decision 3: a manual correction always
 * overrides the measured turns): the angle speaks there, or does not, whatever the sound says.
 */
export const PaintedTurnSchema = z.strictObject({
  angle: Id.describe("Angle id of the group."),
  start: Seconds.describe("Group-clock seconds where the stretch starts."),
  end: Seconds.describe("Group-clock seconds where it ends; greater than `start`."),
  speaking: z.boolean().describe("True: the angle speaks in the stretch. False: it does not, even where its sound is loud."),
});

/** The angles of one conversation on one shared clock (ADR 0016), shown by one program track. */
export const MulticamGroupSchema = z
  .strictObject({
    id: Id.describe("Stable, core-generated (`g_…`); a program track names it in `group`."),
    name: z.string().optional(),
    angles: z.array(AngleSchema).min(1),
    mics: z.array(MicSchema).optional().describe("Separate sound files of the group; angles pick theirs with `mic`. Absent: every angle has its own file's sound."),
    painted: z
      .array(PaintedTurnSchema)
      .optional()
      .describe(
        "Who speaks, as a person painted it (`multicam.paint`): each stretch replaces the measured turns of its angle on the group clock, " +
          "for `multicam.turns` and `direct`. Stretches of one angle never overlap. Absent: every turn is measured.",
      ),
  })
  .superRefine((group, ctx) => {
    const seen = new Set<string>();
    group.angles.forEach((angle, a) => {
      if (seen.has(angle.id)) ctx.addIssue({ code: "custom", message: `duplicate angle id "${angle.id}"`, path: ["angles", a, "id"] });
      seen.add(angle.id);
    });
    const mics = new Set<string>();
    group.mics?.forEach((mic, m) => {
      if (RESERVED_MIC_IDS.includes(mic.id)) ctx.addIssue({ code: "custom", message: `mic id "${mic.id}" is reserved`, path: ["mics", m, "id"] });
      else if (seen.has(mic.id) || mics.has(mic.id)) ctx.addIssue({ code: "custom", message: `mic id "${mic.id}" is already an angle or mic id`, path: ["mics", m, "id"] });
      mics.add(mic.id);
    });
    const byAngle = new Map<string, { start: number; end: number }[]>();
    group.painted?.forEach((turn, p) => {
      if (!seen.has(turn.angle)) ctx.addIssue({ code: "custom", message: `painted turn names angle "${turn.angle}", which the group does not have`, path: ["painted", p, "angle"] });
      if (turn.end <= turn.start) ctx.addIssue({ code: "custom", message: "a painted turn must end after it starts", path: ["painted", p, "end"] });
      const others = byAngle.get(turn.angle) ?? [];
      if (others.some((other) => turn.start < other.end && other.start < turn.end)) {
        ctx.addIssue({ code: "custom", message: `painted turns of angle "${turn.angle}" overlap`, path: ["painted", p, "start"] });
      }
      others.push(turn);
      byAngle.set(turn.angle, others);
    });
    group.angles.forEach((angle, a) => {
      angle.reframe?.forEach((key, k) => {
        const previous = angle.reframe![k - 1];
        if (previous && key.at <= previous.at) {
          ctx.addIssue({ code: "custom", message: `reframe keys of angle "${angle.id}" must be sorted by \`at\`, each later than the one before`, path: ["angles", a, "reframe", k, "at"] });
        }
      });
      if (typeof angle.mic === "string" && !mics.has(angle.mic)) {
        const known = group.mics?.map((mic) => mic.id).join(", ");
        ctx.addIssue({ code: "custom", message: `angle "${angle.id}" names mic "${angle.mic}", which the group does not have${known ? ` (mics: ${known})` : ""}`, path: ["angles", a, "mic"] });
      }
      if (angle.mic !== undefined && angle.audio) {
        ctx.addIssue({ code: "custom", message: `angle "${angle.id}" takes its sound from ${angle.mic === null ? "no one" : `mic "${angle.mic}"`}: set gain and mute on the mic, not the angle`, path: ["angles", a, "audio"] });
      }
    });
  });

/** Track mute: silences every clip of the track, whatever its own `audio`. */
const TrackMutedSchema = z
  .boolean()
  .optional()
  .describe("True: the track plays no sound in export and preview, whatever its clips' (or angles' and mics') own `audio`. Default false.");

const HIDDEN = "True: the track shows no picture in export and preview (the tracks below show through); its sound still plays. Default false.";

/** Video or audio track. Clips are kept sorted by `start` and never overlap. */
export const ClipTrackSchema = z.strictObject({
  id: Id.describe("Stable, core-generated (`t_…`)."),
  kind: z.enum(["video", "audio"]),
  name: z.string().optional(),
  muted: TrackMutedSchema,
  hidden: z.boolean().optional().describe(`Video tracks only. ${HIDDEN}`),
  behind: Id.optional().describe(
    "Video tracks only (ADR 0032): id of a video track listed before this one (lower in the stack), the plate. This " +
      "track's pictures go behind the person in front on the plate: while this track shows a clip, the plate's media " +
      "clips are drawn again above it through their subject matte, so a word or a logo sits between the background and " +
      "the person. A shown track between the plate and this one covers the person: while it shows a clip, nothing is " +
      "drawn again. Absent: none.",
  ),
  clips: z.array(ClipSchema).describe("Sorted by `start`, never overlapping."),
});

/**
 * Program track (ADR 0016): the shots of one multicam group. Stacks like a
 * video track; its sound is every angle of the group, under every shot.
 */
export const ProgramTrackSchema = z.strictObject({
  id: Id.describe("Stable, core-generated (`t_…`)."),
  kind: z.literal("program"),
  name: z.string().optional(),
  muted: TrackMutedSchema,
  hidden: z.boolean().optional().describe(HIDDEN),
  group: Id.describe("Id of the multicam group in the timeline's `groups`; one program track per group."),
  clips: z.array(ShotClipSchema).describe("Shots, sorted by `start`, never overlapping."),
});

/** How a cue's text enters: not animated, per character, per word (at its spoken time) or as one line. */
export const SUBTITLE_ENTRIES = ["none", "chars", "words", "line"] as const;

/**
 * One hand-chunked caption phrase (#460): transcript words of one asset, in
 * order, cut into cues. The ids are the transcript's, so cuts and text
 * corrections keep it: a word a cut removed is simply not shown.
 */
export const CaptionPhraseSchema = z.strictObject({
  asset: z.string().min(1).describe("Project-relative asset whose transcript holds the words."),
  words: z.array(Id).min(1).describe("Transcript word ids (`w_…`) in spoken order."),
  chunks: z.array(z.int().positive()).min(1).describe("Words per cue, in order; sums to the number of `words`."),
  keyword: z.int().nonnegative().optional().describe("Index in `words` of the one emphasised word."),
  entry: z.enum(SUBTITLE_ENTRIES).optional().describe("Entry of this phrase's cues; default: the track style's."),
});

/** A time range in which a subtitle track shows nothing. */
export const CaptionGapSchema = z.strictObject({
  from: z.number().nonnegative().describe("Timeline seconds."),
  to: z.number().positive().describe("Timeline seconds; greater than `from`."),
});

/**
 * Subtitle track. Holds no clips: its words are the transcript words inside
 * each clip of the `follows` track, mapped to timeline time (SPEC §5.3).
 */
export const SubtitleTrackSchema = z.strictObject({
  id: Id,
  kind: z.literal("subtitles"),
  name: z.string().optional(),
  follows: Id.describe("Id of the video or audio track whose clips supply the words."),
  style: z
    .looseObject({
      preset: z.string().optional(),
      position: z.enum(["top", "center", "bottom"]).optional(),
      speakerNames: z.boolean().optional().describe("Start the first cue of each speaker turn with the speaker's name (ADR 0020). Default false."),
      keywordColor: z
        .string()
        .regex(/^#[0-9a-fA-F]{6}$/)
        .nullable()
        .optional()
        .describe("Colour of a phrase's keyword (`#rrggbb`); null: the keyword keeps the text colour. Default: the preset's."),
      keywordScale: z.number().min(1).max(2).optional().describe("Keyword size at the start of its entry, as a multiple of its size; it settles to 1. Default: the preset's."),
      entry: z.enum(SUBTITLE_ENTRIES).optional().describe("How cues enter: `none`, `chars`, `words` or `line`. Default `none`."),
    })
    .optional(),
  phrases: z.array(CaptionPhraseSchema).optional().describe("Hand-chunked phrases with their keywords (`captions.set`); words no phrase holds are grouped by the style."),
  gaps: z.array(CaptionGapSchema).optional().describe("Ranges in which no cue shows: a cue overlapping one is hidden."),
});

/** Any track. Track order = stacking order; the first video track is the bottom layer. */
export const TrackSchema = z.discriminatedUnion("kind", [ClipTrackSchema, ProgramTrackSchema, SubtitleTrackSchema]);

/** Colours a marker may take (ADR 0029); the app paints each from its theme. Absent: the accent colour. */
export const MARKER_COLORS = ["red", "orange", "yellow", "green", "blue", "purple"] as const;

/** Name of a colour in {@link MARKER_COLORS}. */
export type MarkerColor = (typeof MARKER_COLORS)[number];

/** Longest marker label, characters. */
export const MARKER_LABEL_MAX = 80;

/** Marker id: `m_` + hex, generated by the core. */
export const MarkerIdSchema = z
  .string()
  .regex(/^m_[0-9a-f]+$/, "must be a marker id like `m_1a2b3c`")
  .describe("Stable, core-generated (`m_…`); reference markers by it or by their label.");

/**
 * A named point on the timeline clock (ADR 0029): a hook, a beat to land on, a note. `cut` ripples it like a
 * clip start and deletes it inside the removed range. Paints nothing and plays nothing.
 */
export const MarkerSchema = z.strictObject({
  id: MarkerIdSchema,
  at: Seconds.describe("Timeline seconds of the marker, snapped by the core to the frame grid."),
  label: z
    .string()
    .min(1)
    .max(MARKER_LABEL_MAX)
    .regex(/^\S(.*\S)?$/, "must not start or end with a space")
    .regex(/^(?!m_[0-9a-f]+$)/i, "must not look like a marker id (`m_1a2b3c`): a reference to a marker would be ambiguous")
    .regex(/^(?!(?:beat|bar):\s*[.\d])/i, "must not look like a beat or bar reference (`beat:8`, `bar:2`): it would shadow the grid")
    .describe(`Name, e.g. \`hook\`; unique in the timeline ignoring case, at most ${MARKER_LABEL_MAX} characters, never shaped like an id (\`m_1a2b3c\`) or a grid reference (\`beat:8\`, \`bar:2\`, any case).`),
  color: z.enum(MARKER_COLORS).optional().describe("`red`, `orange`, `yellow`, `green`, `blue` or `purple`. Absent: the app's accent colour."),
});

/** Key two marker labels clash on: labels are unique per timeline ignoring case. */
export function markerLabelKey(label: string): string {
  return label.toLowerCase();
}

/** The marker `ref` names (ADR 0029 decision 2): the one with that id, else the one with that label ignoring case. */
export function findMarker(markers: readonly Marker[] | undefined, ref: string): Marker | undefined {
  return markers?.find((marker) => marker.id === ref) ?? markers?.find((marker) => markerLabelKey(marker.label) === markerLabelKey(ref));
}

/** The markers as a hint reads them: `m_a "intro" at 1 s, …`, or the empty string when there are none. */
export function describeMarkers(markers: readonly Marker[] | undefined): string {
  return (markers ?? []).map((marker) => `${marker.id} "${marker.label}" at ${marker.at} s`).join(", ");
}

/** The media clip of a video or audio track with id `id`, the only kind `tempo.clip` may name (ADR 0029 decision 4); undefined when there is none. */
export function findMusicClip(timeline: Pick<Timeline, "tracks">, id: string): MediaClip | undefined {
  for (const track of timeline.tracks) {
    if (track.kind !== "video" && track.kind !== "audio") continue;
    const clip = track.clips.find((candidate) => candidate.id === id);
    if (clip) return clip.type === "media" ? (clip as MediaClip) : undefined;
  }
  return undefined;
}

/** The beat grid a timeline follows (ADR 0029); see {@link TempoSchema}. Written out to keep the protocol registry's type small. */
export interface Tempo {
  clip?: string | undefined;
  bpm?: number | undefined;
  offset?: number | undefined;
  meter?: number | undefined;
}

/** Slowest nominal tempo a timeline may name, BPM; the measured grid of a beats file is not bound by it. */
export const MIN_TEMPO_BPM = 20;
/** Fastest nominal tempo a timeline may name, BPM. */
export const MAX_TEMPO_BPM = 400;

/** Most beats per bar a nominal tempo may name (a beats file's `meter` takes the same). */
export const MAX_TEMPO_METER = 16;

/**
 * The timeline's beat grid (ADR 0029 decision 4): where the beats the app draws and `--snap-to` lands on come from.
 * - `{ clip }`: the measured grid in the beats file of the media clip's asset, carried to the timeline through that
 *   clip's start, `in` and speed, so moving or trimming the music moves the grid.
 * - `{ clip, bpm, offset?, meter? }`: a nominal grid riding on that clip (the music has no beats file yet): beat `i`
 *   is source second `offset + 60 i / bpm`.
 * - `{ bpm, offset?, meter? }`: a nominal grid on the timeline clock, to block a film before music exists: beat `i` is
 *   timeline second `offset + 60 i / bpm`, each frame rounded once from the index (`nominalBeatFrame`).
 */
export const TempoSchema: z.ZodType<Tempo> = z
  .strictObject({
    clip: ClipIdSchema.optional().describe("Media clip whose asset's beat grid (`beats.measure`) the timeline follows, or a nominal grid rides on."),
    bpm: z.number().min(MIN_TEMPO_BPM).max(MAX_TEMPO_BPM).optional().describe("Nominal tempo in beats per minute. Absent: the measured grid of `clip`."),
    offset: Seconds.optional().describe("Nominal grid only: the first beat, in timeline seconds (with `clip`: in source seconds of the clip). Default 0."),
    meter: z.int().min(1).max(MAX_TEMPO_METER).optional().describe("Nominal grid only: beats per bar. Default 4."),
  })
  .superRefine((tempo, ctx) => {
    if (tempo.clip === undefined && tempo.bpm === undefined) ctx.addIssue({ code: "custom", message: "needs `clip` (a measured grid) or `bpm` (a nominal one)", path: [] });
    if (tempo.bpm === undefined) {
      for (const field of ["offset", "meter"] as const) {
        if (tempo[field] !== undefined) ctx.addIssue({ code: "custom", message: `\`${field}\` belongs to a nominal grid: give \`bpm\` too`, path: [field] });
      }
    }
  });

/**
 * Zod model of a timeline file (SPEC §5.3). `revision` guards direct edits
 * (SPEC §6.4); duration is derived, never stored. Checks here need no project
 * context; frame-grid and source-duration rules live in the core engine.
 */
export const TimelineSchema = z
  .strictObject({
    $schema: z.string().optional(),
    schemaVersion: z.literal(SCHEMA_VERSION),
    id: z.string().min(1),
    revision: z.int().nonnegative().describe("Bumped by the core on every applied operation; stale direct edits are rejected."),
    tracks: z.array(TrackSchema).describe("Stacking order: the first video track is the bottom layer."),
    groups: z.array(MulticamGroupSchema).optional().describe("Multicam groups (ADR 0016), each shown by one program track."),
    markers: z
      .array(MarkerSchema)
      .optional()
      .describe("Named points on the timeline clock (ADR 0029), sorted by `at`; labels unique ignoring case. Absent when none."),
    tempo: TempoSchema.optional().describe("The beat grid the timeline follows (ADR 0029): a music clip's measured grid, or a nominal BPM. Absent: no grid."),
  })
  .superRefine((timeline, ctx) => {
    const seen = new Set<string>();
    const claim = (id: string, path: (string | number)[]) => {
      if (seen.has(id)) ctx.addIssue({ code: "custom", message: `duplicate id "${id}"`, path });
      seen.add(id);
    };
    timeline.tracks.forEach((track, t) => {
      claim(track.id, ["tracks", t, "id"]);
      if (track.kind !== "subtitles") track.clips.forEach((clip, c) => claim(clip.id, ["tracks", t, "clips", c, "id"]));
      if (track.kind === "video" || track.kind === "audio") {
        track.clips.forEach((clip, c) => {
          if (clip.shape === undefined) return;
          const path = ["tracks", t, "clips", c, "shape"];
          if (track.kind === "audio") ctx.addIssue({ code: "custom", message: "audio tracks have no picture to shape: `shape` is for video tracks", path });
          else if (clip.dissolve === undefined) ctx.addIssue({ code: "custom", message: "`shape` shapes a dissolve: give the clip a `dissolve` too, or remove `shape`", path });
        });
      }
      if (track.kind === "video" && track.behind !== undefined) {
        const plate = timeline.tracks.slice(0, t).find((other) => other.id === track.behind);
        if (!plate || plate.kind !== "video") {
          ctx.addIssue({ code: "custom", message: `must name a video track listed before this one (lower in the stack), got "${track.behind}"`, path: ["tracks", t, "behind"] });
        }
      }
      if (track.kind !== "audio") return;
      if (track.behind !== undefined) ctx.addIssue({ code: "custom", message: "audio tracks have no picture to put behind a subject: `behind` is for video tracks", path: ["tracks", t, "behind"] });
      if (track.hidden !== undefined) ctx.addIssue({ code: "custom", message: "audio tracks have no picture to hide: `hidden` is for video and program tracks", path: ["tracks", t, "hidden"] });
      track.clips.forEach((clip, c) => {
        for (const prop of ["x", "y", "scale", "opacity"] as const) {
          if (clip.keys?.[prop]) ctx.addIssue({ code: "custom", message: `audio tracks take only \`gain\` keys, got \`${prop}\``, path: ["tracks", t, "clips", c, "keys", prop] });
        }
      });
    });
    timeline.groups?.forEach((group, g) => claim(group.id, ["groups", g, "id"]));
    const labels = new Map<string, string>();
    timeline.markers?.forEach((marker, m) => {
      claim(marker.id, ["markers", m, "id"]);
      const key = markerLabelKey(marker.label);
      const other = labels.get(key);
      if (other !== undefined) ctx.addIssue({ code: "custom", message: `label "${marker.label}" is already marker ${other}'s; labels are unique ignoring case`, path: ["markers", m, "label"] });
      else labels.set(key, marker.id);
    });
    if (timeline.tempo?.clip !== undefined) {
      if (!findMusicClip(timeline, timeline.tempo.clip)) {
        ctx.addIssue({
          code: "custom",
          message: `must name a media clip of a video or audio track, got "${timeline.tempo.clip}"`,
          path: ["tempo", "clip"],
        });
      }
    }
    const shown = new Set<string>();
    timeline.tracks.forEach((track, t) => {
      if (track.kind === "program") checkProgramTrack(timeline, track, t, shown, ctx);
    });
    timeline.tracks.forEach((track, t) => {
      if (track.kind !== "subtitles") return;
      checkCaptions(track, t, ctx);
      const followed = timeline.tracks.find((other) => other.id === track.follows);
      if (!followed || (followed.kind !== "video" && followed.kind !== "audio")) {
        ctx.addIssue({
          code: "custom",
          message: `must name a video or audio track, got "${track.follows}"`,
          path: ["tracks", t, "follows"],
        });
      }
    });
  });

/** Phrases hold each word once and add up; gaps run forward. */
function checkCaptions(track: SubtitleTrack, t: number, ctx: z.RefinementCtx): void {
  const seen = new Set<string>();
  track.phrases?.forEach((phrase, p) => {
    const path = ["tracks", t, "phrases", p];
    const total = phrase.chunks.reduce((sum, count) => sum + count, 0);
    if (total !== phrase.words.length) {
      ctx.addIssue({ code: "custom", message: `chunks add up to ${total} words but the phrase has ${phrase.words.length}`, path: [...path, "chunks"] });
    }
    if (phrase.keyword !== undefined && phrase.keyword >= phrase.words.length) {
      ctx.addIssue({ code: "custom", message: `keyword ${phrase.keyword} is past the last word (${phrase.words.length - 1})`, path: [...path, "keyword"] });
    }
    phrase.words.forEach((id, w) => {
      const key = `${phrase.asset}\0${id}`;
      if (seen.has(key)) ctx.addIssue({ code: "custom", message: `word ${id} of ${phrase.asset} is in two places of the phrases`, path: [...path, "words", w] });
      seen.add(key);
    });
  });
  track.gaps?.forEach((gap, g) => {
    if (gap.to <= gap.from) ctx.addIssue({ code: "custom", message: "`to` must be greater than `from`", path: ["tracks", t, "gaps", g, "to"] });
  });
}

/** A program track names an existing group no other program track shows; its shots name that group's angles and never overlap. */
function checkProgramTrack(
  timeline: { groups?: MulticamGroup[] | undefined },
  track: ProgramTrack,
  t: number,
  shown: Set<string>,
  ctx: z.RefinementCtx,
): void {
  const group = timeline.groups?.find((candidate) => candidate.id === track.group);
  if (!group) {
    const ids = timeline.groups?.map((candidate) => candidate.id).join(", ");
    ctx.addIssue({
      code: "custom",
      message: `must name a multicam group in \`groups\`, got "${track.group}"${ids ? ` (groups: ${ids})` : ""}`,
      path: ["tracks", t, "group"],
    });
    return;
  }
  if (shown.has(group.id)) ctx.addIssue({ code: "custom", message: `group "${group.id}" already has a program track`, path: ["tracks", t, "group"] });
  shown.add(group.id);
  const angles = new Set(group.angles.map((angle) => angle.id));
  track.clips.forEach((shot, c) => {
    shot.angles.forEach((angle, a) => {
      if (angles.has(angle)) return;
      ctx.addIssue({
        code: "custom",
        message: `angle "${angle}" is not in group "${group.id}" (angles: ${[...angles].join(", ")})`,
        path: ["tracks", t, "clips", c, "angles", a],
      });
    });
  });
  const order = track.clips.map((shot, c) => ({ shot, c })).sort((a, b) => a.shot.start - b.shot.start);
  for (let i = 1; i < order.length; i++) {
    const previous = order[i - 1]!.shot;
    const { shot, c } = order[i]!;
    const end = previous.start + (previous.out - previous.in);
    if (shot.start < end - SHOT_END_EPSILON) {
      ctx.addIssue({
        code: "custom",
        message: `overlaps ${previous.id} (${previous.start}–${Math.round(end * 1000) / 1000}); shots on a program track cannot overlap`,
        path: ["tracks", t, "clips", c, "start"],
      });
    }
  }
}

/** Validated timeline file content. */
export type Timeline = z.infer<typeof TimelineSchema>;
/** Any track of a {@link Timeline}. */
export type Track = z.infer<typeof TrackSchema>;
/** Video or audio track. */
export type ClipTrack = z.infer<typeof ClipTrackSchema>;
/** Program track (ADR 0016). */
export type ProgramTrack = z.infer<typeof ProgramTrackSchema>;
/** Track that holds clips: video, audio or program. */
export type AnyClipTrack = ClipTrack | ProgramTrack;
/** Subtitle track. */
export type SubtitleTrack = z.infer<typeof SubtitleTrackSchema>;
/** Hand-chunked caption phrase of a subtitle track. */
export type CaptionPhrase = z.infer<typeof CaptionPhraseSchema>;
/** Range in which a subtitle track shows nothing. */
export type CaptionGap = z.infer<typeof CaptionGapSchema>;
/** How a cue's text enters. */
export type SubtitleEntry = (typeof SUBTITLE_ENTRIES)[number];
/** Clip of a video or audio track. */
export type Clip = z.infer<typeof ClipSchema>;
/** `type: "shot"` clip of a program track. */
export type ShotClip = z.infer<typeof ShotClipSchema>;
/** Clip of any track kind. */
export type AnyClip = Clip | ShotClip;
/** Shot layout. */
export type ShotLayout = (typeof SHOT_LAYOUTS)[number];

/** See {@link SHOT_CORNERS}. */
export type ShotCorner = (typeof SHOT_CORNERS)[number];
/** `type: "media"` clip. */
export type MediaClip = z.infer<typeof MediaClipSchema>;
/** `type: "timeline"` clip. */
export type TimelineClip = z.infer<typeof TimelineClipSchema>;
/** Adapter-rendered clip. */
export type AdapterClip = z.infer<typeof AdapterClipSchema>;
/** Timeline marker (ADR 0029). */
export type Marker = z.infer<typeof MarkerSchema>;
/** Multicam group (ADR 0016). */
export type MulticamGroup = z.infer<typeof MulticamGroupSchema>;
/** Separate sound file of a {@link MulticamGroup}. */
export type Mic = z.infer<typeof MicSchema>;
/** One angle of a {@link MulticamGroup}. */
export type Angle = z.infer<typeof AngleSchema>;
/** Crop of an {@link Angle}'s picture. */
export type AngleCrop = z.infer<typeof AngleCropSchema>;
/** A stretch of the group clock a person marked as spoken or silent for one angle; see {@link MulticamGroup}. */
export type PaintedTurn = z.infer<typeof PaintedTurnSchema>;
/** One key of an {@link Angle}'s `reframe`. */
export type ReframeKey = z.infer<typeof ReframeKeySchema>;
/** Keyframes of a clip; see {@link ClipKeysSchema}. */
export type ClipKeys = z.infer<typeof ClipKeysSchema>;
/** One key of a clip property. */
export type ClipKey = NonNullable<ClipKeys["x"]>[number];
/** Shape of a clip's dissolve; see {@link TransitionShapeSchema}. */
export type TransitionShape = z.infer<typeof TransitionShapeSchema>;
/** Clip overlay placement. */
export type Transform = z.infer<typeof TransformSchema>;
/** Clip audio settings. */
export type ClipAudio = z.infer<typeof ClipAudioSchema>;
/** Sound settings of a media clip, audio effects included. */
export type MediaClipAudio = z.infer<typeof MediaClipAudioSchema>;

/** True for a program track's shot. Adapter `type` is any string, so `clip.type === "shot"` alone does not narrow. */
export function isShotClip(clip: AnyClip): clip is ShotClip {
  return clip.type === "shot";
}

/** Validate unknown input as a timeline. Never throws. */
export function parseTimeline(input: unknown): ParseResult<Timeline> {
  const result = TimelineSchema.safeParse(input);
  return result.success
    ? { ok: true, value: result.data }
    : { ok: false, error: formatIssues(result.error) };
}

/** Empty timeline at revision 0, as written by `frameshell init`. */
export function createTimeline(id: string): Timeline {
  return { $schema: TIMELINE_SCHEMA_URL, schemaVersion: SCHEMA_VERSION, id, revision: 0, tracks: [] };
}
