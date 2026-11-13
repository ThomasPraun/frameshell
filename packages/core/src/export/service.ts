import { randomBytes } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import {
  type CoverResult,
  ErrorCode,
  type EncoderName,
  type ExportPresetInfo,
  type FrameFormat,
  type FrameResult,
  type MediaProbe,
  type RenderResult,
  RpcError,
} from "@frameshell/protocol";
import {
  BUILTIN_FORMATS,
  BUILTIN_FORMAT_IDS,
  type ExportPreset,
  type FormatSource,
  type MulticamGroup,
  type ResolvedFormat,
  type ResolvedSubtitleTrack,
  type Size,
  type Timeline,
  type Transcript,
  subjectOf,
  programGroup,
  resolveFormat,
  sameAspect,
  scaledCaptions,
  showsPicture,
  subtitleTracks,
} from "@frameshell/schema";
import { formatNotFound } from "../formats.js";
import type { JobQueue, JobUpdate } from "../jobs/queue.js";
import { runTool } from "../media/ffmpeg.js";
import { readEnclosingProject } from "../projects.js";
import { readNestedFile, resolveNested, transformedProgram } from "../timeline/nested.js";
import { resolveTranscript } from "../transcripts/transcriber.js";
import {
  type ExportSource,
  type GeneratedSource,
  LOUDNESS_STATS_FILE,
  type MatteSource,
  type RenderPlan,
  compileFrame,
  compileRender,
  gifStep,
  loudnessAnalysis,
  mixStep,
  muxStep,
  paletteStep,
  parseLoudnessStats,
} from "./compiler.js";
import {
  type CoverLayout,
  COVER_MAX_CHARS,
  coverReadability,
  coverText,
  firstPictureTime,
  hookWordTime,
  layoutCover,
} from "./cover.js";
import { bundledFontMetrics } from "./font-metrics.js";
import { writeFonts } from "./fonts.js";
import { BUILTIN_PRESETS, DEFAULT_PRESET_ID, fitInside, gifSizeWarning, loudnessTarget } from "./presets.js";
import { renameRetrying } from "../fs-util.js";
import { loopSeamWarning } from "./seam.js";

/** Options for {@link executeRender}. */
export interface ExecuteRenderOptions {
  ffmpeg: string;
  /** Scratch directory for segments and filter scripts; created, and removed afterwards. */
  workDir: string;
  /** Absolute file to write. Replaced atomically once complete; never left half-written. */
  output: string;
  /** Segments encoded at once. Default: half the cores, 1 to 4 (x264 threads on its own too). */
  parallelism?: number;
  /** Kills every ffmpeg when aborted. */
  signal?: AbortSignal;
  onProgress?: (update: { step: "video" | "mux"; progress: number }) => void;
}

/** Share of overall progress spent encoding video segments; the rest is the mux. */
const VIDEO_SHARE = 0.85;

/**
 * Run a compiled plan with ffmpeg: video segments in parallel with the
 * audio mix and its loudness measurement, then one mux pass (concat demuxer
 * + normalized audio). Rejects with the failing step's ffmpeg error.
 */
export async function executeRender(plan: RenderPlan, options: ExecuteRenderOptions): Promise<void> {
  const { ffmpeg, workDir, output } = options;
  // Aborted by the caller, or by the first failing step so its siblings stop too.
  const stop = new AbortController();
  const onAbort = () => stop.abort();
  options.signal?.addEventListener("abort", onAbort, { once: true });
  if (options.signal?.aborted) stop.abort();
  const signal = stop.signal;
  const parallelism = options.parallelism ?? defaultParallelism();
  const report = options.onProgress ?? (() => {});
  const partial = join(dirname(output), `.${basename(output)}.partial-${randomBytes(4).toString("hex")}`);
  const run = (args: string[], onProgress?: (seconds: number) => void) =>
    runTool(ffmpeg, args, { cwd: workDir, signal, ...(onProgress ? { onProgress } : {}) }).catch((error: unknown) => {
      stop.abort();
      throw error;
    });
  try {
    await mkdir(workDir, { recursive: true });
    await writeFiles(workDir, plan.files);
    await writeFonts(workDir, plan.fonts);
    const mix = mixStep(plan);
    const analysis = loudnessAnalysis(plan);
    for (const step of [mix, analysis]) if (step) await writeFiles(workDir, step.files);

    const done = plan.segments.map(() => 0);
    const outFps = rational(plan.fps);
    const videoProgress = () => report({ step: "video", progress: (VIDEO_SHARE * done.reduce((a, b) => a + b, 0)) / plan.frames });
    report({ step: "video", progress: 0 });
    // Audio mix and loudness measurement run alongside the video segments.
    const measuring = mix && analysis ? run(mix.args).then(() => run(analysis.args)) : Promise.resolve("");
    // Settle the measurement even when a segment fails first, so no rejection goes unhandled.
    measuring.catch(() => {});
    await pool(plan.segments, parallelism, async (segment, index) => {
      await run(segment.args, (seconds) => {
        done[index] = Math.min(segment.frames, seconds * outFps);
        videoProgress();
      });
      done[index] = segment.frames;
      videoProgress();
    });
    await measuring;
    const measured = analysis ? parseLoudnessStats(await readFile(join(workDir, LOUDNESS_STATS_FILE), "utf8")) : null;

    report({ step: "mux", progress: VIDEO_SHARE });
    await mkdir(dirname(output), { recursive: true });
    const muxProgress = (from: number, to: number) => (seconds: number) =>
      report({ step: "mux", progress: VIDEO_SHARE + (1 - VIDEO_SHARE) * (from + (to - from) * Math.min(1, seconds / plan.duration)) });
    if (plan.container === "gif") {
      // No sound to mix: the palette over every segment, then the GIF through it (ADR 0039).
      await run(paletteStep().args, muxProgress(0, 0.4));
      await run(gifStep(partial).args, muxProgress(0.4, 1));
    } else {
      const mux = muxStep(plan, measured, partial);
      await writeFiles(workDir, mux.files);
      await run(mux.args, muxProgress(0, 1));
    }
    await renameRetrying(partial, output);
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
    await rm(partial, { force: true });
    await rm(workDir, { recursive: true, force: true });
  }
}

