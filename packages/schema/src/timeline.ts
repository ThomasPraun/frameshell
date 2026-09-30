import { z } from "zod";
import { SCHEMA_VERSION, type ParseResult, formatIssues } from "./common.js";

/** Canonical `$schema` URL for `timelines/*.json`. */
export const TIMELINE_SCHEMA_URL = `https://frameshell.dev/schema/v${SCHEMA_VERSION}/timeline.json`;

/** Clip types the core owns; every other `type` belongs to an adapter plugin (SPEC §5.3). */
export const CORE_CLIP_TYPES = ["media", "timeline"] as const;

/** Adapter clip type name: lowercase, not a core type. */
export const ADAPTER_CLIP_TYPE_PATTERN = /^(?!(?:media|timeline)$)[a-z][a-z0-9-]*$/;

const Seconds = z.number().nonnegative();
const Id = z.string().min(1);

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

/** Fields every clip carries. Times are seconds snapped by the core to the project frame grid, 3 decimals. */
const clipBase = {
  id: Id.describe("Stable, core-generated (`c_…`); reference clips by it."),
  start: Seconds.describe("Timeline seconds of the first frame."),
  scriptRef: z.string().min(1).optional().describe("Script scene this clip realizes: `scripts/<file>.md#<anchor>`; without `#anchor`, the whole script."),
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
      message: "must be an adapter clip type (lowercase, not `media` or `timeline`)",
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

/** Any clip. `type` selects the variant. */
export const ClipSchema = z.union([MediaClipSchema, TimelineClipSchema, AdapterClipSchema]);

/** Video or audio track. Clips are kept sorted by `start` and never overlap. */
export const ClipTrackSchema = z.strictObject({
  id: Id.describe("Stable, core-generated (`t_…`)."),
  kind: z.enum(["video", "audio"]),
  name: z.string().optional(),
  clips: z.array(ClipSchema).describe("Sorted by `start`, never overlapping."),
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
export const TrackSchema = z.discriminatedUnion("kind", [ClipTrackSchema, SubtitleTrackSchema]);

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
    timeline.tracks.forEach((track, t) => {
      if (track.kind !== "subtitles") return;
      const followed = timeline.tracks.find((other) => other.id === track.follows);
      if (!followed || followed.kind === "subtitles") {
        ctx.addIssue({
          code: "custom",
          message: `must name a video or audio track, got "${track.follows}"`,
          path: ["tracks", t, "follows"],
        });
      }
    });
  });

/** Validated timeline file content. */
export type Timeline = z.infer<typeof TimelineSchema>;
/** Any track of a {@link Timeline}. */
export type Track = z.infer<typeof TrackSchema>;
/** Video or audio track. */
export type ClipTrack = z.infer<typeof ClipTrackSchema>;
/** Subtitle track. */
export type SubtitleTrack = z.infer<typeof SubtitleTrackSchema>;
/** Any clip. */
export type Clip = z.infer<typeof ClipSchema>;
/** `type: "media"` clip. */
export type MediaClip = z.infer<typeof MediaClipSchema>;
/** `type: "timeline"` clip. */
export type TimelineClip = z.infer<typeof TimelineClipSchema>;
/** Adapter-rendered clip. */
export type AdapterClip = z.infer<typeof AdapterClipSchema>;
/** Clip overlay placement. */
export type Transform = z.infer<typeof TransformSchema>;
/** Clip audio settings. */
export type ClipAudio = z.infer<typeof ClipAudioSchema>;

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
