import { z } from "zod";
import { ViewedShape } from "../proposals.js";
import { AnalyzeDiffResultSchema, AnalyzeResultSchema } from "../analyze.js";
import { ReviewOutputSchema, ReviewResultSchema } from "../review.js";
import { FormatIdSchema, SafeZoneSchema } from "@frameshell/schema";
import { TimelineIdSchema } from "../timeline.js";
import { InspectedPointSchema } from "../ui.js";
import {
  type MethodSpec,
  AbsolutePath,
  QualityTierSchema,
  CwdParam,
  ViewParam,
  JobSchema,
  ExportPresetResultSchema,
  FrameFormatSchema,
  DEFAULT_FRAME_QUALITY,
  CoverChoiceShape,
  PresetParam,
  RenderQualityParam,
  FormatInfoSchema,
  FormatChangeSchema,
  RenderOutputSchema,
  BatchEntrySchema,
} from "./shared.js";

/** Daemon methods: export presets, formats, renders, frames, review, analysis, covers and point inspection. */
export const exportMethods = {
  "export.presets": {
    description:
      "List the export presets available in the enclosing project: the built-in ones (`youtube-1080p`, `youtube-1440p`, " +
      "`vertical-1080x1920`, `gif`) and those contributed by its trusted plugins. A preset's `container` is `mp4`, `mov`, `webm` or " +
      "`gif`; a `gif` preset (codec `gif`) has no `audio`, and `video.fit: \"inside\"` makes its `width` x `height` a box the format's frame is fitted inside.",
    params: z.strictObject({ cwd: CwdParam }),
    result: z.object({
      presets: z
        .array(ExportPresetResultSchema)
        .describe("Declarative presets: `container`, `video` (codec, width, height…), `audio`, `loudness` (LUFS)."),
    }),
  },
  "format.list": {
    description:
      "List the delivery formats of the enclosing project (ADR 0027), primary first: one edit renders at each size. " +
      "A project without `formats` in `frameshell.json` has one, its `resolution`. `builtins` lists the ids `format.add` " +
      "takes without a size. While a review-mode proposal changes the formats (ADR 0036), `view: \"proposal\"` lists its version.",
    params: z.strictObject({ cwd: CwdParam, view: ViewParam }),
    result: z.object({
      ...ViewedShape,
      dir: z.string().describe("Project root."),
      formats: z.array(FormatInfoSchema).describe("Primary first."),
      builtins: z.array(FormatInfoSchema).describe("Built-in formats `16x9`, `1x1`, `4x5`, `9x16` with their canvases."),
    }),
  },
  "format.add": {
    mutating: true,
    description:
      "Add a delivery format to the enclosing project's `formats` in `frameshell.json` (ADR 0027), e.g. `{ id: \"9x16\" }`, " +
      "then `render` with `formats: [\"16x9\", \"9x16\"]` exports every one from the same edit. Built-in ids (`16x9` " +
      "1920x1080, `1x1` 1080x1080, `4x5` 1080x1350, `9x16` 1080x1920) take no size; a custom id needs `width` and `height` " +
      "(even), e.g. `{ id: \"web-1600x900\", width: 1600, height: 900 }`. In a format other than the primary, media clips " +
      "with no transform or keys fill the frame (cropped around the centre), generated clips render at the format's size, " +
      "vertical captions are 1.3x larger. The change is journaled in `.frameshell/history/project.config.jsonl` in the " +
      "caller's transaction (ADR 0036): `history` lists it, `revert` with its `op` or `tx` undoes it, and `undo` names the " +
      "call that reverses it. While review mode is on (ADR 0019), a change by anyone but the person in the app waits in " +
      "the transaction's proposal like a timeline change (`proposal` in the result; `frameshell.json` is unchanged until the " +
      "person accepts it). Fails with InvalidOperation (id taken, size missing or odd, a built-in id with another size, an " +
      "image project), ProposalPending (another proposal waits: `proposal.wait`), ProposalState, ProjectNotFound.",
    params: z.strictObject({
      cwd: CwdParam,
      id: FormatIdSchema,
      width: z.int().positive().optional().describe("Frame width in pixels, even. Only for a custom id; a built-in id has its own."),
      height: z.int().positive().optional().describe("Frame height in pixels, even. Only for a custom id."),
      index: z
        .int()
        .min(1)
        .optional()
        .describe("Position in the list, 1 = right after the primary (which always stays first). Default: last."),
    }),
    result: FormatChangeSchema,
  },
  "format.remove": {
    mutating: true,
    description:
      "Remove a delivery format from the enclosing project's `formats` (ADR 0027). The primary format (the first, equal " +
      "to `resolution`) cannot be removed. Removing the last other format leaves `frameshell.json` without `formats`. " +
      "Cached renders of generated clips at its size become unused (`gc` deletes them). Journaled like `format.add`; " +
      "`revert` or `undo` re-adds it at the same position. Held by review mode like `format.add`. Fails with FormatNotFound, " +
      "InvalidOperation (the primary), ProposalPending, ProposalState, ProjectNotFound.",
    params: z.strictObject({ cwd: CwdParam, id: FormatIdSchema }),
    result: FormatChangeSchema,
  },
  render: {
    mutating: true,
    description:
      "Export a timeline to a video file (SPEC §3.5) as a background job, and return at once with the job. Video is " +
      "encoded in segments in parallel and joined; audio is mixed in one continuous pass with a 2 ms fade at every cut, " +
      "`atempo` for clip speed, then two-pass loudness normalization to the target (preset `loudness`, else " +
      "`export.loudness` in `frameshell.json`, else -17 LUFS integrated). Follow the job with `job.list` until it is " +
      "`done` (the file exists at `output`) or `failed` (`error` says why), or subscribe to `job.progress`. Renders from the original assets, not " +
      "proxies, and never waits for ingest. Export v1 renders the first video track (media clips, gaps in black), multicam " +
      "program tracks (every shot's angles in their tiles) and the sound of every video, audio and program track; `warnings` lists what it skipped (subtitles, transforms). Fails with " +
      "PresetNotFound, ExportUnsupported (empty timeline, clips on a second video track, nested timelines or adapter " +
      "clips, a multicam group missing, a program track nested under a transformed clip), TimelineNotFound, AssetNotFound. " +
      "Formats (ADR 0027): `formats` renders the edit once per listed format of the project (`format.list`), one job each, " +
      "the file of each named `<name>-<format>.<container>`; `renders` lists them, and the top-level fields describe the first. " +
      "In a format other than the primary, untransformed media fills the frame (crop around the centre), generated clips " +
      "render at that size first, and vertical captions are 1.3x larger. A `preset` whose aspect differs from a format " +
      "rendered fails with InvalidOperation; FormatNotFound names the project's formats. " +
      "Loop (ADR 0039): `loop: true` makes the file loop without a seam: the last frame must not repeat frame 0 (a loop is a first key " +
      "identical to the last, with the frame range leaving the duplicate out), MP4 and MOV audio gets a 2 ms half-sine fade at its first " +
      "and last sample, and `warnings` says when the output frame rate breaks the cycle or an end fades from or to black. Once the file is " +
      "written the job compares frame 0 with the last frame and puts a warning in the job's `warnings` when they are the same picture. " +
      "The timeline is never changed. Fails with InvalidOperation when combined with `cover`. " +
      "GIF (ADR 0039): `preset: \"gif\"` writes a looping GIF (`exports/<timeline>-gif.gif`): no sound, each format fitted inside 1200x1200 " +
      "(16:9 is 1200x675, 9:16 is 675x1200, never scaled up), at most 30 fps (24 and 25 keep their rate), one palette over the whole file with " +
      "bayer dither, ~4 centisecond frame delays. A GIF always has the loop rules (refused with `cover`, the black-end and cycle warnings, the " +
      "repeated-last-frame warning on the job) and ignores `quality` (a warning says so). More than 350 output frames fails with InvalidOperation " +
      "(`data.frames`, `data.max`) before anything is queued; a finished file over 15 MB puts a warning in the job's `warnings`.",
    params: z.strictObject({
      cwd: CwdParam,
      timeline: TimelineIdSchema,
      preset: PresetParam,
      formats: z
        .array(FormatIdSchema)
        .min(1)
        .optional()
        .describe(
          "Format ids to render, e.g. `[\"16x9\", \"9x16\"]`; each must be in `format.list`. Each file gets the format id " +
            "as suffix. Default: the primary format only, file named as before.",
        ),
      quality: RenderQualityParam,
      out: AbsolutePath.optional().describe(
        "Absolute output file, e.g. `/home/ana/videos/launch/exports/launch.mp4`; its folder is created. " +
          "Default `<project>/exports/<timeline>-<preset>.<container>`. With `formats`, `-<format>` is added before the " +
          "extension of each file. An existing file is replaced when the job finishes.",
      ),
      cover: z
        .strictObject(CoverChoiceShape)
        .optional()
        .describe(
          "Make frame 0 a finished composition (platforms show it as the thumbnail): the frame chosen like `cover` does, with " +
            "its word over it, replaces the first frame only; no subtitles on it, nothing else changes. Absent: frame 0 is the " +
            "timeline's own, and `warnings` says when that is black. Needs the preset's frame rate to equal the project's.",
        ),
      loop: z
        .boolean()
        .optional()
        .describe(
          "Export a file meant to repeat (title loops, banners): frame 0 to the last frame, 2 ms half-sine audio fades at both ends of " +
            "MP4 and MOV, warnings for a broken cycle, black ends, and a last frame that repeats frame 0. Refused with `cover`. Default false.",
        ),
    }),
    result: z.object({
      format: z.string().describe("Format id of the first render, which the fields below describe."),
      renders: z.array(RenderOutputSchema).describe("One per format rendered, in the order asked; the first is the one above."),
      job: JobSchema,
      output: z.string().describe("Absolute path the file is written to."),
      preset: z.string().describe("Preset id used."),
      quality: QualityTierSchema.extract(["draft", "final"]).nullable().describe("Tier asked for; null = the preset as written."),
      encoder: z.string().describe("ffmpeg video encoder of the segments, e.g. `libx264`, `h264_videotoolbox`."),
      timeline: z.string(),
      duration: z.number().describe("Seconds rendered (timeline duration)."),
      width: z.int(),
      height: z.int(),
      fps: z.string().describe("Output frame rate as a rational, e.g. `30/1` or `30000/1001`."),
      loudness: z.number().describe("Integrated loudness target, LUFS."),
      segments: z.int().describe("Video segments encoded in parallel."),
      warnings: z.array(z.string()).describe("Timeline content this export does not render, and a default preset whose size the format overrode; empty when none."),
    }),
  },
  "batch.render": {
    mutating: true,
    description:
      "Render variants of one template timeline from data rows (ADR 0040): sizes, languages, product rows. The batch file " +
      "(`*.batch.json`, JSON Schema `batch.json`) names `template` (timeline id, default `main`), `slots` (name → " +
      "`<clipId>.props.<dot.path>`, `<clipId>.props` (the prop named like the slot), `<clipId>.asset` or `voiceover`), `rows` (`{ id, <slot>: value }`, ids lowercase `[a-z0-9-]`, unique, " +
      "used as file names; a slot a row leaves out keeps the template's value) or `csv` (a CSV file next to the batch file with the rows: a header of `id` and slot names, " +
      "a column typed `price:number` / `text` / `boolean` / `json` or else as the template's value is, an empty cell leaves the slot to the template; every wrong cell is " +
      "reported with its line and column), and optional `formats`, `preset`, `quality`. " +
      "Each row patches the template in memory only, never under `timelines/` (no journal, no proposal): a props value is " +
      "written at its path over the clip's props and checked by the adapter like `clip.set`; an asset swap keeps the clip's " +
      "in, out and placement and fails when the new file lacks the stream the track plays, is shorter than `out`, or lacks a " +
      "transcript a subtitle track follows. Every row × format is validated and compiled first; then the rows render one at a " +
      "time as ordinary `render` jobs, to `<out>/<row>.<container>` (`-<format>` added with formats), and the call returns at " +
      "once. `<out>/manifest.json` (default `<project>/exports/<batch file name>/`) holds every row × format with status, " +
      "output, job, error and timings, rewritten on each job change; follow the jobs with `job.list` or `job.progress`. " +
      "Formats come from `frameshell.json` on disk, never a pending proposal. Batch never generates voiceover. A `voiceover` slot takes a " +
      "voiceover script path (or `{ script, lines, at, tempo, start, gap, track, replace }`) and places the takes `voiceover.generate` already made as phrase clips on " +
      "the row's variant, with the planner and rules of `voiceover.place` (a line with no take fails; a subtitle track that follows the voice track needs each take " +
      "transcribed; the video grows when the voice runs past the template, and the entry's warnings say by how much); `asset` slots swap in files that exist. `dryRun` validates and returns the plan without rendering. Fails with InvalidOperation (data `{ row, slot }`: " +
      "unknown clip, props the adapter refuses, an asset too short or without the stream or transcript; a batch already " +
      "running into the same `out`; a name in `rows` the file lacks; `failed` without a manifest of this batch file), " +
      "InvalidProjectFile (the batch file), and what `render` fails with, its data naming the `row`. Re-run: `rows` " +
      "(row ids, or `first..last` for the rows from one to the other in file order) renders only those rows, `failed` " +
      "only rows with an entry in the manifest that is not `done` (failed, canceled, or left `queued`/`running` when " +
      "the daemon stopped) or no entry yet; both together = the failed ones among `rows`. Only the chosen rows are " +
      "validated, so a bad row elsewhere does not block them; the other rows keep their manifest entries. A chosen row " +
      "whose entries are all `done` with the files still there is skipped (listed in `skipped`) unless `force`: edit " +
      "a row, then pass `force` or its id in `rows` with `force`. `review: true` reviews each rendered file as soon as its render " +
      "is done (`review` on the file, metrics only, one at a time while the next row renders; it needs a ready ffmpeg): " +
      "the entry's `review` gets `verdict` (`fail` when `requirements.json` fails, `warn` for craft warnings, else " +
      "`pass`), `warnings`, `failed`, `checks` and the `run` whose `metrics.json` holds the detail, and the manifest says " +
      "`running` until the last review ended. Rows skipped as done are reviewed too when their entry has no finished " +
      "review. A review that cannot run leaves the render `done` and the entry's review `error`. In a props slot, `<clipId>.props` " +
      "without a path means the prop named like the slot: `{ \"title\": \"c_8f2a1b.props\" }` is `c_8f2a1b.props.title`.",
    params: z.strictObject({
      cwd: CwdParam,
      file: z.string().min(1).describe("Batch file, absolute or relative to `cwd`, e.g. `batches/launch.batch.json`."),
      out: AbsolutePath.optional().describe("Absolute folder for the outputs and `manifest.json`. Default `<project>/exports/<batch file name without .batch.json>/`."),
      formats: z
        .array(FormatIdSchema)
        .min(1)
        .optional()
        .describe("Format ids to render each row in, instead of the batch file's `formats`; each must be in `format.list`."),
      rows: z
        .array(z.string().min(1))
        .min(1)
        .optional()
        .describe("Render only these rows: row ids, or `first..last` for the rows from `first` to `last` in the file's order (ids never hold `.`). Default every row."),
      failed: z
        .boolean()
        .default(false)
        .describe("Only rows whose manifest entries are not all `done` (failed, canceled, left queued or running by a stopped daemon) or that have none; needs `<out>/manifest.json` of this batch file."),
      force: z.boolean().default(false).describe("Render chosen rows again although every entry is `done` and its file exists; without it they are skipped."),
      review: z
        .boolean()
        .default(false)
        .describe("Review each rendered file (`review` with `file`, metrics only) and record its verdict in the entry's `review`; slower, off by default."),
      dryRun: z.boolean().default(false).describe("Validate every chosen row × format and return the plan; nothing is rendered or written."),
    }),
    result: z.object({
      dir: z.string().describe("Project root."),
      file: z.string().describe("Absolute path of the batch file."),
      template: z.string().describe("Template timeline id."),
      out: z.string().describe("Absolute output folder."),
      manifest: z.string().nullable().describe("Absolute path of `manifest.json`; null in a dry run."),
      dryRun: z.boolean(),
      preset: z.string().nullable().describe("Preset id every row renders with; null when no row was chosen."),
      quality: QualityTierSchema.extract(["draft", "final"]).nullable().describe("Tier asked for; null = the preset as written, or no row chosen."),
      entries: z
        .array(BatchEntrySchema)
        .describe("Every row × format, row order then format order: the manifest as written now. Rows not rendered by this call keep their earlier entries; `queued` ones are what it renders."),
      skipped: z.array(z.string()).describe("Chosen rows left alone because every entry is `done` and its file exists (pass `force`); empty when none."),
      jobs: z.array(JobSchema).describe("Render jobs queued by this call: the first row's. Later rows queue as the one before ends."),
    }),
  },
  frame: {
    description:
      "Capture the composited frame showing at timeline time `at` as a PNG, JPEG or WebP image, rendered by the export " +
      "compiler (single-frame plan), so it matches `render` and works with the app closed. This is how an image project " +
      "(ADR 0017) is exported: `at: 0`. `projectFormat` captures the frame as that format of the project lays it out " +
      "(ADR 0027), e.g. `9x16`; with `view: proposal` that includes a format only an open review proposal adds (ADR 0036). Size: the preset's when `preset` is given (it must have the format's aspect), else the " +
      "format's (default: the primary, i.e. the project resolution). A generated clip with motion blur whose blurred render was refused (HDR content, shader " +
      "transitions) is drawn from its sharp render, and a 3D composition renders its blur with at most 8 samples: `warnings` says so. Fails with InvalidOperation (`at` outside the " +
      "timeline, data.valid has the range; a preset of another aspect), ExportUnsupported, PresetNotFound, " +
      "FormatNotFound, TimelineNotFound.",
    params: z.strictObject({
      cwd: CwdParam,
      timeline: TimelineIdSchema,
      at: z.number().nonnegative().describe("Timeline seconds, e.g. `12.5`; the frame whose time span holds it is captured."),
      out: AbsolutePath.describe("Absolute image path to write, e.g. `/tmp/frame.png`; its folder is created."),
      preset: z.string().min(1).optional().describe("Export preset id whose width and height to use. Default: the format's size."),
      projectFormat: FormatIdSchema.optional().describe(
        "Format of the project to capture in (`format.list`), e.g. `9x16`. Default: the primary format. Not the image type: that is `format`.",
      ),
      format: FrameFormatSchema.optional().describe(
        "Image format. Default: from the extension of `out` (`.jpg`/`.jpeg` JPEG, `.webp` WebP), else `png`.",
      ),
      quality: z
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe(`JPEG and WebP quality, 1 (smallest) to 100 (best). Default ${DEFAULT_FRAME_QUALITY}. PNG is lossless and ignores it.`),
      view: ViewParam,
    }),
    result: z.object({
      ...ViewedShape,
      path: z.string().describe("Absolute image path written."),
      format: FrameFormatSchema.describe("Format written."),
      timeline: z.string(),
      frame: z.int().describe("Timeline frame index captured (0-based, project fps)."),
      at: z.number().describe("Start time of that frame, timeline seconds."),
      clip: z.string().nullable().describe("Clip showing on the first video track; null in a gap (black frame)."),
      projectFormat: z.string().describe("Format of the project the frame was laid out in."),
      width: z.int(),
      height: z.int(),
      warnings: z
        .array(z.string())
        .describe(
          "What the frame is not quite as asked: a generated clip with motion blur whose blurred render was refused (HDR content, shader transitions) " +
            "shows its sharp render, and a 3D composition caps its blur samples; empty when none.",
        ),
    }),
  },
  review: {
    description:
      "Look at a film before showing it (#457): write contact sheets and strips of a timeline, or of an exported video " +
      "with `file`, into `.frameshell/review/<n>/` (`<n>` counts runs; the last 10 are kept) and report them. Never " +
      "touches project files. Sheets (`sheets`, default the four below, plus `safe` when it applies and `metrics`): `contact` (6 tiles wide, 10 in a vertical format, 30 per " +
      "image; frames at clip starts and ends, cuts, markers, subtitle cues and the deepest zoom of a clip, plus one every " +
      "`every` seconds, each labelled with its time), `phone` (one frame per second at 360 px wide: how it reads on a " +
      "phone), `motion` (the two fastest moments, found by how much the picture changes between frames, as 12 consecutive " +
      "frames each: pops, overlaps and blank frames only show there) and `seam` (the last 6 and the first 6 frames, to " +
      "judge a loop). `safe` (with `platform`, or the platforms the style guide names on a vertical film): up to 36 frames chosen like the " +
      "contact sheet with the platform's UI zones (`style.show` safeZones, one source in `@frameshell/schema`) shaded red; a frame where the captions of a " +
      "subtitle track cross a zone is marked `!subtitle`, and `safeZones` in the result lists them per track and zone (captions are the only text review " +
      "can measure; a file has none). A timeline is rendered frame by frame like `frame` (what `frame` puts in its `warnings`, e.g. a refused motion blur, is in this result's `warnings`; draft work: matches `render`, not a full " +
      "render, app closed is fine); a file is decoded with the managed ffmpeg, so footage and any generated clip type " +
      "are covered. Motion of a long timeline is sampled at most 90 times, so its peaks are approximate. `from` and " +
      "`to` limit it to a range (the seam is then the range's ends). `metrics` (default on, or named in `sheets`) writes `metrics.json` and " +
      "returns `metrics`: numbers a sheet cannot tell, measured on grey frames and the sound: the longest still stretch, the largest gap between " +
      "visual events, near-blank frames, whether frame 0 is empty, subtitle cues on screen for less than they take to read (a timeline), the loudness of a " +
      "`file` (integrated LUFS, range, true peak, the phone band 200 Hz to 6 kHz; measured after the encode, so export first: a timeline has none) and `craft` warnings " +
      "(still over 3 s, empty frame 0, a blank picture, a cue too short, a true peak above -1 dBTP, a phone band 6 LU under the mix, over 15 s of silence). " +
      "`metrics.sync` sets the sounds against the picture events they belong to (the generated sounds `sound.place` put on the timeline, or the hits found in a `file`'s sound; whooshes, risers and ticks are left out): " +
      "each sound's offset to the nearest visual event (early over 45 ms, late over 75 ms), how many land within 45 ms, the share near an event next to what the same sounds score moved by fixed offsets (random placement), and the cuts with no sound. " +
      "`metrics.seam` is the grey jump between the last frame and the first (a hard cut reads 40 to 80, under 10 is continuous); with `loop` a duplicate or a jump is a warning. " +
      "With `file` and `preset`, `metrics.delivery` checks the file against the export plan. The `safe` sheet and `safeZones` also flag graphics (generated clips with an alpha render: titles included) and faces (footage with a cached `people scan`) that reach into a zone, " +
      "and each is a `safe-zone` craft warning. " +
      "A project's `requirements.json` (written with `file.write`) is judged on every run with metrics: `metrics.requirements` lists each expectation it states (film length, longest still stretch, a held end card, loudness of a `file`, " +
      "smallest caption size, per clip `appearsBy`, `before` and `keepsMoving`) as pass, fail or skipped, with what was measured. Craft warnings stay warnings (`severity` `warn`) unless the file lists their check in `fail`; " +
      "a `waivers` entry (check, optional clip, reason) lifts the warnings it covers out of `craft` into `metrics.waived` with its reason, never silently. `requirements.failed` counts what still fails. " +
      "The MCP tool returns the sheets as images. " +
      "Fails with InvalidOperation (a range outside the film, a file with no picture), AssetNotFound (`file` missing), " +
      "TimelineNotFound, FormatNotFound.",
    params: z.strictObject({
      cwd: CwdParam,
      timeline: TimelineIdSchema,
      file: z
        .string()
        .min(1)
        .optional()
        .describe(
          "An exported video to review instead of the timeline (the judge of a reel is the file people get): absolute, or relative to `cwd`, " +
            "e.g. `exports/draft.mp4`. Then `view` is ignored, and `timeline` and `projectFormat` only name the export plan `preset` is checked against; only the grid frames of the contact sheet exist (no cuts, markers or cues).",
        ),
      from: z.number().nonnegative().optional().describe("Start of the range, seconds. Default 0."),
      to: z.number().positive().optional().describe("End of the range, seconds. Default the end of the film."),
      sheets: z
        .array(ReviewOutputSchema)
        .min(1)
        .optional()
        .describe("Outputs to write: the sheets and `metrics`. Default contact, phone, motion, seam and metrics, plus safe when a platform is given or the style guide names platforms on a vertical film."),
      platform: SafeZoneSchema.shape.platform
        .optional()
        .describe(
          "Platform whose UI zones the `safe` sheet draws (instagram-reels, tiktok, youtube-shorts, youtube); adds `safe` to the default sheets. Default: the platforms of the style guide, when `sheets` names `safe` or the film is vertical.",
        ),
      every: z
        .number()
        .positive()
        .optional()
        .describe("Seconds between the grid frames of the contact sheet. Default 0.5 (2 per second), widened so that a long film stays within 120 tiles."),
      projectFormat: FormatIdSchema.optional().describe("Format of the project to lay a timeline out in (`format.list`), e.g. `9x16`. Default: the primary format."),
      preset: z
        .string()
        .min(1)
        .optional()
        .describe(
          "With `file`: the export preset the file was made with (`export.presets`), e.g. `youtube-1080p`. The file is then checked against the export plan of `timeline` (in `projectFormat`) made with it: " +
            "width, height, frame rate, length, video and audio codec and loudness; the answer is `metrics.delivery`.",
        ),
      loop: z
        .boolean()
        .optional()
        .describe("The film is meant to repeat (a title loop, a GIF): a last frame that repeats the first, or jumps from it, becomes a craft warning (`metrics.seam` is measured either way)."),
      view: ViewParam,
    }),
    result: ReviewResultSchema,
  },
  analyze: {
    description:
      "Measure a reference video (#471): what it does, in numbers, so \"make it like this\" works from facts instead of a guess. " +
      "Take its grammar (rhythm, colour, look, events, loudness, tempo), never its content. Writes `.frameshell/analysis/<name>/` " +
      "(replaced by a new run with the same name; regenerable, project files are never touched) and returns: the **shot table** " +
      "(cuts found by ffmpeg's scene score on every frame, each shot's start, end and length, the score of the cut that opens it, a JPEG of " +
      "its middle frame and its dominant colours), the **cutting** (shot count, cuts per minute, average, median, shortest and longest shot), " +
      "the **palette** of the whole film, the **look** (brightness 0 to 1, contrast, saturation, warmth from -1 blue to 1 red, and an 8 x 6 grid of mean colours for the film in the result and for every shot in `analysis.json`), " +
      "the **rhythm** (`shotLengthCv`: spread of the shot lengths over their mean, 0 a metronome; `stillShare`: share of frames in which the picture does not change; `longestStill`; big changes of the picture, their count and per minute; the `largestGap` between them; `bursts`: 3 or more big changes within 1.5 s), " +
      "the **cuts** (every big change of the picture told apart from the frame before and after it: `cut` a new scene, `jump` the same framing with time skipped (a jump cut), `punch-in` / `punch-out` the same shot scaled up or down with its `scale`, `change` no cut (a flash, a caption); `opensShot: false` marks the jump cuts and punches the scene score misses; `counts` and `jumpsPerMinute`), " +
      "the **events** in time order (`flash`: the picture jumps brighter or darker for at most 0.25 s; `appear` / `disappear`: part of the picture gains or loses detail while the rest holds, with its `region` as fractions of the frame, which is where a caption or an element shows up; `hold`: the picture does not change for 0.5 s or more; `hit`: a sudden rise of the sound with its `offset` in seconds to a big change of the picture within 0.2 s, null when none is near), " +
      "the **curve** (the change of the picture over time, one value per 0.1 s or more, and its `moves`: steady stretches with their start, duration, peak and the closest ease: linear, in, out or inOut), " +
      "the **ink** of each shot and of the film (share of the picture covered by graphics or text, its peak, when and the box of grid cells), " +
      "the **sync** (seconds the mouth of a talking face moves after the voice, when this exact file has a cached face scan from `people.scan`; otherwise `reason` says why it was skipped), " +
      "`labels` (MEASURED, ESTIMATED or DECISION for every value, by field path), " +
      "the **loudness** by EBU R128 (integrated LUFS, range LU, true peak dBTP), the **tempo** and " +
      "beats when the sound has a steady beat (the beat detector of `beats.measure`; its beat lists are in `analysis.json`, not in this " +
      "result; `low: true` means do not trust it: speech and ambient sound read as low), the **audio** (all ESTIMATED, read from the mix, not from separated stems: `speech.sentences` " +
      "recognised by the project's transcription provider, each with its `pace` in words per second, `pitch` range (Hz and semitones), `voice` level, the `music` level under it read from the gaps between its words and `voiceOverMusic` in dB; " +
      "`effects`: sound hits that are neither a word nor the music's beat, with their level `overMusic`; `sections`: stretches where the level of the sound holds, with their bars when the tempo is steady). " +
      "Recognising the speech needs a transcription provider and model (it may download the model on first use); without one, or with `speech: false`, `audio.speech.status` is `skipped` with its reason and `effects` is null. Sheets to look at: the **contact** sheet " +
      "(a frame every half second, 2 per second, plus the first frame of every shot, 360 tiles at most) and the **shots** sheet (the middle frame " +
      "of every shot). Every time is a frame index ÷ fps rounded down to the millisecond, and `startFrame`/`endFrame` give the frames. " +
      "The scene score finds a hard cut only: a dissolve or a whip pan is not found (lower `threshold` to catch softer ones), and jump cuts and punch-ins are told apart in `cuts`, not in `shots`. " +
      "A read of the text itself is not made; cuts, events, ink and ease are hints, so look at the frames they name). Label what you tell the person as `labels` does: " +
      "MEASURED, ESTIMATED (hints, and what you read off the sheets by eye: say which frames to check) or DECISION (our creative choice). To compare our film with it, use `analyze.diff`. " +
      "Runs as a background job of kind `analyze` (`job.list`); a 1-minute 1080p video takes about 35 seconds. The MCP tool returns the " +
      "sheets as images. Example: `{ file: \"references/reel.mp4\" }`. Fails with AssetNotFound (`file` missing), " +
      "InvalidOperation (no picture, or shorter than a frame), the Binary* errors when ffmpeg cannot be fetched.",
    params: z.strictObject({
      cwd: CwdParam,
      file: z.string().min(1).describe("The video to analyse: absolute, or relative to `cwd`. It may be anywhere (a download, a reference folder); it is only read."),
      name: z
        .string()
        .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, "letters, digits, `.`, `_` and `-`, at most 64, starting with a letter or digit")
        .optional()
        .describe("Name of the analysis, its folder is `.frameshell/analysis/<name>/`. Default: the file name in lower case, e.g. `reel` for `Reel.mp4`. A new run with the same name replaces the folder."),
      threshold: z
        .number()
        .min(0.05)
        .max(0.95)
        .optional()
        .describe("Scene score (how different a frame is from the one before, 0 to 1) from which a frame opens a new shot. Default 0.3: hard cuts. Lower finds softer ones and false ones (flashes, fast motion); higher keeps only violent changes."),
      speech: z
        .boolean()
        .optional()
        .describe("Recognise the speech (sentences, pace, pitch, voice against music, effects). Default true; false skips the transcription, which is the slow part and may download a model."),
    }),
    result: AnalyzeResultSchema,
  },
  "analyze.diff": {
    description:
      "Compare our film with a reference video (#471): how far apart they are, in numbers, instead of \"looks similar\". The two are lined up by " +
      "**activity-curve alignment** (how much the picture changes over time, correlated within `maxLag` seconds either way, or the `lag` you give), then read at matched times: " +
      "`alignment` (`lag`: seconds to add to a time of our film to find the same moment of the reference; `source`: `activity`, `forced` or `none`; `correlation` of the two curves), " +
      "`energy` (mean and 95th-percentile motion of each, their `ratio` (above 1 our film moves more), and `windows`: both curves second by second, to see where one moves and the other holds), " +
      "`diff` (SSIM, ffmpeg's structural similarity, of our frame and the reference's every `every` seconds: `samples`, `mean`, the lowest `min` and its time, and `below`: the share of readings under 0.5) " +
      "and a **side-by-side sheet** (our frame left, the reference's right at the same matched time, the lowest-SSIM moments and evenly spread ones, `snapshots` pairs; the MCP tool returns it as an image). " +
      "Read it as a distance, not a pass or fail: a different film in the same style scores low SSIM everywhere and can still match in energy. A reference of another shape is stretched to our film's (a warning says so). " +
      "Writes `.frameshell/analysis/<name>/` (`diff.json` and the sheet; replaced by a new run of the same name; project files are never touched). `labels` marks every value MEASURED, ESTIMATED or DECISION. " +
      "Runs as a background job of kind `analyze` (`job.list`); a 30-second pair of 720p films takes about 10 seconds. Example: `{ file: \"exports/reel.mp4\", reference: \"references/reel.mp4\" }`. " +
      "Fails with AssetNotFound (a file missing), InvalidOperation (no picture, or no stretch the two share at that lag), the Binary* errors when ffmpeg cannot be fetched.",
    params: z.strictObject({
      cwd: CwdParam,
      file: z.string().min(1).describe("Our film: an export, or any video. Absolute, or relative to `cwd`."),
      reference: z.string().min(1).describe("The reference video to compare it with: absolute, or relative to `cwd`; it may be anywhere, it is only read."),
      name: z
        .string()
        .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, "letters, digits, `.`, `_` and `-`, at most 64, starting with a letter or digit")
        .optional()
        .describe("Name of the comparison, its folder is `.frameshell/analysis/<name>/`. Default `<film>-vs-<reference>` (file names in lower case, 64 characters at most). A new run with the same name replaces the folder, so do not reuse the name of an `analyze` run you want to keep."),
      lag: z.number().min(-3600).max(3600).optional().describe("Seconds to add to a time of our film to find the same moment of the reference (positive: the reference is later), instead of finding it. Use it when you know where the two start together; the alignment is then a DECISION."),
      maxLag: z.number().min(0.5).max(30).optional().describe("Most seconds the alignment looks for the lag either way. Default 3."),
      every: z.number().min(0.1).max(30).optional().describe("Seconds between SSIM readings. Default 0.5; a long film is read less often (600 readings at most)."),
      snapshots: z.int().min(1).max(24).optional().describe("Pairs of frames on the side-by-side sheet. Default 8, at most 24 (12 pairs make one image)."),
    }),
    result: AnalyzeDiffResultSchema,
  },
  cover: {
    description:
      "Write a cover image: a frame of the timeline with one big word over it, rendered by the export compiler (as `frame` " +
      "and `render` do), checked readable at thumbnail size (180 px wide: the capitals must stay 12 px tall or more). With " +
      "`text` and no `at` the frame is where that word is first spoken; with neither, the first whole picture (after a fade in). The word is " +
      "upper-case in the subtitle face, centered, outlined, as large as the width allows; no subtitles are drawn on a " +
      "cover. Size: the preset's when `preset` is given, else the project resolution. `readability.readable` false " +
      "means the word is too long to read in a grid: shorten it. The same frame can open the exported video: " +
      "`render` with `cover`. Fails with InvalidOperation (`at` outside the timeline, text with nothing to draw), " +
      "ExportUnsupported, PresetNotFound, TimelineNotFound.",
    params: z.strictObject({
      cwd: CwdParam,
      timeline: TimelineIdSchema,
      ...CoverChoiceShape,
      out: AbsolutePath.optional().describe(
        "Absolute image path to write, e.g. `/home/ana/videos/launch/exports/cover.png`; its folder is created. " +
          "Default `<project>/exports/<timeline>-cover.png`.",
      ),
      preset: z.string().min(1).optional().describe("Export preset id whose width and height to use. Default: project resolution."),
      format: FrameFormatSchema.optional().describe("Image format. Default: from the extension of `out`, else `png`."),
      quality: z
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe(`JPEG and WebP quality, 1 (smallest) to 100 (best). Default ${DEFAULT_FRAME_QUALITY}. PNG is lossless and ignores it.`),
      view: ViewParam,
    }),
    result: z.object({
      ...ViewedShape,
      path: z.string().describe("Absolute image path written."),
      format: FrameFormatSchema.describe("Format written."),
      timeline: z.string(),
      frame: z.int().describe("Timeline frame index used (0-based, project fps)."),
      at: z.number().describe("Start time of that frame, timeline seconds."),
      source: z
        .enum(["at", "word", "default"])
        .describe("How the frame was chosen: `at` given, `word` where `text` is first spoken, `default` the first picture."),
      text: z.string().nullable().describe("The word as drawn (upper-case); null when the cover has none."),
      readability: z
        .object({
          thumbnailWidth: z.int().describe("Width the cover is judged at, px."),
          capHeight: z.number().describe("Height of a capital letter at that width, px."),
          minCapHeight: z.number().describe("Smallest capital height that reads, px."),
          readable: z.boolean(),
        })
        .nullable()
        .describe("Thumbnail check of the word; null when the cover has no word."),
      width: z.int(),
      height: z.int(),
      warnings: z.array(z.string()).describe("Things to fix: the word is not spoken anywhere, or too small to read in a grid; empty when none."),
    }),
  },
  "inspect.point": {
    description:
      "What a point of the frame shows at timeline time `at` (ADR 0011): every clip whose picture covers it, topmost " +
      "first, the clip seen there, and in a generated clip (`hyperframes`, `remotion`) the DOM element painting that " +
      "pixel with its selector, text, box, computed styles, HTML and ancestors, as the user's Pick tool reports it. Use it " +
      "to find what to edit (\"the box at the top right at 12 s\") or to check an edit landed. Works with the app closed: " +
      "generated clips are loaded in headless Chrome (a second or two each). Elements need a trusted project with the " +
      "clip's plugin; otherwise `unavailable` says why and only the clips are reported. Footage counts as painting its " +
      "whole box (alpha of footage is not read). With `segment` on a photo in an image project it also names the part of the " +
      "photo under the point as three masks (ADR 0022). Fails with InvalidOperation (`at` or the point outside the timeline or " +
      "frame), TimelineNotFound.",
    params: z.strictObject({
      cwd: CwdParam,
      timeline: TimelineIdSchema,
      at: z.number().nonnegative().describe("Timeline seconds, e.g. `12.5`; the frame whose time span holds it."),
      x: z.number().nonnegative().describe("Horizontal position, 0 = left edge: a fraction of the frame width (e.g. `0.71`), or project pixels with `unit: \"pixel\"`."),
      y: z.number().nonnegative().describe("Vertical position, 0 = top edge: a fraction of the frame height (e.g. `0.14`), or project pixels with `unit: \"pixel\"`."),
      unit: z.enum(["fraction", "pixel"]).default("fraction").describe("What `x` and `y` are. Default `fraction`."),
      segment: z
        .boolean()
        .default(false)
        .describe(
          "In an image project, when the clip seen is a still photo: also segment the part of the photo under the point (ADR 0022). Writes three " +
            "mask PNGs under `.frameshell/context/` and returns them as `segment` (smallest first, `chosen` = best score). The first use downloads " +
            "the model (about 45 MB) and takes seconds; later points on a photo take about 0.2 s. Elsewhere `segmentUnavailable` says why. Default false.",
        ),
      view: ViewParam,
    }),
    result: InspectedPointSchema.extend({
      ...ViewedShape,
      timeline: z.string(),
      frame: z.int().describe("Timeline frame index (0-based, project fps)."),
      pixel: z.object({ x: z.int(), y: z.int() }).describe("The point in project pixels."),
    }),
  },
} as const satisfies Record<string, MethodSpec>;