/** Params of {@link ExportService.render}; see the daemon method `render`. */
export interface RenderRequest {
  timeline: string;
  preset?: string | undefined;
  quality?: "draft" | "final" | undefined;
  /** Absolute output file; with `formats`, `-<format>` goes before its extension. */
  out?: string | undefined;
  /** Absolute output path without extension, used when `out` is absent: the preset's container is added. Default `exports/<timeline>-<preset>`. */
  stem?: string | undefined;
  cover?: CoverChoice | undefined;
  formats?: readonly string[] | undefined;
  /** A file meant to repeat (ADR 0039); refused with `cover`. */
  loop?: boolean | undefined;
}

/** A render validated and compiled by {@link ExportService.planRender}, not queued yet. */
export interface PlannedRender {
  /** What `start` returns, without the jobs. */
  result: Omit<RenderResult, "job" | "renders"> & { renders: Omit<RenderResult["renders"][number], "job">[] };
  /** Placed assets without verified provenance (ADR 0026), also at the end of `result.warnings`. */
  provenance: string[];
  /** Queue one job per format; synchronous. */
  start(): RenderResult;
}

/** How a cover picks its frame and word; see the `cover` method. */
export interface CoverChoice {
  /** The word drawn over the frame; see the `cover` method. */
  text?: string | undefined;
  /** Timeline seconds. */
  at?: number | undefined;
  /** `#rrggbb`. */
  color?: string | undefined;
}

/** Options for {@link ExportService}. */
export interface ExportServiceOptions {
  jobs: JobQueue;
  /** Absolute ffmpeg for the project rooted at `root` (managed download or its `binaries` override). */
  ffmpeg(root: string): Promise<string>;
  /** ffprobe summary of a project-relative asset; see `MediaService.probe`. */
  probe(root: string, asset: string): Promise<MediaProbe>;
  /** Parsed timeline and project fps; see `TimelineService.load`. */
  loadTimeline(root: string, id: string): Promise<{ timeline: Timeline; fps: number }>;
  /**
   * Warnings about placed assets (project-relative paths) without usable provenance; see
   * `CreditsService.warnings`. Default: none.
   */
  provenance?(root: string, assets: string[]): Promise<string[]>;
  /**
   * Parsed nested timeline file (project-relative `source` of a `timeline`
   * clip); null when missing or invalid. Default: read the file.
   */
  readNested?(root: string, source: string): Promise<Timeline | null>;
  /**
   * Transcript of a project-relative asset (subtitle words); null when it
   * has none or it cannot be read. Default: `transcripts/<asset>.words.json`.
   */
  readTranscript?(root: string, asset: string): Promise<Transcript | null>;
  /** Presets contributed by the project's loaded plugins; see `PluginHost.presets`. */
  pluginPresets(root: string): Promise<ExportPresetInfo[]>;
  /**
   * Clip render cache (SPEC §3.5 step 2): `check` fails fast when a generated
   * clip has no adapter; `ensure` renders what is missing and returns every
   * render by clip id. Absent: timelines with generated clips cannot export.
   */
  clips?: {
    check(root: string, timeline: Timeline): Promise<void>;
    /** `size`: render at that frame size (a format other than the primary, ADR 0027); absent: the project resolution. */
    ensure(root: string, timeline: Timeline, onProgress?: (fraction: number) => void, size?: Size): Promise<ReadonlyMap<string, GeneratedSource>>;
  };
  /**
   * Audio effects bakes (ADR 0031): `needs` lists the bakes a flattened timeline plays, `ensure` bakes what is
   * missing and returns every bake by `bakeRef`. Absent: clips with audio effects export dry, with a warning.
   */
  audioFx?: {
    needs(timeline: Timeline): { ref: string }[];
    ensure(root: string, timeline: Timeline, onProgress?: (fraction: number) => void, signal?: AbortSignal): Promise<ReadonlyMap<string, string>>;
  };
  /**
   * Subject mattes (ADR 0032) of the assets subject layers play. `prepare` runs before any job, since an ingest may
   * need a slot of the shared queue. It returns the `assets` that can get a matte (those with a proxy) and `make`,
   * which makes their mattes still missing without taking a slot (a render job calls it) and returns every matte by
   * asset. Absent: subject layers are left out, with a warning.
   */
  mattes?: {
    prepare(
      root: string,
      assets: readonly string[],
    ): Promise<{ assets: readonly string[]; make(onProgress?: (fraction: number) => void, signal?: AbortSignal): Promise<ReadonlyMap<string, MatteSource>> }>;
  };
  /** H.264 encoder for renders that ask for a quality tier: the first that works on this machine. Absent: x264. */
  encoder?(ffmpeg: string): Promise<EncoderName>;
  /** See {@link ExecuteRenderOptions.parallelism}. */
  parallelism?: number;
  /** Video segment length in seconds; see {@link RenderInput.segmentSeconds}. */
  segmentSeconds?: number;
}

