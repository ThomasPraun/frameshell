import { z } from "zod";
import { type LayerRect, type Size, coverCrop, fixedPlacement, hasPictureKeys, isIdentityPlacement } from "./composite.js";
import type { Clip, Timeline } from "./timeline.js";

/**
 * Formats of a project (ADR 0027): one edit delivered at several frame sizes (16:9, 1:1, 4:5, 9:16…).
 * `frameshell.json` `formats` lists them, the first is the primary and equals `resolution`; without the
 * field the project has one format, its resolution. {@link resolveFormat} is the one place that says how
 * a timeline lays out in a format, {@link formatCrop} and {@link scaledCaptions} how its pictures and
 * captions do: export, `frame` and the preview read them, later review too.
 */

/** Built-in format ids and their canvases (ADR 0027 decision 6, measured canvases from #469). */
export const BUILTIN_FORMATS: Readonly<Record<string, Size>> = Object.freeze({
  "16x9": Object.freeze({ width: 1920, height: 1080 }),
  "1x1": Object.freeze({ width: 1080, height: 1080 }),
  "4x5": Object.freeze({ width: 1080, height: 1350 }),
  "9x16": Object.freeze({ width: 1080, height: 1920 }),
});

/** Ids of {@link BUILTIN_FORMATS}, in the order the docs list them. */
export const BUILTIN_FORMAT_IDS = Object.freeze(Object.keys(BUILTIN_FORMATS));

/** Image types `frameshell frame --format` also takes, so no format may be named after one. */
export const RESERVED_FORMAT_IDS = Object.freeze(["png", "jpg", "jpeg", "webp"]);

/**
 * Caption size factor in a vertical format other than the primary: vertical type reads at about
 * 1.3-1.35 x the landscape size (measured in #469); the low end keeps two-line cues inside 1080 px.
 */
export const VERTICAL_CAPTION_SCALE = 1.3;

/** Format id: lowercase letters, digits and `-`, e.g. `9x16` or `web-1600x900`. */
export const FormatIdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,39}$/, "must be lowercase letters, digits and `-`, up to 40, e.g. `9x16` or `web-1600x900`")
  .refine((id) => !RESERVED_FORMAT_IDS.includes(id), { message: `must not be an image type (${RESERVED_FORMAT_IDS.join(", ")})` })
  .describe("Format id, e.g. `9x16` or `web-1600x900`: lowercase letters, digits and `-`, up to 40; not png, jpg, jpeg or webp.");

/** One format of a project: an id and the frame size it renders at. */
export const FormatEntrySchema = z
  .strictObject({
    id: FormatIdSchema,
    width: z.int().positive(),
    height: z.int().positive(),
  })
  .describe(
    "One delivery format: `id` and frame size in pixels. Built-in ids carry their own canvas: `16x9` 1920x1080, " +
      "`1x1` 1080x1080, `4x5` 1080x1350, `9x16` 1080x1920. Sizes of formats after the first are even.",
  );

/** See {@link FormatEntrySchema}. */
export type FormatEntry = z.infer<typeof FormatEntrySchema>;

/** What a project config says about its frame; the fields {@link projectFormats} reads. */
export interface FormatSource {
  kind?: "video" | "image" | undefined;
  resolution: Size;
  formats?: readonly FormatEntry[] | undefined;
}

/** How the frame-dependent parts of a timeline lay out in one format (ADR 0027). */
export interface FormatLayout {
  /**
   * Untransformed, unkeyed media clips cover the frame (crop-to-fill around the centre) instead of being
   * letterboxed. False in the primary format, so its output stays as it was.
   */
  cover: boolean;
  /** Factor on every subtitle track's font size: {@link VERTICAL_CAPTION_SCALE} in a vertical non-primary format, else 1. */
  captionScale: number;
}

/** A format of a project with its layout. */
export interface ResolvedFormat extends FormatEntry, FormatLayout {
  /** The first format, the one that equals `resolution`. */
  primary: boolean;
}

/** Id of the one format a project without `formats` has: the built-in id of its canvas, else `<width>x<height>`. */
export function primaryFormatId(resolution: Size): string {
  const builtin = BUILTIN_FORMAT_IDS.find((id) => sameSize(BUILTIN_FORMATS[id]!, resolution));
  return builtin ?? `${resolution.width}x${resolution.height}`;
}

/** Formats of a project, primary first: its `formats`, or one format of its resolution when it declares none. */
export function projectFormats(config: FormatSource): FormatEntry[] {
  if (config.formats && config.formats.length > 0) return config.formats.map((format) => ({ ...format }));
  return [{ id: primaryFormatId(config.resolution), ...sizeOf(config.resolution) }];
}

/**
 * Format `id` of the project (the primary when `id` is absent) with its layout, and the timeline as it plays
 * there. The timeline comes back as given: per-format overrides are a later slice of ADR 0027. Null when the
 * project has no format `id`.
 */
