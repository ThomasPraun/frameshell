import { spawn } from "node:child_process";
import { mkdir, readdir } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { join, posix, win32 } from "node:path";
import type { ClipAdapter, InputsContext, PropsSchema, PropsValidation, RenderContext } from "@frameshell/plugin-api";
import { type BlenderEvent, SUPPORTED_BLENDER, VersionProbe, runBlender, scriptPath } from "./blender.js";
import { BlendDeps, STATE_DIR, listingPath, marker } from "./deps.js";

/** Clip type this adapter registers. */
export const CLIP_TYPE = "blender";

/** Validated clip `props`. The .blend itself is the clip's `source`. */
export interface BlenderProps {
  /** Scene of the file to render; default: the scene the file opens with. */
  scene?: string;
  /** Camera object to render through; default: the scene's active camera. */
  camera?: string;
  /** `draft` (EEVEE or Workbench), the only one in this version; default `draft`. */
  quality?: "draft";
}

/** Timeline clip fields the adapter reads. */
interface BlenderClip {
  id: string;
  source?: string;
  in?: number;
  duration: number;
  props?: BlenderProps;
}

const EXAMPLE = '{ "scene": "Scene", "camera": "Camera", "quality": "draft" }';

/**
 * `props` = `{ scene?, camera?, quality? }` and nothing else: no agent Python reaches Blender (ADR 0035
 * decision 8), and the frame range is the clip's own `in` and duration.
 */
export const propsSchema: PropsSchema = {
  "~standard": {
    version: 1,
    vendor: "frameshell-blender",
    validate(value: unknown): PropsValidation {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return { issues: [{ message: `props must be an object, e.g. ${EXAMPLE}` }] };
      }
      const { scene, camera, quality, ...rest } = value as Record<string, unknown>;
      const issues: { message: string; path?: string[] }[] = [];
      for (const [key, name] of [["scene", scene], ["camera", camera]] as const) {
        if (name !== undefined && (typeof name !== "string" || name === "" || name.length > 255)) {
          issues.push({ message: `${key} must be the name of a ${key} in the .blend file, e.g. ${EXAMPLE}`, path: [key] });
        }
      }
      if (quality !== undefined && quality !== "draft") {
        const message =
          quality === "final"
            ? 'quality "final" is not available in this version: clips render as drafts (EEVEE or Workbench). Omit quality or use "draft".'
            : 'quality must be "draft" (the only one in this version), or be omitted';
        issues.push({ message, path: ["quality"] });
      }
      for (const key of Object.keys(rest)) {
        const message =
          key === "file"
            ? "unknown prop file: the .blend is the clip's `source`, e.g. --source scenes/intro.blend"
            : `unknown prop ${key}: props are scene, camera and quality. The frame range is the clip's own in and duration, and no scripts run.`;
        issues.push({ message, path: [key] });
      }
      return issues.length > 0 ? { issues } : { value };
    },
  },
};

/** Options for {@link createBlenderAdapter}. */
export interface BlenderAdapterOptions {
  /** Project the plugin is loaded for; clip `source` paths are relative to it. */
  projectDir: string;
}

/**
 * The `blender` clip adapter (ADR 0035). A clip's `source` is a `.blend` inside the project. Blender is the
 * person's own install (`binaries.blender`), run once per render as a separate process; the managed ffmpeg encodes
 * its PNG frames to VP9 WebM with alpha. The cache key covers the file, the in-project files it loads, the Blender
 * version and the length rendered.
 */