/**
 * Exports (SPEC §3.5): resolves preset and sources, compiles the plan up
 * front (so invalid timelines fail the request, not the job) and runs it on
 * the shared job queue. Also captures single frames with the same compiler.
 */
export class ExportService {
  readonly #options: ExportServiceOptions;

  constructor(options: ExportServiceOptions) {
    this.#options = options;
  }

  /** Built-in presets (plugin `null`) followed by plugin ones. */
  async presets(root: string): Promise<ExportPresetInfo[]> {
    const builtins = BUILTIN_PRESETS.map((preset) => ({ ...preset, plugin: null }));
    const ids = new Set(builtins.map((preset) => preset.id));
    // A plugin cannot redefine a built-in id: `youtube-1080p` means the same everywhere.
    const plugins = (await this.#options.pluginPresets(root)).filter((preset) => !ids.has(preset.id));
    return [...builtins, ...plugins];
  }

  /**
   * Validate and compile, then queue one render job per format (`formats`, ADR 0027; default the primary only).
   * Every format is checked and compiled before any job is queued. Returns at once.
   */
  async render(root: string, params: RenderRequest): Promise<RenderResult> {
    return (await this.planRender(root, params)).start();
  }

  /**
   * {@link ExportService.render} up to the queue: every format checked and compiled, nothing queued until `start`,
   * which queues the jobs synchronously (a job watcher can queue the next renders). `loaded`: the timeline to render
   * instead of the file (a batch row's variant, ADR 0040); formats still come from `frameshell.json` on disk.
   */
  async planRender(root: string, params: RenderRequest, loaded?: { timeline: Timeline; fps: number }): Promise<PlannedRender> {
    const config = (await readEnclosingProject(root))?.config;
    const project: FormatSource = config ?? { resolution: DEFAULT_RESOLUTION };
    const preset = await this.#preset(root, params.preset ?? config?.export?.defaultPreset ?? DEFAULT_PRESET_ID);
    // A GIF always repeats (ADR 0039): it gets the loop rules without being asked.
    const loop = params.loop === true || preset.container === "gif";
    const { timeline, fps } = await this.#resolved(root, params.timeline, loaded);
    const resolution = project.resolution;
    const formats = (params.formats ? [...new Set(params.formats)] : [undefined]).map((id) => {
      const found = resolveFormat(timeline, project, id);
      if (!found) throw formatNotFound(id!, project);
      return found.format;
    });
    const layered = generatedClipIds(timeline);
    if (layered.length > 0) await this.#options.clips?.check(root, timeline);
    const sources = await this.#sources(root, timeline);
    const matted = subjectAssets(timeline, (asset) => movingPicture(sources.get(asset)));
    const prepared = matted.length > 0 && this.#options.mattes ? await this.#options.mattes.prepare(root, matted) : null;
    const makeMattes = prepared?.make ?? null;
    // Only the assets that can get one: the plan's warnings name the others, as the final plan does.
    const standInMattes = new Map((prepared?.assets ?? []).map((asset) => [asset, { path: "", ...pictureSize(sources.get(asset)!) }]));
    const encoder = params.quality ? ((await this.#options.encoder?.(await this.#options.ffmpeg(root))) ?? "libx264") : null;
    const shared = {
      timeline,
      fps,
      ...(params.quality && encoder ? { encode: { encoder, tier: params.quality } } : {}),
      ...(loop ? { loop: true } : {}),
      resolution,
      loudness: loudnessTarget(preset, config?.export?.loudness),
      sources,
      transcripts: await this.#transcripts(root, timeline),
      ...(this.#options.segmentSeconds !== undefined ? { segmentSeconds: this.#options.segmentSeconds } : {}),
    };
    const baked = this.#options.audioFx?.needs(timeline) ?? [];
    const standInBakes = new Map(baked.map(({ ref }) => [ref, "stand-in.pcm"]));
    const base = params.out ?? `${params.stem ?? join(root, "exports", `${params.timeline}-${preset.id}`)}.${preset.container}`;
    const planned = await Promise.all(formats.map(async (format) => {
      const size = outputSize(preset, format, params.preset !== undefined, "render");
      const cover = params.cover ? await this.#coverFrame(root, timeline, fps, size, params.cover) : null;
      const input = {
        ...shared,
        preset: { ...preset, video: { ...preset.video, ...size } },
        variant: { cover: format.cover, captionScale: format.captionScale },
        ...(cover ? { cover: { at: cover.at, layout: cover.layout } } : {}),
      };
      const renderSize = format.primary ? undefined : { width: format.width, height: format.height };
      // Validated now with stand-in renders and bakes, so a bad timeline fails the request; the job compiles with the real ones.
      const standIn = this.#options.clips
        ? new Map(layered.map((id) => [id, { path: "", hasAlpha: true, width: format.width, height: format.height }]))
        : new Map<string, GeneratedSource>();
      const plan = compileRender({ ...input, generated: standIn, audioFx: standInBakes, mattes: standInMattes });
      const output = params.formats ? withSuffix(base, format.id) : base;
      // Before formats a configured default preset of another aspect letterboxed the project into its size.
      const overridden =
        params.preset === undefined && config?.export?.defaultPreset !== undefined && format.primary && preset.video.fit === undefined && !sameAspect(preset.video, format)
          ? [
              `Default preset ${preset.id} (export.defaultPreset) is ${preset.video.width}x${preset.video.height}, another aspect than format ` +
                `${format.id}: rendered at ${size.width}x${size.height} with its codec, bitrate and loudness (ADR 0027). For the preset's ` +
                "size, add and render the format of its aspect (`frameshell format add`).",
            ]
          : [];
      return { format, input, renderSize, plan, output, warnings: [...overridden, ...(cover?.warnings ?? []), ...plan.warnings] };
    }));
    const provenance = (await this.#options.provenance?.(root, [...sources.keys()])) ?? [];
    const first = planned[0]!;
    const result: PlannedRender["result"] = {
      format: first.format.id,
      renders: planned.map(({ format, plan, output, warnings }) => ({
        format: format.id,
        output,
        preset: preset.id,
        width: plan.width,
        height: plan.height,
        segments: plan.segments.length,
        warnings,
      })),
      output: first.output,
      preset: preset.id,
      quality: params.quality ?? null,
      encoder: encoder && preset.video.codec === "h264" ? encoder : presetEncoder(preset),
      timeline: params.timeline,
      duration: first.plan.duration,
      width: first.plan.width,
      height: first.plan.height,
      fps: first.plan.fps,
      loudness: first.plan.loudness,
      segments: first.plan.segments.length,
      warnings: [...first.warnings, ...provenance],
    };
    return {
      result,
      provenance,
      start: () => {
        const queued = planned.map(({ format, input, renderSize, plan, output, warnings }) => {
          const job = this.#options.jobs.enqueue({
            kind: "render",
            project: root,
            asset: `timelines/${params.timeline}.json`,
            output,
            run: async (ctx) => {
              let final = plan;
              let generated: ReadonlyMap<string, GeneratedSource> = new Map();
              let audioFx: ReadonlyMap<string, string> = new Map();
              if (layered.length > 0 && this.#options.clips) {
                ctx.update({ step: "clips", progress: 0 });
                generated = await this.#options.clips.ensure(root, timeline, (fraction) => ctx.update({ progress: fraction }), renderSize);
              }
              if (baked.length > 0 && this.#options.audioFx) {
                ctx.update({ step: "audio-fx", progress: 0 });
                audioFx = await this.#options.audioFx.ensure(root, timeline, (fraction) => ctx.update({ progress: fraction }), ctx.signal);
              }
              let mattes: ReadonlyMap<string, MatteSource> = new Map();
              if (makeMattes) {
                ctx.update({ step: "matte", progress: 0 });
                mattes = await makeMattes((fraction) => ctx.update({ progress: fraction }), ctx.signal);
              }
              if (generated.size > 0 || baked.length > 0 || makeMattes) final = compileRender({ ...input, generated, audioFx, mattes });
              const ffmpeg = await this.#options.ffmpeg(root);
              const cache = join(root, ".frameshell", "cache", "render");
              await executeRender(final, {
                ffmpeg,
                workDir: join(cache, randomBytes(6).toString("hex")),
                output,
                signal: ctx.signal,
                onProgress: (update: JobUpdate) => ctx.update(update),
                ...(this.#options.parallelism !== undefined ? { parallelism: this.#options.parallelism } : {}),
              });
              const bytes = preset.container === "gif" ? await stat(output).then((info) => info.size, () => 0) : 0;
              const sizeWarning = gifSizeWarning(bytes);
              if (sizeWarning) ctx.update({ warning: sizeWarning });
              if (loop) {
                // A diagnostic: a check that cannot run must not fail a render that succeeded.
                const warning = await loopSeamWarning(ffmpeg, output, final.frames, final, join(cache, `seam-${randomBytes(6).toString("hex")}`), ctx.signal).catch(
                  (error: unknown) => (ctx.signal.aborted ? null : `Loop: the seam check could not run: ${(error as Error).message}`),
                );
                if (warning) ctx.update({ warning });
              }
            },
          });
          return { format: format.id, job, output, preset: preset.id, width: plan.width, height: plan.height, segments: plan.segments.length, warnings };
        });
        return { ...result, renders: queued, job: queued[0]!.job };
      },
    };
  }

  /**
   * Capture one composited frame as an image, written atomically to `out`; the format defaults from its extension.
   * `loaded`: the timeline to capture instead of the file (a review-mode proposal's version).
   */
  async frame(
    root: string,
    params: {
      timeline: string;
      at: number;
      out: string;
      preset?: string | undefined;
      projectFormat?: string | undefined;
      format?: FrameFormat | undefined;
      quality?: number | undefined;
    },
    loaded?: { timeline: Timeline; fps: number },
  ): Promise<Omit<FrameResult, "view" | "proposal">> {
    return this.#capture(root, params, await this.#resolved(root, params.timeline, loaded));
  }

  /**
   * Every subtitle track of `loaded` with its style and cues (frames at the track's `fps`), as export burns them
   * (what `review` marks and measures on its sheets), at the size of project format `projectFormat` (the primary
   * when absent; an unknown one counts as the primary, `frame` refuses it); `loaded`: see {@link ExportService.frame}.
   */
  async resolvedSubtitles(
    root: string,
    loaded: { timeline: Timeline; fps: number },
    projectFormat?: string,
  ): Promise<ResolvedSubtitleTrack[]> {
    const { timeline, fps } = await this.#resolved(root, loaded.timeline.id, loaded);
    const transcripts = await this.#transcripts(root, timeline);
    const config = (await readEnclosingProject(root))?.config;
    const layout = resolveFormat(timeline, config ?? { resolution: DEFAULT_RESOLUTION }, projectFormat)?.format;
    return scaledCaptions(subtitleTracks(timeline, (asset) => transcripts.get(asset) ?? null, fps), layout);
  }

  /**
   * Write a cover image (see the `cover` method): the frame chosen by `at`, else by where `text` is first spoken,
   * else the first picture, with `text` drawn over it. `loaded`: see {@link ExportService.frame}.
   */
  async cover(
    root: string,
    params: CoverChoice & {
      timeline: string;
      out?: string | undefined;
      preset?: string | undefined;
      format?: FrameFormat | undefined;
      quality?: number | undefined;
    },
    loaded?: { timeline: Timeline; fps: number },
  ): Promise<Omit<CoverResult, "view" | "proposal">> {
    const size = params.preset ? (await this.#preset(root, params.preset)).video : ((await readEnclosingProject(root))?.config.resolution ?? DEFAULT_RESOLUTION);
    const resolved = await this.#resolved(root, params.timeline, loaded);
    const cover = await this.#coverFrame(root, resolved.timeline, resolved.fps, size, params);
    const out = params.out ?? join(root, "exports", `${params.timeline}-cover.png`);
    const shot = await this.#capture(
      root,
      { timeline: params.timeline, at: cover.at, out, preset: params.preset, format: params.format, quality: params.quality },
      resolved,
      cover.layout,
    );
    return {
      path: shot.path,
      format: shot.format,
      timeline: shot.timeline,
      frame: shot.frame,
      at: shot.at,
      source: cover.source,
      text: cover.layout?.text ?? null,
      readability: cover.readability,
      width: shot.width,
      height: shot.height,
      warnings: cover.warnings,
    };
  }

  /**
   * Which frame a cover shows and how its word is laid out in a `size` picture: `at` as given, else where `text` is
   * first spoken, else the first picture. A word nobody speaks falls back to the first picture with a warning.
   */
  async #coverFrame(
    root: string,
    timeline: Timeline,
    fps: number,
    size: Size,
    choice: CoverChoice,
  ): Promise<{
    at: number;
    source: CoverResult["source"];
    layout: CoverLayout | null;
    readability: CoverResult["readability"];
    warnings: string[];
  }> {
    const text = choice.text === undefined ? "" : coverText(choice.text);
    if (choice.text !== undefined && (text === "" || [...text].length > COVER_MAX_CHARS)) {
      throw new RpcError(
        ErrorCode.InvalidOperation,
        text === "" ? "The cover text has nothing to draw." : `The cover text is ${[...text].length} characters; at most ${COVER_MAX_CHARS}.`,
        { op: "cover", field: "text" },
      );
    }
    const warnings: string[] = [];
    let at = choice.at;
    let source: CoverResult["source"] = "at";
    if (at === undefined && text !== "") {
      const transcripts = await this.#transcripts(root, timeline, "all");
      at = hookWordTime(timeline, (asset) => transcripts.get(asset) ?? null, text, fps) ?? undefined;
      source = "word";
      if (at === undefined) warnings.push(`"${text}" is not spoken in any transcript of timeline ${timeline.id}: the cover uses the first picture. Pass \`at\` to choose the frame.`);
    }
    if (at === undefined) {
      at = firstPictureTime(timeline, fps);
      source = "default";
    }
    if (text === "") return { at, source, layout: null, readability: null, warnings };
    const metrics = await bundledFontMetrics();
    const layout = layoutCover(text, size, metrics, choice.color?.toLowerCase());
    const readability = coverReadability(layout, size, metrics);
    if (!readability.readable) {
      warnings.push(
        `"${text}" is ${readability.capHeight} px tall at ${readability.thumbnailWidth} px wide; ${readability.minCapHeight} px is the least that reads in a grid. Use a shorter word.`,
      );
    }
    return { at, source, layout, readability, warnings };
  }

  /** The `frame` capture of an already resolved timeline; `cover` (even null) marks a cover composition: no subtitles, its word over the picture. */
  async #capture(
    root: string,
    params: {
      timeline: string;
      at: number;
      out: string;
      preset?: string | undefined;
      projectFormat?: string | undefined;
      format?: FrameFormat | undefined;
      quality?: number | undefined;
    },
    resolved: { timeline: Timeline; fps: number },
    cover?: CoverLayout | null,
  ): Promise<Omit<FrameResult, "view" | "proposal">> {
    const format = params.format ?? frameFormatOf(params.out);
    const config = (await readEnclosingProject(root))?.config;
    const project: FormatSource = config ?? { resolution: DEFAULT_RESOLUTION };
    const resolution = project.resolution;
    const { timeline, fps } = resolved;
    const found = resolveFormat(timeline, project, params.projectFormat);
    if (!found) throw formatNotFound(params.projectFormat!, project);
    const shape = found.format;
    const size = params.preset ? outputSize(await this.#preset(root, params.preset), shape, true, "frame") : { width: shape.width, height: shape.height };
    const partial = join(dirname(params.out), `.${basename(params.out)}.partial-${randomBytes(4).toString("hex")}`);
    const renderSize = shape.primary ? undefined : { width: shape.width, height: shape.height };
    const generated =
      generatedClipIds(timeline).length > 0 && this.#options.clips ? await this.#options.clips.ensure(root, timeline, undefined, renderSize) : new Map();
    const sources = await this.#sources(root, timeline);
    const matted = subjectAssets(timeline, (asset) => movingPicture(sources.get(asset)), params.at);
    // Not in a job: the mattes of the subjects drawn at `at` are made here, as a render job would.
    const mattes = matted.length > 0 && this.#options.mattes ? await (await this.#options.mattes.prepare(root, matted)).make() : new Map<string, MatteSource>();
    const plan = compileFrame({
      timeline,
      fps,
      sources,
      transcripts: await this.#transcripts(root, timeline),
      resolution,
      generated,
      mattes,
      variant: { cover: shape.cover, captionScale: shape.captionScale },
      width: size.width,
      height: size.height,
      at: params.at,
      output: partial,
      format,
      ...(params.quality !== undefined ? { quality: params.quality } : {}),
      ...(cover !== undefined ? { cover } : {}),
    });
    const ffmpeg = await this.#options.ffmpeg(root);
    // Scratch cwd for the subtitle script and fonts the args name relatively.
    const workDir = join(root, ".frameshell", "cache", "frame", randomBytes(6).toString("hex"));
    await mkdir(dirname(params.out), { recursive: true });
    try {
      await mkdir(workDir, { recursive: true });
      await writeFiles(workDir, plan.files);
      await writeFonts(workDir, plan.fonts);
      await runTool(ffmpeg, plan.args, { cwd: workDir });
      await renameRetrying(partial, params.out);
    } finally {
      await rm(partial, { force: true });
      await rm(workDir, { recursive: true, force: true });
    }
    return {
      path: params.out,
      format,
      timeline: params.timeline,
      frame: plan.frame,
      at: plan.at,
      clip: plan.clip,
      projectFormat: shape.id,
      width: size.width,
      height: size.height,
    };
  }

  async #preset(root: string, id: string): Promise<ExportPreset> {
    const presets = await this.presets(root);
    const found = presets.find((preset) => preset.id === id);
    if (found) {
      const { plugin: _plugin, ...preset } = found;
      return preset as ExportPreset;
    }
    const available = presets.map((preset) => preset.id);
    throw new RpcError(
      ErrorCode.PresetNotFound,
      `No export preset "${id}". Available: ${available.join(", ")}. Plugins can add presets (\`frameshell plugin install <spec>\`).`,
      { preset: id, available },
    );
  }

  /**
   * The timeline with its nested timelines flattened (SPEC §3.5 step 1).
   * Unreadable nested files stay as `timeline` clips; the compiler refuses
   * them by name.
   */
  async #resolved(root: string, id: string, loaded?: { timeline: Timeline; fps: number }): Promise<{ timeline: Timeline; fps: number }> {
    const { timeline, fps } = loaded ?? (await this.#options.loadTimeline(root, id));
    const read = this.#options.readNested ?? readNestedFile;
    const seen = new Map<string, Timeline | null>();
    const flat = await resolveNested(
      root,
      timeline,
      async (at, source) => {
        const found = await read(at, source);
        seen.set(source, found);
        return found;
      },
      fps,
    );
    const hit = transformedProgram(timeline, (source) => seen.get(source) ?? null, [`timelines/${timeline.id}.json`]);
    if (hit) {
      const where = hit.timeline === timeline.id ? "" : ` --timeline ${hit.timeline}`;
      throw new RpcError(
        ErrorCode.ExportUnsupported,
        `Clip ${hit.clip} nests ${hit.source}, which shows multicam shots, and has a transform or keys (x, y, scale or opacity). ` +
          `Shots fill the frame and cannot be placed under a transform. Clear it: \`frameshell clip set ${hit.clip}${where} --x 0 --y 0 --scale 1 --opacity 1\`, ` +
          `and any keys of those: \`frameshell clip key ${hit.clip}${where} --prop <x|y|scale|opacity> --clear\`.`,
        { timeline: hit.timeline, clip: hit.clip },
      );
    }
    return { timeline: flat, fps };
  }

  /**
   * Transcripts of the assets subtitle tracks follow (`"followed"`) or of every media clip (`"all"`), by asset;
   * assets without one are absent.
   */
  async #transcripts(root: string, timeline: Timeline, which: "followed" | "all" = "followed"): Promise<Map<string, Transcript>> {
    const read = this.#options.readTranscript ?? readTranscriptFile;
    const found = new Map<string, Transcript>();
    const followed = new Set(timeline.tracks.flatMap((track) => (track.kind === "subtitles" ? [track.follows] : [])));
    for (const track of timeline.tracks) {
      if (track.kind === "subtitles" || (which === "followed" && !followed.has(track.id))) continue;
      for (const clip of track.clips) {
        if (clip.type !== "media" || !("asset" in clip) || found.has(clip.asset)) continue;
        const transcript = await read(root, clip.asset);
        if (transcript) found.set(clip.asset, transcript);
      }
    }
    return found;
  }

  /** Probe every asset the timeline's media clips use. Throws AssetNotFound for a missing one. */
  async #sources(root: string, timeline: Timeline): Promise<Map<string, ExportSource>> {
    const sources = new Map<string, ExportSource>();
    for (const track of timeline.tracks) {
      if (track.kind === "subtitles") continue;
      const assets =
        track.kind === "program" ? groupAssets(programGroup(timeline, track)) : track.clips.flatMap((clip) => ("asset" in clip ? [clip.asset] : []));
      for (const asset of assets) {
        if (sources.has(asset)) continue;
        const probe = await this.#options.probe(root, asset);
        sources.set(asset, {
          path: join(root, ...asset.split("/")),
          video: probe.video
            ? {
                codec: probe.video.codec,
                still: probe.video.still,
                width: probe.video.width,
                height: probe.video.height,
                ...(probe.video.alpha ? { alpha: true } : {}),
              }
            : null,
          audio: probe.audio !== null,
          ...(probe.duration !== null ? { duration: probe.duration } : {}),
        });
      }
    }
    return sources;
  }
}