export function resolveFormat(timeline: Timeline, config: FormatSource, id?: string): { timeline: Timeline; format: ResolvedFormat } | null {
  const format = formatOf(config, id);
  return format ? { timeline, format } : null;
}

/** Format `id` of the project (the primary when `id` is absent) with its layout; null when the project has no format `id`. */
export function formatOf(config: FormatSource, id?: string): ResolvedFormat | null {
  const formats = projectFormats(config);
  const index = id === undefined ? 0 : formats.findIndex((format) => format.id === id);
  if (index === -1) return null;
  const format = formats[index]!;
  const primary = index === 0;
  const vertical = format.height > format.width;
  return { ...format, primary, cover: !primary, captionScale: !primary && vertical ? VERTICAL_CAPTION_SCALE : 1 };
}

/** What {@link formatCrop} needs of a picture clip's source and track. */
export interface FormatPicture {
  /** Picture size in source pixels; null for a clip without a picture. */
  size: Size | null;
  /** A generated clip's render: made at the format's size (decision 12), never cropped. */
  generated: boolean;
  /** The source has an alpha plane (`media.video.alpha`). */
  alpha: boolean;
  /** On the base track: the first picture track, when it is a video track. */
  base: boolean;
}

/**
 * Source pixels of `clip` that cover a `frame`-sized format in `layout` (ADR 0027 decisions 3 and 13), scaled to fill
 * it exactly; null where the clip keeps its fitted placement: the primary format, a transform or picture keys, a
 * generated clip, a source with alpha on an upper track. Edges and size are even (what ffmpeg's `crop` keeps of a
 * 4:2:0 picture), so export's plan and the preview cut the same pixels. Multicam shots never come here (`shotLayers`).
 */
export function formatCrop(layout: FormatLayout | undefined, clip: Clip, picture: FormatPicture, frame: Size): LayerRect | null {
  if (layout?.cover !== true || picture.size === null || picture.generated || (picture.alpha && !picture.base)) return null;
  if (!isIdentityPlacement(fixedPlacement(clip)) || hasPictureKeys(clip)) return null;
  const { size } = picture;
  const even = (value: number) => value - (value % 2);
  const crop = coverCrop({ left: 0, top: 0, width: size.width, height: size.height }, frame);
  const width = Math.max(2, even(crop.width));
  const height = Math.max(2, even(crop.height));
  return { left: even(Math.max(0, Math.floor((size.width - width) / 2))), top: even(Math.max(0, Math.floor((size.height - height) / 2))), width, height };
}

/** `tracks` with each style's font size times `layout.captionScale` (decision 7): what export burns and the preview draws. */
export function scaledCaptions<T extends { style: { size: number } }>(tracks: readonly T[], layout: FormatLayout | undefined): T[] {
  const scale = layout?.captionScale ?? 1;
  return tracks.map((track) => (scale === 1 ? track : { ...track, style: { ...track.style, size: track.style.size * scale } }));
}

/** True when `a` and `b` have the same aspect ratio, within 1 % (1366x768 counts as 16:9). */
export function sameAspect(a: Size, b: Size): boolean {
  return Math.abs((a.width * b.height) / (a.height * b.width) - 1) < 0.01;
}

/**
 * Problems of a config's `formats`, each with the field path it concerns; empty when valid. The JSON Schema
 * cannot express them, so the field description repeats them.
 */
export function formatProblems(config: FormatSource): { path: (string | number)[]; message: string }[] {
  const formats = config.formats;
  if (formats === undefined) return [];
  const problems: { path: (string | number)[]; message: string }[] = [];
  if (config.kind === "image") {
    problems.push({ path: ["formats"], message: "image projects have one frame (ADR 0017); remove `formats`" });
    return problems;
  }
  const first = formats[0];
  if (first && !sameSize(first, config.resolution)) {
    problems.push({
      path: ["formats", 0],
      message: `the first format is the primary one and must equal \`resolution\` (${config.resolution.width}x${config.resolution.height}), not ${first.width}x${first.height}`,
    });
  }
  const seen = new Set<string>();
  formats.forEach((format, index) => {
    if (seen.has(format.id)) problems.push({ path: ["formats", index, "id"], message: `format id ${format.id} is listed twice` });
    seen.add(format.id);
    const builtin = BUILTIN_FORMATS[format.id];
    if (builtin && !sameSize(builtin, format)) {
      problems.push({
        path: ["formats", index],
        message: `built-in format ${format.id} is ${builtin.width}x${builtin.height}; use a custom id for ${format.width}x${format.height}, e.g. \`${format.id}-${format.width}x${format.height}\``,
      });
    }
    if (index > 0 && (format.width % 2 !== 0 || format.height % 2 !== 0)) {
      problems.push({ path: ["formats", index], message: `format ${format.id} is ${format.width}x${format.height}; video encoders need even sizes` });
    }
  });
  return problems;
}

function sameSize(a: Size, b: Size): boolean {
  return a.width === b.width && a.height === b.height;
}

function sizeOf(size: Size): Size {
  return { width: size.width, height: size.height };
}