export function createBlenderAdapter(options: BlenderAdapterOptions): ClipAdapter {
  const { projectDir } = options;
  const versions = new VersionProbe();
  const deps = new BlendDeps(projectDir);
  return {
    type: CLIP_TYPE,
    propsSchema,
    async inputs(clip, context?: InputsContext) {
      if (!context) throw new Error("this Frameshell is too old for the blender plugin: update Frameshell");
      const source = sourceOf(clip as BlenderClip);
      const blender = await context.ensureBinary("blender");
      const version = await versions.version(blender);
      const info = await deps.hash(source);
      const linked = await deps.list(source, blender, info);
      return [
        source,
        // The key hashes files, so the version and the length rendered travel as files named by them.
        await marker(projectDir, `${STATE_DIR}/version/${version}.json`, `${JSON.stringify({ blender: version })}\n`),
        await marker(projectDir, `${STATE_DIR}/range/${endMs(clip as BlenderClip)}ms.json`, `${JSON.stringify({ endMs: endMs(clip as BlenderClip) })}\n`),
        listingPath(source, info),
        ...linked,
      ];
    },
    async render(clip, ctx: RenderContext) {
      const { id } = clip as BlenderClip;
      const source = sourceOf(clip as BlenderClip);
      const props = (clip as BlenderClip).props ?? {};
      const blender = await ctx.ensureBinary("blender");
      const version = await versions.version(blender);
      const ffmpeg = await ctx.ensureBinary("ffmpeg");
      const frames = frameCount(clip as BlenderClip, ctx.fps);
      const framesDir = join(ctx.outDir, "frames");
      await mkdir(framesDir, { recursive: true });
      ctx.progress({ fraction: 0, message: `Starting Blender ${version}` });
      let first = 1;
      const fraction = (done: number) => ctx.progress({ fraction: RENDER_SHARE * Math.min(1, Math.max(0, done / frames)), message: "Rendering" });
      const { error } = await runBlender(
        blender,
        join(projectDir, ...source.split("/")),
        scriptPath("render.py"),
        { scene: props.scene ?? null, camera: props.camera ?? null, width: ctx.width, height: ctx.height, fps: ctx.fps, frames, outDir: framesDir, quality: "draft" },
        {
          cwd: ctx.outDir,
          signal: ctx.signal,
          onEvent: (event: BlenderEvent) => {
            if (event.event === "start") first = event.frameStart;
            else if (event.event === "frame") fraction(event.index + 1);
          },
          onFrame: (frame) => fraction(frame - first),
        },
      );
      if (error) throw new Error(describeRefusal(id, source, error, ctx.fps));
      const rendered = (await readdir(framesDir)).filter((name) => /^frame_\d{6}\.png$/.test(name)).length;
      if (rendered !== frames) throw new Error(`blender clip ${id}: Blender wrote ${rendered} of ${frames} frames of ${source}. Open the file in Blender and render it there to see why.`);
      ctx.progress({ fraction: RENDER_SHARE, message: "Encoding" });
      const output = join(ctx.outDir, "render.webm");
      await encode(ffmpeg, framesDir, output, ctx.fps, ctx.signal);
      ctx.progress({ fraction: 1, message: "Done" });
      return { file: output, hasAlpha: true };
    },
  };
}

/** Share of the progress bar for Blender; the VP9 encode takes the rest. */
const RENDER_SHARE = 0.9;

/**
 * Project-relative `/` path of the clip's `.blend`. Throws when `source` is missing, absolute, uses `\`,
 * leaves the project, or is not a `.blend`.
 */
export function sourceOf(clip: BlenderClip): string {
  const { id, source } = clip;
  const example = "scenes/intro.blend";
  if (!source) throw new Error(`blender clip ${id} needs \`source\`: the .blend file, e.g. ${example}`);
  if (source.includes("\\") || posix.isAbsolute(source) || win32.isAbsolute(source)) {
    throw new Error(`blender clip ${id} has source ${source}; use a /-separated path relative to the project, e.g. ${example}`);
  }
  const normal = posix.normalize(source);
  if (normal === ".." || normal.startsWith("../")) throw new Error(`blender clip ${id} has source ${source}, outside the project: the .blend must be inside it, e.g. ${example}`);
  if (!normal.toLowerCase().endsWith(".blend")) throw new Error(`blender clip ${id} has source ${source}, which is not a .blend file.`);
  return normal;
}

/** Composition time of the clip's last frame in whole milliseconds, only to name the key's range file (frames come from {@link frameCount}). */
function endMs(clip: BlenderClip): number {
  return Math.round(((clip.in ?? 0) + clip.duration) * 1000);
}