/** ffmpeg encoder a preset's codec renders with when no quality tier is asked for. */
function presetEncoder(preset: ExportPreset): string {
  return { h264: "libx264", h265: "libx265", vp9: "libvpx-vp9", prores: "prores_ks", gif: "gif" }[preset.video.codec];
}

/** Files of a multicam group: the cameras and the separate mics. */
function groupAssets(group: MulticamGroup | null): string[] {
  return group ? [...group.angles.map((angle) => angle.asset), ...(group.mics ?? []).map((mic) => mic.asset)] : [];
}

/** Image format a `frame` output path asks for by its extension; `png` when it names none. */
export function frameFormatOf(path: string): FrameFormat {
  const ext = extname(path).toLowerCase();
  return ext === ".jpg" || ext === ".jpeg" ? "jpg" : ext === ".webp" ? "webp" : "png";
}

/**
 * Assets the shown subject layers of `timeline` (flattened) play that `moving` says have a moving picture: each needs a
 * matte to export or preview (ADR 0032), in track then time order of its first subject clip. With `at`, only those a
 * subject is drawn with near that timeline second (a frame capture).
 */
export function subjectAssets(timeline: Timeline, moving: (asset: string) => boolean, at?: number): string[] {
  const found = new Set<string>();
  for (const track of timeline.tracks) {
    if (track.kind !== "video" || !showsPicture(track)) continue;
    for (const clip of track.clips) {
      const mark = subjectOf(clip);
      if (!mark || !("asset" in clip) || !moving(clip.asset)) continue;
      const speed = clip.speed ?? 1;
      const time = (source: number) => clip.start + (source - clip.in) / speed;
      // A tenth of a second each side covers the snap of `at` to its frame: a matte too many costs time, one too few drops the subject.
      if (at === undefined || mark.windows.some(([a, b]) => time(a) - 0.1 <= at && at < time(b) + 0.1)) found.add(clip.asset);
    }
  }
  return [...found];
}

