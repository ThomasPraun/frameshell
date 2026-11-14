import { z } from "zod";
import { SCHEMA_VERSION, type ParseResult, formatIssues } from "./common.js";
import { HttpUrl } from "./credits.js";

/** Canonical `$schema` URL for a project's `brand.json`. */
export const BRAND_SCHEMA_URL = `https://frameshell.dev/schema/v${SCHEMA_VERSION}/brand.json`;

/** Project-relative path of the brand manifest (ADR 0044); the daemon is its only writer. */
export const BRAND_FILE = "brand.json";

/** Folder of captured brand files; each capture writes into its own `<id>/` below it. */
export const BRAND_DIR = "assets/brand";

const Hex = z.string().regex(/^#[0-9a-f]{6}$/, "must be a lowercase hex colour `#rrggbb`");

/** Roles a colour is seen in on the captured page. */
export const BRAND_COLOR_ROLES = ["text", "background", "border", "heading", "link", "button"] as const;

/** One file a capture wrote into the project. */
export const BrandFileSchema = z.strictObject({
  path: z
    .string()
    .regex(/^assets\/[^\\]+$/, "must be a project-relative path under `assets/`")
    .describe("Project-relative path, e.g. `assets/brand/example-com/logo-1.svg` or `assets/fonts/Inter-400.woff2`."),
  role: z
    .enum(["logo", "icon", "og", "hero", "page", "font"])
    .describe(
      "`logo`: a logo candidate from the header or nav, or an image or SVG named like a logo. `icon`: a favicon or touch icon. " +
        "`og`: the page's share image. `hero`: the first screen (1600x1000 CSS px at 2x). `page`: the whole page at 1x. `font`: a face whose own name table names an open licence.",
    ),
  kind: z.enum(["svg", "raster", "font"]).describe("`svg`: sanitised vector, sharp at any zoom. `raster`: PNG, JPEG, GIF or WebP. `font`: a font file."),
  origin: z.literal("captured").describe("Taken from the page as it is; a logo is never redrawn."),
  sourceUrl: HttpUrl.describe("Where the bytes came from: the file's URL, or the page for screenshots and inline SVG."),
  width: z.int().positive().nullable().describe("Pixel width (CSS px for inline SVG), when known."),
  height: z.int().positive().nullable().describe("Pixel height, when known."),
});

/** A colour of the page and the roles it plays there. */
export const BrandColorSchema = z.strictObject({
  hex: Hex,
  count: z.int().min(1).describe("Elements using it, all roles together."),
  roles: z.array(z.enum(BRAND_COLOR_ROLES)).describe("Roles it plays, most used first."),
});

/** One `@font-face` of a family the page uses. */
export const BrandFontFaceSchema = z.strictObject({
  weight: z.string().describe("`font-weight` of the face as declared, e.g. `400` or `100 900` for a variable face."),
  style: z.string().describe("`font-style` as declared, e.g. `normal`, `italic`."),
  unicodeRange: z.string().nullable().describe("`unicode-range` as declared; null when the face covers everything."),
  url: z.string().nullable().describe("The source the capture would copy (woff2 first); null when only local() sources exist."),
  file: z.string().nullable().describe("Project file the face was copied to, under `assets/fonts/`; null when it was not copied."),
  licence: z.string().nullable().describe("`OFL-1.1`, `Apache-2.0` or `UFL-1.0` when the file's own name table names it; null otherwise."),
  note: z.string().describe("Why the face was or was not copied."),
});

/** A font family the page sets text in. */
export const BrandFontSchema = z.strictObject({
  family: z.string().min(1).describe("First family of the `font-family` stacks that use it."),
  uses: z.int().min(1).describe("Text elements set in it."),
  weights: z.array(z.int().min(1).max(1000)).describe("Weights those elements use, most used first."),
  generic: z.boolean().describe("True for a generic or system family (`sans-serif`, `system-ui`…): nothing to copy."),
  icon: z.boolean().describe("True for an icon font: never a face for text."),
  faces: z.array(BrandFontFaceSchema).describe("Declared faces chosen for the weights in use (the one covering Latin `A` when subsets are split)."),
});

/** A heading or button as the page draws it. */
export const BrandTextStyleSchema = z.strictObject({
  tag: z.string().describe("Element, e.g. `h1`, `button`, `a`."),
  text: z.string().describe("Its text, at most 80 characters."),
  family: z.string(),
  size: z.number().describe("Font size, CSS px."),
  weight: z.int(),
  tracking: z.number().describe("Letter spacing in em; 0 for `normal`."),
  color: Hex.nullable(),
  background: Hex.nullable(),
});

/** One capture of one URL (ADR 0044). */
export const BrandCaptureSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "must be lowercase letters, digits and dashes").describe("Folder name under `assets/brand/`, from the host, e.g. `example-com`."),
  url: HttpUrl.describe("URL asked for."),
  finalUrl: HttpUrl.describe("URL the page ended on after redirects."),
  capturedAt: z.iso.datetime().describe("When the capture ran (ISO 8601, UTC)."),
  title: z.string().nullable(),
  ok: z.boolean().describe("False when the page loaded but yielded too little to use."),
  reason: z.enum(["little-text"]).nullable().describe("`little-text`: very little text and no logo, icon, share image or font: a login wall, a bot check or an empty app shell."),
  textLength: z.int().min(0).describe("Characters of visible text."),
  files: z.array(BrandFileSchema),
  colors: z.array(BrandColorSchema).describe("Most used first."),
  accent: Hex.nullable().describe("The colour seen in the most roles, never a browser link colour or a red used only for text; null when every colour is neutral."),
  fonts: z.array(BrandFontSchema).describe("Most used first."),
  variables: z.record(z.string(), z.string()).describe("`:root` custom properties as computed (first 300)."),
  headings: z.array(BrandTextStyleSchema),
  buttons: z.array(BrandTextStyleSchema),
  videos: z.array(z.string()).describe("Video URLs the page plays, recorded and never downloaded."),
  warnings: z.array(z.string()),
});

