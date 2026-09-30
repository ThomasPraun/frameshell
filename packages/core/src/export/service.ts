import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  ErrorCode,
  type ExportPresetInfo,
  type FrameResult,
  type MediaProbe,
  type RenderResult,
  RpcError,
} from "@frameshell/protocol";
import { type ExportPreset, type Size, type Timeline, type Transcript, flattenTimeline } from "@frameshell/schema";
import type { JobQueue, JobUpdate } from "../jobs/queue.js";
import { runTool } from "../media/ffmpeg.js";
import { readEnclosingProject } from "../projects.js";
import { readTimelineFile } from "../timeline/service.js";
import { resolveTranscript } from "../transcripts/transcriber.js";
import {
  type ExportSource,
  LOUDNESS_STATS_FILE,
  type RenderPlan,
  compileFrame,
  compileRender,
  loudnessAnalysis,
  mixStep,
  muxStep,
  parseLoudnessStats,
} from "./compiler.js";
import { writeFonts } from "./fonts.js";
import { BUILTIN_PRESETS, DEFAULT_PRESET_ID, loudnessTarget } from "./presets.js";

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
    const mux = muxStep(plan, measured, partial);
    await writeFiles(workDir, mux.files);
    await mkdir(dirname(output), { recursive: true });
    await run(mux.args, (seconds) => report({ step: "mux", progress: VIDEO_SHARE + (1 - VIDEO_SHARE) * Math.min(1, seconds / plan.duration) }));
    await rename(partial, output);
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
    await rm(partial, { force: true });
    await rm(workDir, { recursive: true, force: true });
  }
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

  /** Validate and compile, then queue the render job. Returns at once. */
  async render(root: string, params: { timeline: string; preset?: string | undefined; out?: string | undefined }): Promise<RenderResult> {
    const config = (await readEnclosingProject(root))?.config;
    const preset = await this.#preset(root, params.preset ?? config?.export?.defaultPreset ?? DEFAULT_PRESET_ID);
    const { timeline, fps } = await this.#resolved(root, params.timeline);
    const plan = compileRender({
      timeline,
      fps,
      preset,
      resolution: config?.resolution ?? DEFAULT_RESOLUTION,
      loudness: loudnessTarget(preset, config?.export?.loudness),
      sources: await this.#sources(root, timeline),
      transcripts: await this.#transcripts(root, timeline),
      ...(this.#options.segmentSeconds !== undefined ? { segmentSeconds: this.#options.segmentSeconds } : {}),
    });
    const output = params.out ?? join(root, "exports", `${params.timeline}-${preset.id}.${preset.container}`);
    const job = this.#options.jobs.enqueue({
      kind: "render",
      project: root,
      asset: `timelines/${params.timeline}.json`,
      output,
      run: async (ctx) => {
        await executeRender(plan, {
          ffmpeg: await this.#options.ffmpeg(root),
          workDir: join(root, ".frameshell", "cache", "render", randomBytes(6).toString("hex")),
          output,
          signal: ctx.signal,
          onProgress: (update: JobUpdate) => ctx.update(update),
          ...(this.#options.parallelism !== undefined ? { parallelism: this.#options.parallelism } : {}),
        });
      },
    });
    return {
      job,
      output,
      preset: preset.id,
      timeline: params.timeline,
      duration: plan.duration,
      width: plan.width,
      height: plan.height,
      fps: plan.fps,
      loudness: plan.loudness,
      segments: plan.segments.length,
      warnings: plan.warnings,
    };
  }

  /** Capture one composited frame as PNG, written atomically to `out`. */
  async frame(root: string, params: { timeline: string; at: number; out: string; preset?: string | undefined }): Promise<FrameResult> {
    const config = (await readEnclosingProject(root))?.config;
    const resolution = config?.resolution ?? DEFAULT_RESOLUTION;
    const size = params.preset ? (await this.#preset(root, params.preset)).video : resolution;
    const { timeline, fps } = await this.#resolved(root, params.timeline);
    const partial = join(dirname(params.out), `.${basename(params.out)}.partial-${randomBytes(4).toString("hex")}`);
    const plan = compileFrame({
      timeline,
      fps,
      sources: await this.#sources(root, timeline),
      transcripts: await this.#transcripts(root, timeline),
      resolution,
      width: size.width,
      height: size.height,
      at: params.at,
      output: partial,
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
      await rename(partial, params.out);
    } finally {
      await rm(partial, { force: true });
      await rm(workDir, { recursive: true, force: true });
    }
    return {
      path: params.out,
      timeline: params.timeline,
      frame: plan.frame,
      at: plan.at,
      clip: plan.clip,
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
  async #resolved(root: string, id: string): Promise<{ timeline: Timeline; fps: number }> {
    const { timeline, fps } = await this.#options.loadTimeline(root, id);
    const read = this.#options.readNested ?? readNestedFile;
    const nested = new Map<string, Timeline | null>();
    const pending = [timeline];
    // Read every file the nesting reaches once; flattenTimeline itself stops cycles.
    while (pending.length > 0) {
      for (const track of pending.pop()!.tracks) {
        if (track.kind === "subtitles") continue;
        for (const clip of track.clips) {
          if (clip.type !== "timeline" || !("source" in clip) || !clip.source || nested.has(clip.source)) continue;
          const found = await read(root, clip.source);
          nested.set(clip.source, found);
          if (found) pending.push(found);
        }
      }
    }
    return { timeline: flattenTimeline(timeline, (source) => nested.get(source) ?? null), fps };
  }

  /** Transcripts of the assets subtitle tracks follow, by asset; assets without one are absent. */
  async #transcripts(root: string, timeline: Timeline): Promise<Map<string, Transcript>> {
    const read = this.#options.readTranscript ?? readTranscriptFile;
    const found = new Map<string, Transcript>();
    const followed = new Set(timeline.tracks.flatMap((track) => (track.kind === "subtitles" ? [track.follows] : [])));
    for (const track of timeline.tracks) {
      if (track.kind === "subtitles" || !followed.has(track.id)) continue;
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
      for (const clip of track.clips) {
        if (!("asset" in clip) || sources.has(clip.asset)) continue;
        const probe = await this.#options.probe(root, clip.asset);
        sources.set(clip.asset, {
          path: join(root, ...clip.asset.split("/")),
          video: probe.video
            ? { codec: probe.video.codec, still: probe.video.still, width: probe.video.width, height: probe.video.height }
            : null,
          audio: probe.audio !== null,
        });
      }
    }
    return sources;
  }
}

/** Frame size when `frameshell.json` has none (SPEC §5.2 default). */
const DEFAULT_RESOLUTION: Size = { width: 1920, height: 1080 };

/** The asset's transcript file (the one `transcribe` writes); null when missing, broken or owned by another asset. */
async function readTranscriptFile(root: string, asset: string): Promise<Transcript | null> {
  try {
    return (await resolveTranscript(root, asset)).previous;
  } catch (error) {
    if (error instanceof RpcError) return null;
    throw error;
  }
}

async function readNestedFile(root: string, source: string): Promise<Timeline | null> {
  try {
    return await readTimelineFile(root, source);
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
async function pool<T>(items: readonly T[], limit: number, work: (item: T, index: number) => Promise<void>): Promise<void> {
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
