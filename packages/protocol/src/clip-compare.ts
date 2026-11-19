import { z } from "zod";

// `clip.compare` (ADR 0035): one frame of a generated clip under several prop or source variants, as one image.

/** Most variants one `clip.compare` renders next to the clip as it is. */
export const CLIP_COMPARE_MAX_LOOKS = 11;
/** Tile width of a `clip.compare` sheet when none is given, px. */
export const CLIP_COMPARE_DEFAULT_TILE_WIDTH = 480;
/** Narrowest tile of a `clip.compare` sheet, px. */
export const CLIP_COMPARE_MIN_TILE_WIDTH = 160;
/** Widest tile of a `clip.compare` sheet, px. */
export const CLIP_COMPARE_MAX_TILE_WIDTH = 960;
/** Longest look name, characters. */
export const CLIP_LOOK_NAME_MAX = 40;

/** One candidate of `clip.compare`: props merged over the clip's own and/or another `source`, with the name its tile shows. */
export const ClipLookSchema = z.strictObject({
  name: z
    .string()
    .trim()
    .min(1)
    .max(CLIP_LOOK_NAME_MAX)
    .optional()
    .describe(`Label of the tile, at most ${CLIP_LOOK_NAME_MAX} characters, e.g. \`dusk\`. Default \`look <n>\`.`),
  source: z.string().min(1).optional().describe("Project-relative source to draw in place of the clip's own (a variant `.blend`, another composition). Default: the clip's."),
  props: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("Adapter props merged over the clip's own, key by key (a key set to null is dropped). For a Blender clip: `{ scene, camera }`."),
});

/** One tile of a `clip.compare` sheet. */
export const ClipCompareTileSchema = z.object({
  label: z.string().describe("Text drawn on the tile: its number in reading order and its name, e.g. `2 dusk`."),
  kind: z.enum(["current", "look"]).describe("`current`: the clip as it is. `look`: one of `looks`, in their order."),
  source: z.string().nullable().describe("Source drawn; null when the clip has none."),
  props: z.record(z.string(), z.unknown()).nullable().describe("The whole props drawn (the clip's merged with the look's); null for none."),
  flags: z.string().describe("`clip set` flags that give the clip this tile's props (`--props` takes the whole object); empty for `current` and for a look that changes nothing. A different `source` has no flag: `clip add` it again."),
});

/** Result of `clip.compare`. */
export const ClipCompareResultSchema = z.object({
  timeline: z.string().describe("Timeline id."),
  clip: z.string().describe("The compared clip."),
  type: z.string().describe("Its adapter type, e.g. `blender`."),
  frame: z.int().describe("Timeline frame rendered."),
  at: z.number().describe("Start of that frame, timeline seconds, 3 decimals."),
  path: z.string().describe("Absolute path of the PNG written."),
  width: z.int().describe("Width of the image, px."),
  height: z.int().describe("Height of the image, px."),
  columns: z.int().describe("Tiles per row."),
  rows: z.int().describe("Rows of tiles."),
  tiles: z.array(ClipCompareTileSchema).describe("In reading order: left to right, then top to bottom."),
  warnings: z.array(z.string()),
});

/** Result of `clip.compare`. */
export type ClipCompareResultShape = z.infer<typeof ClipCompareResultSchema>;
/** One look of `clip.compare`. */
export type ClipLook = z.infer<typeof ClipLookSchema>;
