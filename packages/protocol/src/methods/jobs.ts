import { z } from "zod";
import {
  GRADE_ANALYZE_DEFAULT_SAMPLES,
  GRADE_ANALYZE_MAX_SAMPLES,
  GRADE_COMPARE_DEFAULT_TILE_WIDTH,
  GRADE_COMPARE_MAX_LOOKS,
  GRADE_COMPARE_MAX_TILE_WIDTH,
  GRADE_COMPARE_MIN_TILE_WIDTH,
  GradeAnalyzeResultSchema,
  GradeCompareResultSchema,
  GradeLookSchema,
} from "../grade.js";
import {
  ClipVerifyResultSchema,
  VERIFY_DEFAULT_PROBES,
  VERIFY_DEFAULT_TOLERANCE,
  VERIFY_MAX_PROBES,
} from "../clip-verify.js";
import { ViewedShape } from "../proposals.js";
import { FormatIdSchema } from "@frameshell/schema";
import { TimelineIdSchema } from "../timeline.js";
import {
  type MethodSpec,
  GcEntrySchema,
  GcSkipSchema,
  CwdParam,
  ViewParam,
  JobSchema,
  AudioBakeSchema,
  MatteStateSchema,
  ClipRenderSchema,
} from "./shared.js";

/** Daemon methods: cache cleanup, jobs, clip renders and checks, bakes, mattes, live clips and Ask context. */
export const jobMethods = {
  gc: {
    mutating: true,
    description:
      "Delete regenerable files under `.frameshell/` that nothing uses any more: proxies, PCM sidecars, waveforms, " +
      "thumbnails, energy envelopes, transcription WAVs, voice prints and subject mattes of assets deleted or changed since (or built for an older " +
      "recipe or another fps), clip renders no timeline's generated clip keys, baked audio effects no clip plays, and temp files of interrupted jobs. " +
      "Keyed by the media index: assets whose content is not known yet are hashed first. Never touches `assets/`, " +
      "project files, history or rejected edits, nor anything a running job uses: the clip cache, transcription WAVs " +
      "and temp files are skipped while jobs or transcriptions run (`skipped` says why). Deleted outputs rebuild on " +
      "demand. `dryRun` lists without deleting.",
    params: z.strictObject({
      cwd: CwdParam,
      dryRun: z.boolean().default(false).describe("Only list what would be deleted. Default false."),
    }),
    result: z.object({
      dir: z.string().describe("Project root."),
      dryRun: z.boolean(),
      removed: z.array(GcEntrySchema).describe("Deleted (or, with `dryRun`, deletable) entries, sorted by path."),
      bytes: z.int().describe("Total size of `removed`."),
      forgotten: z
        .array(z.string())
        .describe("Media index entries of files that no longer exist; dropped from the index unless `dryRun`."),
      skipped: z.array(GcSkipSchema).describe("Areas left alone this run, with why; empty when everything was checked."),
    }),
  },
  "job.list": {
    description:
      "Background jobs of the enclosing project (ingest, render), with state and progress. Jobs keep running after the " +
      "caller disconnects. Poll this until every job you care about is `done` or `failed`, or read it once after " +
      "subscribing to `job.progress` and follow the events instead. A `queued` job says its `position` (1 = next) and its " +
      "`priority`: generated-clip renders (`clip` jobs) run one at a time, interactive ones (what the preview, a frame, an " +
      "export or `clip.renders` asks for) before background ones, and a background one still starts after a few " +
      "interactive ones, so a long render never waits forever.",
    params: z.strictObject({
      cwd: CwdParam,
      active: z.boolean().default(false).describe("Only `queued` and `running` jobs. Default false: also finished ones."),
    }),
    result: z.object({
      dir: z.string().describe("Project root."),
      jobs: z.array(JobSchema).describe("Oldest first."),
    }),
  },
  "job.cancel": {
    mutating: true,
    description:
      "Cancel a generated-clip render (a `clip` job from `job.list`): a queued one is dropped at once and the next one starts, " +
      "a running one is stopped and ends `canceled` (follow `job.progress`, or `job.list`). The clip is then `failed` in " +
      "`clip.renders` with the cancel as its error, and the daemon does not render it again until its inputs change; an " +
      "export or `render` that needs it renders it again. Other kinds of job cannot be canceled (an `ingest` would be " +
      "queued again when the project reopens). Fails with InvalidOperation (data `{ op, reason, field: \"job\" }`; " +
      "`reason`: `unknown-job`, no job of this project has that id (finished ones are dropped after a while), or `not-cancelable`, " +
      "not a `clip` job). Canceling a finished job changes nothing. Example: `{ job: \"j_c7\" }`.",
    params: z.strictObject({
      cwd: CwdParam,
      job: z.string().min(1).describe("Job id from `job.list` or `clip.renders`, e.g. `j_c7`."),
    }),
    result: z.object({
      dir: z.string().describe("Project root."),
      job: JobSchema.describe("The job after the request; `state` is `canceled` for a queued one, still `running` for a running one until it stops."),
    }),
  },
  "clip.renders": {
    description:
      "Render cache state of every generated clip (adapter clips such as `hyperframes`) on a timeline (SPEC §6.5). The " +
      "daemon renders these clips in the background whenever one is added, its props change, or a file its composition " +
      "uses changes; unchanged clips reuse the cache. Use it after `clip.add` of a generated clip to learn when its " +
      "render is ready (`state: \"ready\"`), or follow `job.progress` events of kind `clip`. `render` waits for " +
      "pending clip renders itself. A `failed` clip carries the adapter's `error`: fix the composition, then check " +
      "again. Background renders cover only the primary format; `format` reports the renders at another format's " +
      "size and queues the missing ones (`render --formats` and `frame` in that format make them too). Fails with " +
      "TimelineNotFound, FormatNotFound or InvalidProjectFile.",
    params: z.strictObject({
      cwd: CwdParam,
      timeline: TimelineIdSchema,
      format: FormatIdSchema.optional().describe("Format of the project (`format.list`), e.g. `9x16`. Default: the primary format."),
    }),
    result: z.object({
      timeline: z.string(),
      revision: z.int().describe("Timeline revision the states refer to."),
      clips: z
        .array(ClipRenderSchema)
        .describe("Generated clips on video tracks, with those of nested timelines where they play (as export flattens them), in track then time order."),
    }),
  },
  "clip.verify": {
    description:
      "Check that a generated clip's picture is a pure function of time (ADR 0033), as a motion clip must be: its live page is " +
      "loaded in headless Chrome at the project resolution and `probes` frames are captured at `(i + 0.37) * duration / probes` " +
      "of the clip's played part, each twice. Cold: a fresh page seeks straight to the time. Reseek: one page shows an unrelated " +
      "probe first, then the time. The two captures of a probe must not differ by more than `tolerance` per channel " +
      "(red, green, blue, alpha; default 2 of 255); a bigger difference means the composition keeps state between frames " +
      "(a CSS transition, a timer, a clock, unseeded randomness, a composited layer) and its render would depend on the order " +
      "frames are painted. `ok` is false then, and `worst` names the probe time, the pixel and the page element that paints it. " +
      "`distinct` counts different cold pictures: 1 with several probes (a `warnings` entry says so) means the clip never moves, " +
      "for example a composition whose timeline is not bound to the seek. Reads only: never renders, writes no file. Takes " +
      "seconds to a minute (a page load per probe). Needs the plugin of the clip's type loaded and trusted, and its adapter to " +
      "have a live preview (`hyperframes` does). Example: `{ timeline: \"main\", clip: \"c_1a2b3c\" }`. Fails with ClipNotFound, " +
      "TimelineNotFound, LiveUnavailable (no adapter, no live preview, or the page does not define `window.frameshellLive`), " +
      "OutsideProject, or the Binary* errors when headless Chrome or ffmpeg cannot be fetched.",
    params: z.strictObject({
      cwd: CwdParam,
      timeline: TimelineIdSchema,
      clip: z.string().min(1).describe("Generated clip id as `clip.renders` reports it (`<nested clip>/<clip>` inside a nested timeline)."),
      probes: z
        .int()
        .min(2)
        .max(VERIFY_MAX_PROBES)
        .default(VERIFY_DEFAULT_PROBES)
        .describe(`Frames to capture, evenly spread over the clip. Default ${VERIFY_DEFAULT_PROBES}.`),
      tolerance: z
        .int()
        .min(0)
        .max(255)
        .default(VERIFY_DEFAULT_TOLERANCE)
        .describe(`Largest per-channel difference (of 255) that still counts as the same picture. Default ${VERIFY_DEFAULT_TOLERANCE}.`),
    }),
    result: ClipVerifyResultSchema,
  },
  "grade.analyze": {
    description:
      "Measure the picture of a media clip and suggest a colour correction (ADR 0031), without changing anything: the clip's SOURCE frames " +
      "(before its own grade, crop and placement) are read through ffmpeg `signalstats` at video levels, and the answer is the " +
      "measured `levels` (luma min, 10th percentile, mean, 90th percentile, max; saturation; warmth; tint), the clip's `current` grade, and a " +
      "`suggestion` in the fields of `clip.set` `grade` (`exposure`, `temperature`, `tint`, `contrast`, `saturation`, absolute numbers for the source: a correction the clip already sets and the source does not need comes back neutral, so applying it replaces the clip's own), " +
      "also as `flags` for `clip set`. Never applied: look at the result, then `clip.set` with `grade` (or `clip set --grade-*`) and check the look with " +
      "`frame`. The correction comes first and the LUT after it (ADR 0031: correct first, then style), so a suggestion leaves the clip's LUT alone. It is a first pass " +
      "from a grey-world reading, bounded (at most 1 stop of exposure, 0.4 of white balance, contrast 0.8 to 1.25, saturation 0.85 to 1.2, nothing " +
      "when the picture is within the targets or has no range) and never pushes the highlights into clipping: judge it by eye, a sunset is meant " +
      "to be warm. Scope: `at` (timeline seconds) measures one frame; `from` and `to` (timeline seconds inside the clip) measure `samples` frames " +
      "spread evenly over that part; with none of them the whole clip, `samples` frames (a still is one frame). Footage tagged or named as LOG or HDR " +
      "gets a warning: its levels are flat by design. Reads only: writes no file, takes about a second for a few frames. " +
      "Example: `{ timeline: \"main\", clip: \"c_1a2b3c\" }`. Fails with ClipNotFound (no such clip on a video track), InvalidOperation (not a media clip, a frame " +
      "or range outside the clip, `at` with `from`/`to`, a source with no picture), TimelineNotFound, AssetNotFound, or the Binary* errors when ffmpeg cannot be fetched.",
    params: z.strictObject({
      cwd: CwdParam,
      timeline: TimelineIdSchema,
      clip: z.string().min(1).describe("Media clip id on a video track, as `timeline.show` reports it."),
      at: z.number().nonnegative().optional().describe("Timeline seconds of the one frame to measure, inside the clip. Not with `from` or `to`."),
      from: z.number().nonnegative().optional().describe("Timeline seconds where the measured part starts. Default: the clip's start."),
      to: z.number().nonnegative().optional().describe("Timeline seconds where the measured part ends. Default: the clip's end."),
      samples: z
        .int()
        .min(1)
        .max(GRADE_ANALYZE_MAX_SAMPLES)
        .default(GRADE_ANALYZE_DEFAULT_SAMPLES)
        .describe(`Frames to measure over a range, at the middle of equal parts of it. Default ${GRADE_ANALYZE_DEFAULT_SAMPLES}, at most ${GRADE_ANALYZE_MAX_SAMPLES}.`),
      view: ViewParam,
    }),
    result: z.object({ ...ViewedShape, ...GradeAnalyzeResultSchema.shape }),
  },
  "grade.compare": {
    description:
      "Pick a colour look by eye (ADR 0031): render one frame of a media clip under up to " +
      `${GRADE_COMPARE_MAX_LOOKS} candidate \`looks\` next to a neutral baseline and write them as one labelled PNG contact image. ` +
      "Each look is a whole grade in the fields of `clip.set` `grade` (`exposure`, `temperature`, `tint`, `contrast`, `saturation`, `lut`, `lutMix`) plus an optional `name`, " +
      "drawn in place of the clip's own grade (fields left out are neutral, not the clip's). Tile 1 is the clip with no grade (`neutral`); tile 2 its " +
      "stored grade (`current`) when it has one; then the looks in order. Every tile is the whole composed frame as `frame` renders it " +
      "(export compiler, layers above, captions), so what you pick is what exports. Never changes the timeline: keep a look with `clip.set` `grade` " +
      "(each tile's `flags` are the `clip set` flags). Correct first (`grade.analyze` suggests a correction: compare it as a look), then style with LUTs. " +
      "`at` (timeline seconds inside the clip) picks the frame, default the clip's middle; `out` the PNG (default " +
      "`.frameshell/grade/compare-<clip>-<frame>.png`, replaced by the next call on that frame); `tileWidth` the width of one tile. Takes about a second per tile. " +
      'Example: `{ timeline: "main", clip: "c_1a2b3c", looks: [{ name: "warm", temperature: 0.25, saturation: 1.1 }, { name: "teal", lut: "luts/teal.cube", lutMix: 0.6 }] }`. ' +
      "Fails with ClipNotFound (no such clip on a video track), InvalidOperation (not a media clip, `at` outside the clip), InvalidParams (a look's LUT " +
      "outside the project, missing or not a 3D `.cube`), FormatNotFound, TimelineNotFound, AssetNotFound, or the Binary* errors when ffmpeg cannot be fetched.",
    params: z.strictObject({
      cwd: CwdParam,
      timeline: TimelineIdSchema,
      clip: z.string().min(1).describe("Media clip id on a video track, as `timeline.show` reports it."),
      looks: z
        .array(GradeLookSchema)
        .min(1)
        .max(GRADE_COMPARE_MAX_LOOKS)
        .describe(`Candidate grades, 1 to ${GRADE_COMPARE_MAX_LOOKS}, drawn in this order after the baseline.`),
      at: z.number().nonnegative().optional().describe("Timeline seconds of the frame, inside the clip. Default: the clip's middle frame."),
      out: z
        .string()
        .regex(/\.png$/i, { message: "must be a `.png` file" })
        .optional()
        .describe("PNG to write, absolute or relative to `cwd`; its folder is created. Default `.frameshell/grade/compare-<clip>-<frame>.png` in the project."),
      tileWidth: z
        .int()
        .min(GRADE_COMPARE_MIN_TILE_WIDTH)
        .max(GRADE_COMPARE_MAX_TILE_WIDTH)
        .default(GRADE_COMPARE_DEFAULT_TILE_WIDTH)
        .describe(
          `Width of one tile, px, ${GRADE_COMPARE_MIN_TILE_WIDTH} to ${GRADE_COMPARE_MAX_TILE_WIDTH}; its height follows the frame. Default ${GRADE_COMPARE_DEFAULT_TILE_WIDTH}.`,
        ),
      projectFormat: FormatIdSchema.optional().describe("Format of the project to lay the frame out in (`format.list`), e.g. `9x16`. Default: the primary format."),
      view: ViewParam,
    }),
    result: z.object({ ...ViewedShape, ...GradeCompareResultSchema.shape }),
  },
  "audio.bakes": {
    // The app's preview only: export bakes what it needs itself, so an agent never has to wait on this.
    internal: true,
    description:
      "Baked sound (ADR 0031) of every media clip with audio effects on a timeline, nested timelines flattened: one entry per asset and " +
      "chain. Bakes neither ready nor failed are queued as background `audio-fx` jobs; the preview plays the dry sidecar until `ready`. " +
      "Fails with TimelineNotFound or InvalidProjectFile.",
    params: z.strictObject({ cwd: CwdParam, timeline: TimelineIdSchema, view: ViewParam }),
    result: z.object({
      timeline: z.string(),
      revision: z.int().describe("Revision of the timeline read (the proposal's with `view: proposal`)."),
      bakes: z.array(AudioBakeSchema).describe("In track then time order of their first clip."),
    }),
  },
  "matte.status": {
    // The app's preview only: export and frame captures make the mattes they need themselves (`matte.prepare` for agents).
    internal: true,
    description:
      "Subject matte (ADR 0032) of every video asset a subject layer of a timeline plays (the plates of tracks `behind` one, nested " +
      "timelines flattened). Mattes neither ready nor failed are queued as background `matte` jobs; the preview draws the plate " +
      "without its subject until `ready`. Fails with TimelineNotFound or InvalidProjectFile.",
    params: z.strictObject({ cwd: CwdParam, timeline: TimelineIdSchema, view: ViewParam }),
    result: z.object({
      timeline: z.string(),
      revision: z.int().describe("Revision of the timeline read (the proposal's with `view: proposal`)."),
      mattes: z.array(MatteStateSchema).describe("One per asset, in track then time order of its first subject clip."),
    }),
  },
  "clip.live": {
    // The app's preview only: a page to load in an iframe is of no use to an agent, so no MCP tool or CLI command.
    internal: true,
    description:
      "Live page of one generated clip (ADR 0010), which the app's preview plays while the clip's render is not ready. " +
      "`clip` is an id as `clip.renders` reports it (`<nested clip>/<clip>` inside a nested timeline). Never writes project " +
      "files. Fails with LiveUnavailable (no adapter, adapter without live preview, or the adapter failed), ClipNotFound, " +
      "TimelineNotFound, OutsideProject (the adapter's page escapes the project).",
    params: z.strictObject({ cwd: CwdParam, timeline: TimelineIdSchema, clip: z.string().min(1).describe("Clip id as `clip.renders` reports it.") }),
    result: z.object({
      clip: z.string(),
      root: z.string().describe("Project-relative, `/`-separated directory the page may load files from."),
      entry: z.string().describe("Project-relative, `/`-separated HTML file inside `root`."),
      head: z.string().describe("Script to insert at the start of the entry's `<head>`; defines `window.frameshellLive`."),
      key: z.string().describe("The clip's render cache key now: when `clip.renders` reports another, ask again."),
      elementCss: z
        .string()
        .optional()
        .describe("Sheet of the clip's `elements` (ADR 0021), which the page's bridge applies; absent when the clip has none."),
      styleCss: z
        .string()
        .optional()
        .describe(
          "The project style's token sheet (ADR 0028), inserted first in the page's `<head>` as the render gets it; absent " +
            "without `style.json` or when the clip's adapter does not apply style tokens.",
        ),
    }),
  },
  "context.write": {
    // The app's Chat about this only: it may not write under `.frameshell/` itself (the daemon is the only writer).
    internal: true,
    description:
      "Write one Chat about this details file (ADR 0011) into `.frameshell/context/`: what a pick or a preview region points at " +
      "(layers, element facts), for the agent to read from the reference line. Regenerable and gitignored; `gc` deletes " +
      "files older than 7 days. Replaces a file of the same name. Fails with OutsideProject when `.frameshell/context` leaves the project.",
    params: z.strictObject({
      cwd: CwdParam,
      name: z
        .string()
        .regex(/^e_\d+_\d+\.json$/)
        .describe("File name `e_<frame>_<n>.json`: program frame of the pick, its place in the selection (1-based)."),
      content: z.string().max(1_000_000).describe("JSON text to write."),
    }),
    result: z.object({ path: z.string().describe("Project-relative path written, e.g. `.frameshell/context/e_0421_1.json`.") }),
  },
} as const satisfies Record<string, MethodSpec>;
