import { z } from "zod";
import { BrandCaptureResultSchema, BrandImportFigmaResultSchema, BrandShowResultSchema } from "../brand.js";
import { CreditAssetSchema, ProvenanceParams } from "../credits.js";
import { CreditEntrySchema, MAX_SOURCE_URL } from "@frameshell/schema";
import { type MethodSpec, AbsolutePath, CwdParam, JobSchema, AssetSchema } from "./shared.js";

/** Daemon methods: assets, credits and brand. */
export const assetMethods = {
  "asset.import": {
    mutating: true,
    description:
      "Bring media files into the enclosing project's `assets/` and queue their ingest (probe, CFR proxy, PCM sidecar, " +
      "waveform, thumbnails). Returns at once; follow progress with `job.list`, `status`, or the `job.progress` and " +
      "`asset.changed` events (`events.subscribe`). Files already under " +
      "`assets/` are not copied. A name clash with different content gets a `-2`, `-3`… suffix. Unchanged content " +
      "reuses cached outputs (job `cached: true`). Material from an outside source (a stock site, a sound library, a font) " +
      "needs its provenance: pass `sourceUrl`, `licence`, `author` (and `title`) and each file is recorded in `credits.json` with its " +
      "content hash (ADR 0026); `credits.check` fails on placed assets without it. Give one source per call. Fails with ProjectNotFound, or AssetNotFound when a source is not a file.",
    params: z.strictObject({
      cwd: CwdParam,
      files: z
        .array(AbsolutePath)
        .min(1)
        .describe("Absolute paths of the files to import, e.g. `/home/ana/Movies/raw-01.mp4`."),
      mode: z
        .enum(["copy", "link"])
        .default("copy")
        .describe("`copy` (default) duplicates the file. `link` hard-links it, or symlinks across volumes: no copy, but the source must stay."),
      ...ProvenanceParams,
    }),
    result: z.object({
      dir: z.string().describe("Project root."),
      imported: z.array(
        z.object({
          source: z.string().describe("Absolute path given."),
          asset: z.string().describe("Project-relative asset path, e.g. `assets/raw-01.mp4`."),
          copied: z.boolean().describe("False when the file already was in `assets/` (as-is or with identical content)."),
          job: JobSchema,
          provenance: z.boolean().describe("True when an entry for the file was written to `credits.json` (provenance params were given)."),
        }),
      ),
    }),
  },
  "asset.list": {
    description:
      "List the files under the enclosing project's `assets/` with their ingest state and derived files: CFR proxy, " +
      "PCM sidecar, waveform, thumbnails (all project-relative, all regenerable under `.frameshell/`).",
    params: z.strictObject({ cwd: CwdParam }),
    result: z.object({
      dir: z.string().describe("Project root."),
      assets: z.array(AssetSchema).describe("Sorted by path."),
    }),
  },
  "credits.set": {
    mutating: true,
    description:
      "Record where an asset already in `assets/` came from (ADR 0026): source URL, licence, author, title, an optional credit line. " +
      "Written to `credits.json` with the file's current content hash. Fields given replace the entry's; fields left out keep their value " +
      "while the content is unchanged, and start over when the file changed. Use it for files that were not imported with provenance, and " +
      "`licence: \"own\"` for the person's own footage. Example: `{ asset: \"assets/rain.ogg\", licence: \"CC-BY-4.0\", author: \"Ana Pérez\", " +
      "sourceUrl: \"https://openverse.org/audio/9f2c\" }`. Fails with AssetNotFound (no such file under `assets/`), InvalidOperation " +
      "(`asset` outside `assets/`), InvalidProjectFile.",
    params: z.strictObject({
      cwd: CwdParam,
      asset: z.string().min(1).describe("Asset path: project-relative (`assets/rain.ogg`), absolute, or relative to `cwd`."),
      ...ProvenanceParams,
    }),
    result: z.object({ dir: z.string().describe("Project root."), entry: CreditEntrySchema }),
  },
  "credits.check": {
    description:
      "Judge the provenance of every asset the project's timelines place (clips, multicam angles and mics) against `credits.json`, " +
      "and build the credit text for the video description. `ok` is false when any placed asset has no entry, no licence, a licence that " +
      "needs credit without an author or credit line, content that changed since it was recorded, or is missing: unverified never passes. " +
      "CC0, public domain and `own` need no credit. Run it before export and publishing; fix each `problem` with `credits.set` or by " +
      "re-importing with provenance, or remove the asset. The CLI exits 1 when `ok` is false. Fails with InvalidProjectFile.",
    params: z.strictObject({ cwd: CwdParam }),
    result: z.object({
      dir: z.string().describe("Project root."),
      ok: z.boolean().describe("True when every placed asset is `ok`."),
      assets: z.array(CreditAssetSchema).describe("Every placed asset, sorted by path."),
      credits: z.array(z.string()).describe("Credit lines of the placed assets that need one, without duplicates, sorted."),
      text: z.string().describe("`credits` as the block to paste into the video description; empty when none is needed."),
    }),
  },
  "brand.capture": {
    mutating: true,
    description:
      "Capture a brand from a public web page (ADR 0044): open `url` in Frameshell's headless Chrome at 1600x1000 (2x), wait for the " +
      "network to settle, scroll to load lazy content, then save into the project: logo candidates from the header and nav (inline SVG " +
      "sanitised, or the image file), favicons and touch icons, the share image (og:image), the first screen (`hero.png`) and the whole page " +
      "at 1x (`page.png`, up to 16384 px tall), all under `assets/brand/<id>/` (`<id>` from the host: `example-com`, `-2` when taken); and " +
      "font faces into `assets/fonts/` only when the font file's own name table names OFL-1.1, Apache-2.0 or UFL (otherwise the family, " +
      "weights and why are listed, with the closest open font from Frameshell's curated table as `substitute`; an icon font, by name " +
      "or because most of its cmap is in the Private Use Area, is never a face). With `sections` (texts on the page, e.g. " +
      "`[\"Pricing\", \"Teams\"]`), each text's section, the smallest element at least 500 CSS px wide holding it, is cropped at 3x " +
      "into `section-<text>.png` (up to 2400 CSS px tall) for sharp push-ins; `capture.sections` says what was cropped or not found. " +
      "It measures colours by use and role with an accent (the colour in the most roles), fonts by use, " +
      "`:root` variables, headings and buttons, and records video URLs without downloading them. Everything goes into `brand.json` at " +
      "the project root, and each saved file gets a `credits.json` entry with its source URL and no licence (fonts: the licence they " +
      "name), so `credits check` fails on them until the person confirms they may use them (`credits set --licence own` for their own " +
      "brand). It never changes `style.json`: `style` lists suggested `style set` calls; show the person what was found first. " +
      "Only `http`/`https` URLs on ports 80 and 443; the page reaches public addresses only (private, loopback and link-local " +
      "addresses, including through redirects, are refused), no cookies or sign-in. At most 120 s and 150 MB. Runs as a background " +
      "job of kind `brand`. `capture.ok` is false (`reason: little-text`) when the page yielded very little text and no logo, icon, " +
      "share image or font: a login wall or an empty app shell; look at `hero.png`. Example: `{ url: \"https://example.com\" }`. " +
      "Fails with InvalidOperation (`reason`: `url`, `scheme`, `credentials`, `port`, `address` (not a public address, or a redirect to " +
      "one), `load`, `timeout`), InvalidProjectFile (`brand.json` is broken), ProjectNotFound, or the Binary* errors when headless " +
      "Chrome cannot be fetched.",
    params: z.strictObject({
      cwd: CwdParam,
      url: z.string().min(1).max(MAX_SOURCE_URL).describe("Public page to capture, `http` or `https`, at most 2048 characters, e.g. `https://example.com/pricing`."),
      sections: z
        .array(z.string().trim().min(1).max(200))
        .max(12)
        .optional()
        .describe("Texts on the page whose sections to crop at 3x, at most 12, e.g. `[\"Pricing\", \"Teams\"]`; matched case-insensitively."),
    }),
    result: BrandCaptureResultSchema,
  },
  "brand.show": {
    mutating: false,
    description:
      "The project's brand as recorded in `brand.json` (ADR 0044): every web capture (`brand.capture`: logo, icon, share-image, " +
      "screenshot and font files with their source URL, colours by role with the accent, fonts by use with each face's licence, " +
      "`:root` variables, headings, buttons, warnings) and every Figma import (`brand.importFigma`: frames with their source folder, " +
      "size, the import's one scale and each frame's centred position on the canvas, what the sanitiser removed). Read it before " +
      "building anything branded, and use these files instead of drawing a logo or product UI. Whether a file may be published is " +
      "`credits.check`. `exists` is false (lists empty) when no capture or import ran. Fails with InvalidProjectFile (`brand.json` " +
      "is broken), ProjectNotFound.",
    params: z.strictObject({ cwd: CwdParam }),
    result: BrandShowResultSchema,
  },
  "brand.importFigma": {
    mutating: true,
    description:
      "Import a folder of SVG frames exported from Figma as brand components (ADR 0044 decision 10), so a motion template can zoom " +
      "into a button and stay sharp. Every `.svg` file directly in `dir` (file name order, at most 200, 25 MB each, 200 MB together) " +
      "is sanitised by an allowlist: no script, `foreignObject`, `style` element, event handler, external `href`, `url()` or `image-set()`, " +
      "external `<use>` or entity declaration; embedded `data:` PNG/JPEG/GIF/WebP rasters are kept up to 10 MB of text each. A file that is not well-formed XML, " +
      "declares entities (an internal DTD subset) or states no size (width/height or viewBox) is skipped with a warning. The frames are written to " +
      "`assets/brand/<id>/<name>.svg` (`<id>` from the folder name, `-2` when taken) and recorded in `brand.json` with ONE scale for " +
      "the whole folder (project canvas width / widest frame; Figma frames are usually 1440 px wide), never fitted per frame, and each " +
      "frame's top-left once centred on the canvas. Each frame gets a `credits.json` entry with no licence, so `credits check` fails " +
      "on a placed frame until the person confirms it is theirs (`credits set <file> --licence own`). Nothing goes over the network. " +
      "Example: `{ dir: \"/Users/me/Desktop/acme-figma\" }`; `~` is not expanded. Fails with AssetNotFound (`dir` is not a folder " +
      "or starts with `~`), " +
      "InvalidOperation (`reason: no-frames`: no frame could be kept; the message says why), InvalidProjectFile (`brand.json` is " +
      "broken), ProjectNotFound.",
    params: z.strictObject({
      cwd: CwdParam,
      dir: z.string().min(1).describe("Folder of exported SVG frames, absolute or relative to `cwd`."),
    }),
    result: BrandImportFigmaResultSchema,
  },
} as const satisfies Record<string, MethodSpec>;