/** True for a source with a moving picture (not audio only, not a still). */
function movingPicture(source: ExportSource | undefined): boolean {
  return source?.video !== null && source?.video !== undefined && !source.video.still;
}

/** Picture size of a source with a picture. */
function pictureSize(source: ExportSource): Size {
  return { width: source.video!.width, height: source.video!.height };
}

/** Ids of the generated (adapter) clips on video tracks: each needs a cached render to export. */
function generatedClipIds(timeline: Timeline): string[] {
  return timeline.tracks.flatMap((track) =>
    track.kind === "video" ? track.clips.filter((clip) => clip.type !== "media" && clip.type !== "timeline").map((clip) => clip.id) : [],
  );
}

/**
 * Output size of `format` with `preset` (ADR 0027 decision 4): the format owns the frame, the preset its codec,
 * bitrate and loudness. A preset of the format's aspect sets the size when it was asked for (`explicit`) or the
 * format is the primary one, so exports made before formats existed keep their size. An explicit preset of
 * another aspect is refused; a default one is then rendered at the format's size.
 */
function outputSize(preset: ExportPreset, format: ResolvedFormat, explicit: boolean, op: "render" | "frame"): Size {
  const presetSize = { width: preset.video.width, height: preset.video.height };
  if (preset.video.fit === "inside") return fitInside(presetSize, format);
  if (sameAspect(presetSize, format)) return explicit || format.primary ? presetSize : { width: format.width, height: format.height };
  if (!explicit) return { width: format.width, height: format.height };
  const id = BUILTIN_FORMAT_IDS.find((builtin) => sameAspect(BUILTIN_FORMATS[builtin]!, presetSize)) ?? `${presetSize.width}x${presetSize.height}`;
  const add = BUILTIN_FORMATS[id] ? `frameshell format add ${id}` : `frameshell format add ${id} --size ${id}`;
  throw new RpcError(
    ErrorCode.InvalidOperation,
    `Preset ${preset.id} is ${presetSize.width}x${presetSize.height}, another aspect than format ${format.id} (${format.width}x${format.height}). ` +
      "The format owns the frame; a preset only gives codec, bitrate and loudness. Leave the preset out, pick one of the " +
      `format's aspect, or render the format the preset is made for: \`${add}\`, then ` +
      (op === "render" ? `\`frameshell render --formats ${id}\`.` : `\`frameshell frame --format ${id}\`.`),
    { op, reason: "preset aspect", field: "preset", hint: `Leave the preset out, or add and render format ${id} (\`format.add\`).` },
  );
}

