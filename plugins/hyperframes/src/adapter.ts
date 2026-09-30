import { cp, readdir } from "node:fs/promises";
import { basename, dirname, extname, join, posix } from "node:path";
import type { ClipAdapter, PropsSchema, PropsValidation, RenderContext } from "@frameshell/plugin-api";

/** Clip type this adapter registers. */
export const CLIP_TYPE = "hyperframes";

/** The part of `@hyperframes/producer` the adapter calls (in-process render, ADR 0002). */
export interface Producer {
  createRenderJob(config: {
    fps: number;
    quality: "draft" | "standard" | "high";
    format: "webm";
    entryFile: string;
    variables: Record<string, unknown>;
  }): unknown;
  executeRenderJob(
    job: unknown,
    projectDir: string,
    outputPath: string,
    onProgress?: (job: { progress?: number }, message: string) => void | Promise<void>,
    signal?: AbortSignal,
  ): Promise<void>;
}

/** Options for {@link createHyperframesAdapter}. */
export interface HyperframesAdapterOptions {
  /** Project the plugin is loaded for; clip `source` paths are relative to it. */
  projectDir: string;
  /** Loads the producer; default imports `@hyperframes/producer` on first render (it is large). */
  producer?: () => Promise<Producer>;
}

/** Timeline clip fields the adapter reads. */
interface HyperframesClip {
  id: string;
  source?: string;
  props?: Record<string, unknown>;
}

/**
 * `props` are HyperFrames composition variables: a JSON object, merged over
 * the defaults the composition declares (`data-composition-variables`).
 */
export const propsSchema: PropsSchema = {
  "~standard": {
    version: 1,
    vendor: "frameshell-hyperframes",
    validate(value: unknown): PropsValidation {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return { issues: [{ message: "props must be a JSON object of composition variables, e.g. { \"title\": \"Launch\" }" }] };
      }
      if (!isPlainJson(value)) return { issues: [{ message: "props must be plain JSON (strings, numbers, booleans, null, arrays, objects)" }] };
      return { value };
    },
  },
};

/** Directories inside a composition that never feed its pixels. */
const SKIPPED_DIRS = new Set(["node_modules"]);

/**
 * The `hyperframes` clip adapter (SPEC §8.2, ADR 0002). A clip's `source` is
 * the composition's entry HTML; its directory is the composition, and every
 * file in it is a cache input, so editing any of them re-renders the clip.
 * Renders run in-process with `@hyperframes/producer` to VP9 WebM with alpha,
 * with the managed ffmpeg, ffprobe and headless Chrome.
 */
export function createHyperframesAdapter(options: HyperframesAdapterOptions): ClipAdapter {
  const { projectDir } = options;
  const loadProducer = options.producer ?? (async () => (await import("@hyperframes/producer")) as unknown as Producer);
  return {
    type: CLIP_TYPE,
    propsSchema,
    async inputs(clip) {
      const { source } = clip as HyperframesClip;
      if (!source) return [];
      const dir = posix.dirname(source);
      return (await listFiles(join(projectDir, ...dir.split("/")))).map((file) => (dir === "." ? file : `${dir}/${file}`));
    },
    async render(clip, ctx: RenderContext) {
      const { id, source, props } = clip as HyperframesClip;
      if (!source || extname(source).toLowerCase() !== ".html") {
        throw new Error(
          `hyperframes clip ${id} needs \`source\`: the composition's HTML entry, e.g. compositions/hyperframes/intro/index.html ` +
            "(create one with `frameshell hyperframes new intro`).",
        );
      }
      const [ffmpeg, ffprobe, chrome] = await Promise.all([
        ctx.ensureBinary("ffmpeg"),
        ctx.ensureBinary("ffprobe"),
        ctx.ensureBinary("chrome-headless-shell"),
      ]);
      // The producer reads these on every render (ADR 0002): managed binaries, never PATH or puppeteer's cache.
      process.env["HYPERFRAMES_FFMPEG_PATH"] = ffmpeg;
      process.env["HYPERFRAMES_FFPROBE_PATH"] = ffprobe;
      process.env["PRODUCER_HEADLESS_SHELL_PATH"] = chrome;
      // Render a copy: the producer may write scratch files next to the entry, which would count as composition edits.
      const composition = join(ctx.outDir, "composition");
      await cp(join(projectDir, ...dirname(source).split("/")), composition, { recursive: true });
      const output = join(ctx.outDir, "render.webm");
      const producer = await loadProducer();
      ctx.progress({ fraction: 0, message: "Starting headless Chrome" });
      const job = producer.createRenderJob({
        fps: ctx.fps,
        quality: "standard",
        format: "webm",
        entryFile: basename(source),
        variables: props ?? {},
      });
      await producer.executeRenderJob(
        job,
        composition,
        output,
        (state, message) => ctx.progress({ fraction: Math.min(1, Math.max(0, (state.progress ?? 0) / 100)), message }),
        ctx.signal,
      );
      return { file: output, hasAlpha: true };
    },
  };
}

/** True for values that survive JSON unchanged: the producer injects them into the page as JSON. */
function isPlainJson(value: unknown): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isPlainJson);
  if (typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return (proto === Object.prototype || proto === null) && Object.values(value).every(isPlainJson);
}

/** Files under `dir`, `/`-separated and sorted, skipping dot entries and {@link SKIPPED_DIRS}; [] when missing. */
async function listFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    if (entry.isDirectory()) {
      if (SKIPPED_DIRS.has(entry.name)) continue;
      files.push(...(await listFiles(join(dir, entry.name))).map((file) => `${entry.name}/${file}`));
    } else if (entry.isFile()) {
      files.push(entry.name);
    }
  }
  return files.sort();
}
