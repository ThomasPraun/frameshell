import { cp, readFile, readdir, realpath } from "node:fs/promises";
import { basename, extname, isAbsolute, join, posix, relative, resolve, sep, win32 } from "node:path";
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
 * the defaults the composition declares (`data-composition-variables`, an
 * array of `{id, type, label, default}`).
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
      const dir = await compositionDir(projectDir, clip as HyperframesClip & { source: string });
      return (await listFiles(dir.path)).map((file) => (dir.rel === "" ? file : `${dir.rel}/${file}`));
    },
    async render(clip, ctx: RenderContext) {
      const { id, source, props } = clip as HyperframesClip;
      if (!source || extname(source).toLowerCase() !== ".html") {
        throw new Error(
          `hyperframes clip ${id} needs \`source\`: the composition's HTML entry, e.g. compositions/hyperframes/intro/index.html ` +
            "(create one with `frameshell hyperframes new intro`).",
        );
      }
      const dir = await compositionDir(projectDir, { id, source });
      await refuseObjectDeclarations(id, dir);
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
      await cp(dir.path, composition, { recursive: true });
      const output = join(ctx.outDir, "render.webm");
      const producer = await loadProducer();
      ctx.progress({ fraction: 0, message: "Starting headless Chrome" });
      const job = producer.createRenderJob({
        fps: ctx.fps,
        quality: "standard",
        format: "webm",
        entryFile: basename(source),
        // Overrides only: the page runtime merges them over the declared defaults; `{}` keeps every default.
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

/** `data-composition-variables` attribute, single- or double-quoted value. */
const DECLARATION_ATTR = /\sdata-composition-variables\s*=\s*(?:'([^']*)'|"([^"]*)")/gi;

/**
 * Throws when an HTML file of the composition declares
 * `data-composition-variables` as a JSON object (`{"title":"Title"}`).
 * HyperFrames reads only an array of `{id, type, label, default}`
 * declarations and silently ignores anything else, so the defaults would
 * never reach `getVariables()` (#116). The error carries the array to use.
 * Unparsable values are left to the producer.
 */
async function refuseObjectDeclarations(id: string, dir: { path: string; rel: string }): Promise<void> {
  for (const file of (await listFiles(dir.path)).filter((f) => extname(f).toLowerCase() === ".html")) {
    const html = await readFile(join(dir.path, ...file.split("/")), "utf8").catch(() => "");
    for (const match of html.matchAll(DECLARATION_ATTR)) {
      const raw = match[1] ?? decodeEntities(match[2] ?? "");
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        continue;
      }
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) continue;
      const declarations = Object.entries(parsed).map(([name, value]) => ({
        id: name,
        type: typeof value === "number" ? "number" : typeof value === "boolean" ? "boolean" : "string",
        label: name,
        default: value,
      }));
      const path = dir.rel === "" ? file : `${dir.rel}/${file}`;
      throw new Error(
        `hyperframes clip ${id}: ${path} declares data-composition-variables as an object, which HyperFrames ignores, ` +
          `so its defaults never apply. Declare an array of {id, type, label, default} instead: ` +
          `data-composition-variables='${JSON.stringify(declarations)}'`,
      );
    }
  }
}

/** Decodes the entities a double-quoted HTML attribute value can carry around JSON. */
function decodeEntities(value: string): string {
  return value
    .replace(/&quot;|&#34;|&#x22;/gi, '"')
    .replace(/&apos;|&#39;|&#x27;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&");
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

/**
 * Composition directory of `clip.source`: absolute `path` and project-relative,
 * `/`-separated `rel` (`""` = project root). Throws when the source is absolute,
 * contains `\`, or resolves (lexically or through symlinks) outside `projectDir`:
 * the whole directory is walked and copied, and the renderer never hashes
 * outside inputs, so such a clip would read foreign files and never re-render.
 */
async function compositionDir(projectDir: string, clip: { id: string; source: string }): Promise<{ path: string; rel: string }> {
  const { id, source } = clip;
  const refuse = (): never => {
    throw new Error(
      `hyperframes clip ${id} has source ${source}, outside the project ${projectDir}. ` +
        "Use a project-relative path, e.g. compositions/hyperframes/intro/index.html.",
    );
  };
  if (source.includes("\\") || posix.isAbsolute(source) || win32.isAbsolute(source)) refuse();
  const path = resolve(projectDir, ...posix.dirname(source).split("/"));
  const rel = relative(projectDir, path);
  if (escapes(rel)) refuse();
  const real = await realpath(path).catch(() => null);
  if (real !== null && escapes(relative(await realpath(projectDir), real))) refuse();
  return { path, rel: rel.split(sep).join("/") };
}

/** True when a `relative()` result leaves its base. */
function escapes(rel: string): boolean {
  return rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
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
