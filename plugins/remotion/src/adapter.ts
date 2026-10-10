import { stat } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { join, posix, resolve, win32 } from "node:path";
import type { ClipAdapter, PropsSchema, PropsValidation, RenderContext } from "@frameshell/plugin-api";
import { BundleCache } from "./bundles.js";
import { type RemotionComposition, type RemotionLoader, type RemotionRenderer, findRemotionRoot, loadProjectRemotion } from "./remotion.js";

/** Clip type this adapter registers. */
export const CLIP_TYPE = "remotion";

/** Options for {@link createRemotionAdapter}. */
export interface RemotionAdapterOptions {
  /** Project the plugin is loaded for; clip `source` paths are relative to it. */
  projectDir: string;
  /** Loads the Remotion packages of a Remotion project; default resolves them from that project (ADR 0009). */
  loadRemotion?: RemotionLoader;
  /** Ask the host to re-check render keys; called when code outside the project that a bundle includes changes. */
  refreshRenders?: () => void;
}

/** Validated clip `props`. */
export interface RemotionProps {
  /** Composition id, as registered with `<Composition id=…>`. */
  composition: string;
  /** Input props of the composition, merged by Remotion over its `defaultProps`. */
  inputProps?: Record<string, unknown>;
}

/** Timeline clip fields the adapter reads. */
interface RemotionClip {
  id: string;
  source?: string;
  props?: RemotionProps;
}

/** Remotion's composition id rule: letters, digits, `-` and CJK long vowel marks. */
const COMPOSITION_ID = /^[a-zA-Z0-9぀-ヿ一-鿿-]+$/;

/**
 * `props` = `{ composition, inputProps? }`: which composition of the entry
 * to render, and its input props (plain JSON, merged over its `defaultProps`).
 */
export const propsSchema: PropsSchema = {
  "~standard": {
    version: 1,
    vendor: "frameshell-remotion",
    validate(value: unknown): PropsValidation {
      const example = '{ "composition": "Intro", "inputProps": { "title": "Launch" } }';
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return { issues: [{ message: `props must be an object naming the composition, e.g. ${example}` }] };
      }
      const { composition, inputProps, ...rest } = value as Record<string, unknown>;
      const issues: { message: string; path?: string[] }[] = [];
      if (typeof composition !== "string" || !COMPOSITION_ID.test(composition)) {
        issues.push({ message: `composition must be the id of a <Composition> in the entry, e.g. ${example}`, path: ["composition"] });
      }
      if (inputProps !== undefined && (typeof inputProps !== "object" || inputProps === null || Array.isArray(inputProps) || !isPlainJson(inputProps))) {
        issues.push({ message: "inputProps must be a plain JSON object (strings, numbers, booleans, null, arrays, objects)", path: ["inputProps"] });
      }
      for (const key of Object.keys(rest)) {
        issues.push({ message: `unknown prop ${key}: composition props go inside inputProps, e.g. ${example}`, path: [key] });
      }
      return issues.length > 0 ? { issues } : { value };
    },
  },
};

/**
 * The `remotion` clip adapter (ADR 0009). A clip's `source` is the entry
 * file of a Remotion project (the file that calls `registerRoot`), relative
 * to the Frameshell project; the Remotion project may sit outside it, and
 * its code may import from anywhere. The cache input is the entry's current
 * webpack bundle, so any change to bundled code re-renders. Renders run with
 * the project's own `@remotion/renderer`, the managed headless Chrome, at
 * the project's fps and resolution, to VP9 WebM with alpha.
 */
export function createRemotionAdapter(options: RemotionAdapterOptions): ClipAdapter & { close(): void } {
  const { projectDir } = options;
  const bundles = new BundleCache({
    projectDir,
    loadRemotion: options.loadRemotion ?? loadProjectRemotion,
    findRoot: (entry) => findRemotionRoot(join(entry, "..")),
    ...(options.refreshRenders ? { onOutsideChange: options.refreshRenders } : {}),
  });
  return {
    type: CLIP_TYPE,
    propsSchema,
    async inputs(clip) {
      const entry = await entryOf(projectDir, clip as RemotionClip);
      return [(await bundles.get(entry)).marker];
    },
    async render(clip, ctx: RenderContext) {
      const { id, props } = clip as RemotionClip;
      if (!props) throw new Error(`remotion clip ${id} needs props naming its composition, e.g. { "composition": "Intro" }`);
      const entry = await entryOf(projectDir, clip as RemotionClip);
      const chrome = await ctx.ensureBinary("chrome-headless-shell");
      ctx.progress({ fraction: 0, message: "Bundling" });
      // The bundle `inputs` keyed: unchanged unless code changed since, and then the next refresh renders again.
      const bundle = await bundles.get(entry, (fraction) => ctx.progress({ fraction: fraction * 0.05, message: "Bundling" }));
      const { renderer } = bundle.remotion;
      const inputProps = props.inputProps ?? {};
      const chromiumOptions = bundle.remotion.config.gl ? { gl: bundle.remotion.config.gl } : {};
      const browser = { browserExecutable: chrome, chromeMode: "headless-shell" as const, chromiumOptions, logLevel: "error" as const };
      ctx.progress({ fraction: 0.05, message: "Starting headless Chrome" });
      const selected = await renderer.selectComposition({ serveUrl: bundle.dir, id: props.composition, inputProps, ...browser }).catch(async (error: unknown) => {
        throw await unknownComposition(error, renderer, { serveUrl: bundle.dir, id: props.composition, inputProps, browserExecutable: chrome, chromiumOptions }, id);
      });
      const { composition, scale } = fitToProject(selected, ctx);
      const { cancelSignal, cancel } = renderer.makeCancelSignal();
      if (ctx.signal.aborted) cancel();
      ctx.signal.addEventListener("abort", cancel, { once: true });
      const output = join(ctx.outDir, "render.webm");
      try {
        await renderer.renderMedia({
          composition,
          serveUrl: bundle.dir,
          codec: "vp9",
          imageFormat: "png",
          pixelFormat: "yuva420p",
          outputLocation: output,
          inputProps,
          ...browser,
          muted: true,
          overwrite: true,
          scale,
          cancelSignal,
          onProgress: ({ progress }) => ctx.progress({ fraction: 0.05 + 0.95 * Math.min(1, Math.max(0, progress)), message: "Rendering" }),
          ffmpegOverride: ({ type, args }) => (type === "stitcher" ? fastVp9(args) : args),
        });
      } finally {
        ctx.signal.removeEventListener("abort", cancel);
      }
      ctx.progress({ fraction: 1, message: "Done" });
      return { file: output, hasAlpha: true };
    },
    close: () => bundles.close(),
  };
}

