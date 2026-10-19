import { z } from "zod";
import { SCHEMA_VERSION, type ParseResult, formatIssues } from "./common.js";

/** Canonical `$schema` URL for `timelines/*.json`. */
export const TIMELINE_SCHEMA_URL = `https://frameshell.dev/schema/v${SCHEMA_VERSION}/timeline.json`;

/** Clip types the core owns; every other `type` belongs to an adapter plugin (SPEC §5.3). */
export const CORE_CLIP_TYPES = ["media", "timeline", "shot"] as const;

/** Adapter clip type name: lowercase, not a core type. */
export const ADAPTER_CLIP_TYPE_PATTERN = /^(?!(?:media|timeline|shot)$)[a-z][a-z0-9-]*$/;

/** Shot layouts (ADR 0016): `solo` takes one angle, `two-up` two, `grid` two or more. */
export const SHOT_LAYOUTS = ["solo", "two-up", "grid"] as const;

/** Angles a shot of each layout takes: `[min, max]`. */
export const SHOT_ANGLE_COUNTS: Readonly<Record<(typeof SHOT_LAYOUTS)[number], readonly [number, number]>> = {
  solo: [1, 1],
  "two-up": [2, 2],
  grid: [2, Number.POSITIVE_INFINITY],
};

/** A director's shot below this `confidence` is a doubtful one: the timeline marks it for review. */
export const SHOT_LOW_CONFIDENCE = 0.5;

const Seconds = z.number().nonnegative();
const Id = z.string().min(1);

/** Slack for comparing stored times, which carry 3 decimals. */
const TIME_EPSILON = 0.0005;

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
  transform: TransformSchema.optional(),
  audio: ClipAudioSchema.optional(),
};

/** Footage, audio or image file. Duration on the timeline = `(out - in) / speed`. */
export const MediaClipSchema = z
  .strictObject({
    ...clipBase,
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
    shot: z.enum(SHOT_LAYOUTS).describe("Layout: `solo` (one angle), `two-up` (two), `grid` (two or more)."),
    angles: z
      .array(Id)
      .min(1)
      .describe("Angle ids of the track's group, in layout order (left to right, then top to bottom); no repeats."),
    confidence: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe("Set by the director: 0 (a guess) to 1 (sure). Absent on shots a person chose."),
    reason: z.string().min(1).optional().describe("Set by the director: why it chose this shot, in a few words."),
    scriptRef: ScriptRefSchema,
  })
  .superRefine((shot, ctx) => {
    if (shot.out <= shot.in) ctx.addIssue({ code: "custom", message: "must be after `in`", path: ["out"] });
    const [min, max] = SHOT_ANGLE_COUNTS[shot.shot];
    if (shot.angles.length < min || shot.angles.length > max) {
      const count = min === max ? `exactly ${min}` : `at least ${min}`;
      ctx.addIssue({ code: "custom", message: `a ${shot.shot} shot takes ${count} angle(s), got ${shot.angles.length}`, path: ["angles"] });
    }
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

/** One synced source of a multicam group (ADR 0016): usually one person's picture and mic. */
export const AngleSchema = z.strictObject({
  id: Id.describe("Unique within the group; shots name angles by it."),
  name: z.string().min(1).describe("Person or camera, e.g. `Ana`."),
  asset: z.string().min(1).describe("Project-relative media file, e.g. `assets/ana.mp4`."),
  offset: Seconds.describe("Group-clock seconds at which the asset's time 0 plays: source time = group time - offset."),
  crop: AngleCropSchema.optional(),
  audio: ClipAudioSchema.optional().describe("Gain and mute of this angle's sound, which plays under every shot."),
});

/** The angles of one conversation on one shared clock (ADR 0016), shown by one program track. */
export const MulticamGroupSchema = z
  .strictObject({
    id: Id.describe("Stable, core-generated (`g_…`); a program track names it in `group`."),
    name: z.string().optional(),
    angles: z.array(AngleSchema).min(1),
  })
  .superRefine((group, ctx) => {
    const seen = new Set<string>();
    group.angles.forEach((angle, a) => {
      if (seen.has(angle.id)) ctx.addIssue({ code: "custom", message: `duplicate angle id "${angle.id}"`, path: ["angles", a, "id"] });
      seen.add(angle.id);
    });
  });

/** Video or audio track. Clips are kept sorted by `start` and never overlap. */
export const ClipTrackSchema = z.strictObject({
  id: Id.describe("Stable, core-generated (`t_…`)."),
  kind: z.enum(["video", "audio"]),
  name: z.string().optional(),
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
  group: Id.describe("Id of the multicam group in the timeline's `groups`; one program track per group."),
  clips: z.array(ShotClipSchema).describe("Shots, sorted by `start`, never overlapping."),
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
    })
    .optional(),
});

/** Any track. Track order = stacking order; the first video track is the bottom layer. */
export const TrackSchema = z.discriminatedUnion("kind", [ClipTrackSchema, ProgramTrackSchema, SubtitleTrackSchema]);

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
    });
    timeline.groups?.forEach((group, g) => claim(group.id, ["groups", g, "id"]));
    const shown = new Set<string>();
    timeline.tracks.forEach((track, t) => {
      if (track.kind === "program") checkProgramTrack(timeline, track, t, shown, ctx);
    });
    timeline.tracks.forEach((track, t) => {
      if (track.kind !== "subtitles") return;
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
    if (shot.start < end - TIME_EPSILON) {
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
/** Clip of a video or audio track. */
export type Clip = z.infer<typeof ClipSchema>;
/** `type: "shot"` clip of a program track. */
export type ShotClip = z.infer<typeof ShotClipSchema>;
/** Clip of any track kind. */
export type AnyClip = Clip | ShotClip;
/** Shot layout. */
export type ShotLayout = (typeof SHOT_LAYOUTS)[number];
/** `type: "media"` clip. */
export type MediaClip = z.infer<typeof MediaClipSchema>;
/** `type: "timeline"` clip. */
export type TimelineClip = z.infer<typeof TimelineClipSchema>;
/** Adapter-rendered clip. */
export type AdapterClip = z.infer<typeof AdapterClipSchema>;
/** Multicam group (ADR 0016). */
export type MulticamGroup = z.infer<typeof MulticamGroupSchema>;
/** One angle of a {@link MulticamGroup}. */
export type Angle = z.infer<typeof AngleSchema>;
/** Crop of an {@link Angle}'s picture. */
export type AngleCrop = z.infer<typeof AngleCropSchema>;
/** Clip overlay placement. */
export type Transform = z.infer<typeof TransformSchema>;
/** Clip audio settings. */
export type ClipAudio = z.infer<typeof ClipAudioSchema>;

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