/**
 * Frames of the scene to render, from its first, so file time t shows composition time t: up to the clip's end at `fps`.
 * Counted from the unrounded end; 1e-3 of a frame absorbs the float error of ends snapped to the frame grid
 * (92/30 s * 30 is 92.00000000000001), which must not ask for one frame more.
 */
export function frameCount(clip: BlenderClip, fps: number): number {
  return Math.max(1, Math.ceil(((clip.in ?? 0) + clip.duration) * fps - 1e-3));
}

/** `-framerate` value for the PNG sequence: NTSC rates as the exact fraction (29.97 is 30000/1001), others as they are. */
export function frameRate(fps: number): string {
  for (const whole of [24, 30, 60, 120]) {
    if (Math.abs(fps - (whole * 1000) / 1001) < 0.002) return `${whole * 1000}/1001`;
  }
  return String(fps);
}

/** The fix-it message for a refusal of the shipped script. */
export function describeRefusal(clip: string, source: string, error: Extract<BlenderEvent, { event: "error" }>, projectFps: number): string {
  const at = `blender clip ${clip}`;
  const list = (names: unknown) => (Array.isArray(names) && names.length > 0 ? names.join(", ") : "none");
  switch (error.code) {
    case "fps": {
      const scene = String(error["scene"]);
      const sceneFps = Number(error["sceneFps"]);
      return (
        `${at}: scene "${scene}" of ${source} runs at ${Number(sceneFps.toFixed(3))} fps but the project runs at ${projectFps} fps. ` +
        `Set the scene's frame rate to ${projectFps} (Output properties, Frame Rate) and save; frames are never remapped to another rate.`
      );
    }
    case "range": {
      const start = Number(error["frameStart"]);
      const end = Number(error["frameEnd"]);
      return (
        `${at}: it needs ${Number(error["frames"])} frames from the scene's first frame (${start}) but scene "${String(error["scene"])}" of ${source} ends at frame ${end} ` +
        `(${end - start + 1} frames). Raise its End frame or shorten the clip.`
      );
    }
    case "scene":
      return `${at}: ${source} has no scene "${String(error["scene"])}". Its scenes: ${list(error["scenes"])}. Set props.scene to one of them.`;
    case "camera":
      return error["camera"]
        ? `${at}: ${source} has no camera object "${String(error["camera"])}". Its cameras: ${list(error["cameras"])}. Set props.camera to one of them.`
        : `${at}: scene "${String(error["scene"])}" of ${source} has no active camera. Set one in Blender, or set props.camera (cameras: ${list(error["cameras"])}).`;
    default:
      return `${at}: Blender ${SUPPORTED_BLENDER} refused ${source}: ${String(error["message"] ?? error.code)}`;
  }
}

/**
 * PNG frames to VP9 with alpha, multithreaded libvpx (`-auto-alt-ref 0` is what keeps alpha). The speed flags are
 * ADR 0009's, which `fastVp9` in `plugins/remotion/src/adapter.ts` applies to Remotion's stitcher; `-crf 20` is
 * this adapter's own choice (ADR 0035), not Remotion's.
 */
async function encode(ffmpeg: string, framesDir: string, output: string, fps: number, signal: AbortSignal): Promise<void> {
  const threads = String(Math.min(16, Math.max(1, availableParallelism())));
  const args = [
    "-hide_banner", "-loglevel", "error", "-y",
    "-framerate", frameRate(fps), "-start_number", "0", "-i", join(framesDir, "frame_%06d.png"),
    "-an", "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-auto-alt-ref", "0", "-b:v", "0", "-crf", "20",
    "-row-mt", "1", "-threads", threads, "-deadline", "good", "-cpu-used", "4",
    output,
  ];
  signal.throwIfAborted();
  const child = spawn(ffmpeg, args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => (stderr = (stderr + chunk).slice(-2000)));
  const stop = () => child.kill("SIGKILL");
  signal.addEventListener("abort", stop, { once: true });
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    signal.throwIfAborted();
    if (code !== 0) throw new Error(`ffmpeg could not encode the Blender frames (exit ${code}):\n${stderr.trim()}`);
  } finally {
    signal.removeEventListener("abort", stop);
  }
}