/** `path` with `-<suffix>` before its extension: `exports/main.mp4` → `exports/main-9x16.mp4`. */
function withSuffix(path: string, suffix: string): string {
  const ext = extname(path);
  return `${path.slice(0, path.length - ext.length)}-${suffix}${ext}`;
}

/** Frame size when `frameshell.json` has none (SPEC §5.2 default). */
const DEFAULT_RESOLUTION: Size = { width: 1920, height: 1080 };

/** The asset's transcript file (the one `transcribe` writes); null when missing, broken or owned by another asset. */
export async function readTranscriptFile(root: string, asset: string): Promise<Transcript | null> {
  try {
    return (await resolveTranscript(root, asset)).previous;
  } catch (error) {
    if (error instanceof RpcError) return null;
    throw error;
  }
}

/** Half the cores, 1 to 4: each x264 already threads, and ingest may run alongside. */
function defaultParallelism(): number {
  return Math.max(1, Math.min(4, Math.floor(availableParallelism() / 2)));
}

async function writeFiles(dir: string, files: Record<string, string>): Promise<void> {
  for (const [name, content] of Object.entries(files)) await writeFile(join(dir, name), content);
}

/** Run `work` on every item, at most `limit` at once. Rejects with the first failure, after in-flight work settles. */
export async function pool<T>(items: readonly T[], limit: number, work: (item: T, index: number) => Promise<void>): Promise<void> {
  let next = 0;
  let failure: { error: unknown } | undefined;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (!failure && next < items.length) {
      const index = next++;
      try {
        await work(items[index]!, index);
      } catch (error) {
        failure ??= { error };
      }
    }
  });
  await Promise.all(workers);
  if (failure) throw failure.error;
}

/** `30000/1001` → 29.97. */
function rational(value: string): number {
  const [num, den] = value.split("/").map(Number);
  return num! / (den ?? 1);
}