/** Width Figma frames are usually designed at, CSS px (ADR 0044 decision 10). */
export const FIGMA_FRAME_WIDTH = 1440;

/** One frame of a Figma import: a sanitised SVG and where it sits on the project canvas. */
export const BrandFrameSchema = z.strictObject({
  path: z
    .string()
    .regex(/^assets\/brand\/[^\\]+\.svg$/, "must be a project-relative `.svg` path under `assets/brand/`")
    .describe("Project-relative path of the sanitised frame, e.g. `assets/brand/acme-figma/home.svg`."),
  name: z.string().min(1).max(255).describe("File name in the imported folder, e.g. `Home.svg`."),
  origin: z.literal("imported").describe("Exported from a design file by the person; never redrawn."),
  width: z.number().positive().describe("Frame width in its own px (`width` attribute, else the viewBox)."),
  height: z.number().positive().describe("Frame height in its own px."),
  x: z.number().describe("Left edge on the canvas after scaling by the import's `scale`, canvas px; centred, so negative when wider than the canvas."),
  y: z.number().describe("Top edge on the canvas after scaling, canvas px; centred, so negative when taller than the canvas."),
  removed: z.array(z.string()).describe("What the sanitiser removed, e.g. `1 script element`, `2 external references`; empty when nothing."),
});

/** One import of a folder of Figma SVG exports (ADR 0044 decision 10). */
export const BrandImportSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "must be lowercase letters, digits and dashes").describe("Folder name under `assets/brand/`, from the imported folder's name."),
  kind: z.literal("figma"),
  source: z.string().min(1).max(4096).describe("Folder imported from: project-relative when inside the project, else absolute."),
  importedAt: z.iso.datetime().describe("When the import ran (ISO 8601, UTC)."),
  canvas: z.strictObject({ width: z.int().positive(), height: z.int().positive() }).describe("Project canvas (`resolution`) the frames were fitted to."),
  reference: z.number().positive().describe(`Width the scale is taken from: the widest frame (Figma frames are usually ${FIGMA_FRAME_WIDTH} px).`),
  scale: z.number().positive().describe("One factor for every frame of the folder: canvas width / `reference`. Never fitted per frame, so UI sizes match between screens."),
  frames: z.array(BrandFrameSchema).min(1).describe("Frames kept, in file name order."),
  warnings: z.array(z.string()).describe("Files skipped and why."),
});

/** Zod model of `brand.json` (ADR 0044): what each brand capture and Figma import found and wrote. */
export const BrandManifestSchema = z
  .strictObject({
    $schema: z.string().optional(),
    schemaVersion: z.literal(SCHEMA_VERSION),
    captures: z.array(BrandCaptureSchema).default([]),
    imports: z.array(BrandImportSchema).default([]),
  })
  .superRefine((file, ctx) => {
    // Captures and imports share the folder namespace `assets/brand/<id>/`.
    const seen = new Set<string>();
    for (const list of ["captures", "imports"] as const) {
      file[list].forEach((entry, index) => {
        if (seen.has(entry.id)) ctx.addIssue({ code: "custom", message: `duplicate brand id ${entry.id}`, path: [list, index, "id"] });
        seen.add(entry.id);
      });
    }
  });

/** Validated `brand.json` content. */
export type BrandManifest = z.output<typeof BrandManifestSchema>;

/** One capture of a {@link BrandManifest}. */
export type BrandCapture = BrandManifest["captures"][number];

/** One Figma import of a {@link BrandManifest}. */
export type BrandImport = BrandManifest["imports"][number];

/** A manifest with no captures or imports, as the daemon writes it first. */
export function createBrandManifest(): BrandManifest {
  return { $schema: BRAND_SCHEMA_URL, schemaVersion: SCHEMA_VERSION, captures: [], imports: [] };
}

/** Validate unknown input as `brand.json`. Never throws. */
export function parseBrandManifest(input: unknown): ParseResult<BrandManifest> {
  const result = BrandManifestSchema.safeParse(input);
  return result.success ? { ok: true, value: result.data } : { ok: false, error: formatIssues(result.error) };
}