/**
 * Absolute entry of `clip.source`. Relative paths may leave the project (a
 * Remotion project next to it): the bundle, not the path, keys the render.
 * Throws when `source` is missing, absolute, uses `\`, or is not a file.
 */
async function entryOf(projectDir: string, clip: RemotionClip): Promise<string> {
  const { id, source } = clip;
  const example = "compositions/remotion/src/index.ts";
  if (!source) throw new Error(`remotion clip ${id} needs \`source\`: the Remotion entry file that calls registerRoot, e.g. ${example}`);
  if (source.includes("\\") || posix.isAbsolute(source) || win32.isAbsolute(source)) {
    throw new Error(`remotion clip ${id} has source ${source}; use a /-separated path relative to the project, e.g. ${example} or ../web/video/src/index.ts`);
  }
  const entry = resolve(projectDir, ...source.split("/"));
  if (!(await stat(entry).then((info) => info.isFile(), () => false))) {
    throw new Error(`remotion clip ${id}: ${source} does not exist. Create a Remotion project with \`frameshell remotion new <name>\`, or fix source.`);
  }
  return entry;
}

/**
 * The composition at the project's fps, same length in seconds. Same aspect
 * ratio: rendered at its own size and scaled to the project's, so pixel
 * layouts keep their proportions. Other aspect: rendered at the project's
 * size, which the composition sees through `useVideoConfig()`.
 */
export function fitToProject(selected: RemotionComposition, format: { fps: number; width: number; height: number }): { composition: RemotionComposition; scale: number } {
  const seconds = selected.durationInFrames / selected.fps;
  const timing = { fps: format.fps, durationInFrames: Math.max(1, Math.round(seconds * format.fps)) };
  const sameAspect = Math.abs(selected.width * format.height - selected.height * format.width) < 1e-6 * selected.width * format.height;
  if (sameAspect) return { composition: { ...selected, ...timing }, scale: format.width / selected.width };
  return { composition: { ...selected, ...timing, width: format.width, height: format.height }, scale: 1 };
}

/**
 * Stitcher arguments with multithreaded libvpx, inserted before the output
 * path. Remotion's single-threaded default made an 8 s 1440p clip take 66 s
 * instead of 13 s, with the same alpha (ADR 0009).
 */
export function fastVp9(args: string[]): string[] {
  const threads = String(Math.min(16, Math.max(1, availableParallelism())));
  return [...args.slice(0, -1), "-row-mt", "1", "-threads", threads, "-deadline", "good", "-cpu-used", "4", ...args.slice(-1)];
}

/** The `selectComposition` error, naming the entry's compositions when `id` is not one of them. */
async function unknownComposition(
  error: unknown,
  renderer: RemotionRenderer,
  wanted: { serveUrl: string; id: string; inputProps: Record<string, unknown>; browserExecutable: string; chromiumOptions: { gl?: string } },
  clip: string,
): Promise<Error> {
  const { serveUrl, id, inputProps, browserExecutable, chromiumOptions } = wanted;
  const ids = await renderer
    .getCompositions(serveUrl, { inputProps, browserExecutable, chromeMode: "headless-shell", chromiumOptions, logLevel: "error" })
    .then((all) => all.map((c) => c.id))
    .catch(() => null);
  if (ids && !ids.includes(id)) {
    return new Error(`remotion clip ${clip}: the entry has no composition "${id}". Its compositions: ${ids.join(", ") || "none"}. Set props.composition to one of them.`);
  }
  return error instanceof Error ? error : new Error(String(error));
}

/** True for values that survive JSON unchanged: input props reach the page as JSON. */
function isPlainJson(value: unknown): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isPlainJson);
  if (typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return (proto === Object.prototype || proto === null) && Object.values(value).every(isPlainJson);
}
