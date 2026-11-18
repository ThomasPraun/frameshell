import { spawn } from "node:child_process";
import { mkdir, readdir } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { join, posix, win32 } from "node:path";
import type { ClipAdapter, InputsContext, PropsSchema, PropsValidation, RenderContext } from "@frameshell/plugin-api";
import { type BlenderEvent, SUPPORTED_BLENDER, VersionProbe, runBlender, scriptPath } from "./blender.js";
import { BlendDeps, STATE_DIR, listingPath, marker } from "./deps.js";
import { FinalTimes } from "./finals.js";
import { sweepState } from "./state-gc.js";

/** Clip type this adapter registers. */
export const CLIP_TYPE = "blender";

/** Validated clip `props`. The .blend itself is the clip's `source`. */
export interface BlenderProps {
  /** Scene of the file to render; default: the scene the file opens with. */
  scene?: string;
  /** Camera object to render through; default: the scene's active camera. */
  camera?: string;
}

/** Timeline clip fields the adapter reads. */
interface BlenderClip {
  id: string;
  source?: string;
  in?: number;
  duration: number;
  props?: BlenderProps;
}

const EXAMPLE = '{ "scene": "Scene", "camera": "Camera" }';

/**
 * `props` = `{ scene?, camera? }` and nothing else: no agent Python reaches Blender (ADR 0035 decision 8), the frame
 * range is the clip's own `in` and duration, and draft or final is the export's choice, not a prop (ADR 0041 decision 11).
 */
export const propsSchema: PropsSchema = {
  "~standard": {
    version: 1,
    vendor: "frameshell-blender",
    validate(value: unknown): PropsValidation {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return { issues: [{ message: `props must be an object, e.g. ${EXAMPLE}` }] };
      }
      const { scene, camera, ...rest } = value as Record<string, unknown>;
      const issues: { message: string; path?: string[] }[] = [];
      for (const [key, name] of [["scene", scene], ["camera", camera]] as const) {
        if (name !== undefined && (typeof name !== "string" || name === "" || name.length > 255)) {
          issues.push({ message: `${key} must be the name of a ${key} in the .blend file, e.g. ${EXAMPLE}`, path: [key] });
        }
      }
      for (const key of Object.keys(rest)) {
        const message =
          key === "file"
            ? "unknown prop file: the .blend is the clip's `source`, e.g. --source scenes/intro.blend"
            : key === "quality"
              ? "unknown prop quality: every blender clip has a draft render (EEVEE) and a final one (Cycles). `render --quality draft` " +
                "exports the drafts; `render --quality final`, or no --quality, renders the finals. Remove quality from props."
              : `unknown prop ${key}: props are scene and camera. The frame range is the clip's own in and duration, and no scripts run.`;
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
 * its PNG frames to VP9 WebM with alpha. The cache key covers the file, the files it loads (inside the project by path,
 * outside it by content), the Blender version and the length rendered. A scene at another frame rate than the project
 * is time-remapped, seconds kept. Each clip has a draft render (EEVEE or Workbench) and a final one (Cycles), which
 * the host makes only when an export waits for it.
 */
export function createBlenderAdapter(options: BlenderAdapterOptions): ClipAdapter {
  const { projectDir } = options;
  const versions = new VersionProbe();
  const deps = new BlendDeps(projectDir);
  const times = new FinalTimes(projectDir);
  return {
    type: CLIP_TYPE,
    propsSchema,
    finals: {
      // `renderWindow` draws only [in, in + duration) and the range marker in `inputs` keys it: a still final is one frame of it.
      windowed: true,
      estimate: (clip, ctx) => times.estimate(sourceOf(clip as BlenderClip), renderWindow(clip as BlenderClip, ctx.fps).frames, ctx.width, ctx.height),
    },
    async inputs(clip, context?: InputsContext) {
      if (!context) throw new Error("this Frameshell is too old for the blender plugin: update Frameshell");
      const source = sourceOf(clip as BlenderClip);
      const blender = await context.ensureBinary("blender");
      const version = await versions.version(blender);
      const info = await deps.hash(source);
      // The host's stop ends a listing's Blender (up to 5 minutes), so none outlives the daemon.
      const linked = await deps.list(source, blender, info, context.signal);
      // Files outside the project enter the key by content only (ADR 0035 slice 4): no absolute path in the project.
      const outside = await deps.outsideKey(source, info, linked.outside);
      return [
        source,
        // The key hashes files, so the version and the length rendered travel as files named by them.
        await marker(projectDir, `${STATE_DIR}/version/${version}.json`, `${JSON.stringify({ blender: version })}\n`),
        await marker(projectDir, `${STATE_DIR}/range/${inMs(clip as BlenderClip)}-${endMs(clip as BlenderClip)}ms.json`, `${JSON.stringify({ inMs: inMs(clip as BlenderClip), endMs: endMs(clip as BlenderClip) })}\n`),
        listingPath(source, info),
        ...linked.inside,
        ...(outside ? [outside] : []),
      ];
    },
    async gc(context) {
      const removed = await sweepState(context);
      if (!context.dryRun) deps.forget(removed.map((entry) => entry.path));
      return removed;
    },
    async render(clip, ctx: RenderContext) {
      const { id } = clip as BlenderClip;
      const source = sourceOf(clip as BlenderClip);
      const props = (clip as BlenderClip).props ?? {};
      const blender = await ctx.ensureBinary("blender");
      const version = await versions.version(blender);
      const ffmpeg = await ctx.ensureBinary("ffmpeg");
      const { outside } = await deps.list(source, blender, await deps.hash(source));
      if (outside.length > 0) ctx.warn?.(outsideWarning(id, source, outside));
      const { startFrame, frames } = renderWindow(clip as BlenderClip, ctx.fps);
      // Hosts older than finals pass no tier: they get the draft, as before.
      const quality = ctx.tier === "final" ? "final" : "draft";
      const framesDir = join(ctx.outDir, "frames");
      await mkdir(framesDir, { recursive: true });
      ctx.progress({ fraction: 0, message: `Starting Blender ${version}` });
      // `Fra:` lines name scene frames: the scene's first frame plus the window's start is where the window begins.
      let first = startFrame + 1;
      const rendering = quality === "final" ? "Rendering the final (Cycles)" : "Rendering";
      const fraction = (done: number) => ctx.progress({ fraction: RENDER_SHARE * Math.min(1, Math.max(0, done / frames)), message: rendering });
      const frameSeconds: number[] = [];
      const { error } = await runBlender(
        blender,
        join(projectDir, ...source.split("/")),
        scriptPath("render.py"),
        { scene: props.scene ?? null, camera: props.camera ?? null, width: ctx.width, height: ctx.height, fps: ctx.fps, startFrame, frames, outDir: framesDir, quality },
        {
          cwd: ctx.outDir,
          signal: ctx.signal,
          onEvent: (event: BlenderEvent) => {
            if (event.event === "start") first = event.frameStart + startFrame;
            else if (event.event === "frame") {
              fraction(event.index + 1);
              if (typeof event.seconds === "number") frameSeconds.push(event.seconds);
            }
          },
          onFrame: (frame) => fraction(frame - first),
        },
      );
      if (error) throw new Error(describeRefusal(id, source, error, ctx.fps));
      const rendered = (await readdir(framesDir)).filter((name) => /^frame_\d{6}\.png$/.test(name)).length;
      if (rendered !== frames) throw new Error(`blender clip ${id}: Blender wrote ${rendered} of ${frames} frames of ${source}. Open the file in Blender and render it there to see why.`);
      // The first frame also pays for scene sync and, once per Blender and GPU, the Metal kernel compile: only later frames
      // measure the rate. A wrong estimate only changes when the next final asks first: it must never fail this render.
      const later = frameSeconds.slice(1);
      if (quality === "final" && later.length > 0) {
        const seconds = later.reduce((sum, value) => sum + value, 0);
        await times.record(source, seconds, later.length, ctx.width, ctx.height).catch(() => {});
      }
      ctx.progress({ fraction: RENDER_SHARE, message: "Encoding" });
      const output = join(ctx.outDir, "render.webm");
      await encode(ffmpeg, framesDir, output, { fps: ctx.fps, width: ctx.width, height: ctx.height, pad: startFrame }, ctx.signal);
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

/** Composition time of the clip's first frame in whole milliseconds, only to name the key's range file (frames come from {@link renderWindow}). */
function inMs(clip: BlenderClip): number {
  return Math.round((clip.in ?? 0) * 1000);
}

/** Composition time of the clip's last frame in whole milliseconds, only to name the key's range file (frames come from {@link renderWindow}). */
function endMs(clip: BlenderClip): number {
  return Math.round(((clip.in ?? 0) + clip.duration) * 1000);
}

/**
 * Frames up to the clip's end at the project's `fps`, counted from the scene's first frame, so file time t shows
 * composition time t. `render.py` shows each at its time on the scene's own clock, so a scene at another rate keeps seconds.
 * Counted from the unrounded end; 1e-3 of a frame absorbs the float error of ends snapped to the frame grid
 * (92/30 s * 30 is 92.00000000000001), which must not ask for one frame more. Always at least one past the window's start.
 */
export function frameCount(clip: BlenderClip, fps: number): number {
  return Math.max(startFrameOf(clip, fps) + 1, Math.ceil(((clip.in ?? 0) + clip.duration) * fps - 1e-3));
}

/** First frame of the clip's part (`in`), counted from the scene's first frame; the same 1e-3 of a frame as {@link frameCount}. */
function startFrameOf(clip: BlenderClip, fps: number): number {
  return Math.max(0, Math.floor((clip.in ?? 0) * fps + 1e-3));
}

/**
 * What a render draws (ADR 0035 slice 6): the clip's part only, frames `startFrame` up to {@link frameCount}. `frames` is
 * the length of that window: how many files `render.py` writes, what progress counts and what a final is estimated on.
 * The head before it is not rendered; the encode pads it transparent, so file time t is still composition time t.
 */
export function renderWindow(clip: BlenderClip, fps: number): { startFrame: number; frames: number } {
  const startFrame = startFrameOf(clip, fps);
  return { startFrame, frames: frameCount(clip, fps) - startFrame };
}

/** `-framerate` value for the PNG sequence: NTSC rates as the exact fraction (29.97 is 30000/1001), others as they are. */
export function frameRate(fps: number): string {
  for (const whole of [24, 30, 60, 120]) {
    if (Math.abs(fps - (whole * 1000) / 1001) < 0.002) return `${whole * 1000}/1001`;
  }
  return String(fps);
}

/**
 * The warning a render of `source` carries when it loads `outside` files (absolute paths): their content is in the key,
 * but nothing watches them, so an edit to one re-renders only when the clip's key is next checked.
 */
export function outsideWarning(clip: string, source: string, outside: readonly string[]): string {
  const shown = outside.slice(0, OUTSIDE_SHOWN).join(", ") + (outside.length > OUTSIDE_SHOWN ? ` and ${outside.length - OUTSIDE_SHOWN} more` : "");
  const one = outside.length === 1;
  return (
    `blender clip ${clip}: ${source} loads ${one ? "a file" : `${outside.length} files`} from outside the project (${shown}); ` +
    `${one ? "its" : "their"} content is in the render key, but Frameshell does not watch ${one ? "it" : "them"}: ` +
    `copy ${one ? "it" : "them"} into the project and relink to re-render on every change.`
  );
}

/** Outside files a warning names before it says how many more. */
const OUTSIDE_SHOWN = 5;

/** The fix-it message for a refusal of the shipped script. */
export function describeRefusal(clip: string, source: string, error: Extract<BlenderEvent, { event: "error" }>, projectFps: number): string {
  const at = `blender clip ${clip}`;
  const list = (names: unknown) => (Array.isArray(names) && names.length > 0 ? names.join(", ") : "none");
  switch (error.code) {
    case "range": {
      const start = Number(error["frameStart"]);
      const end = Number(error["frameEnd"]);
      const sceneFps = Number(error["sceneFps"]);
      // The scene frame the clip's last frame shows (fractional when the scene runs at another rate).
      const last = Number(error["lastFrame"]);
      const rate = Number.isFinite(sceneFps) && Math.abs(sceneFps - projectFps) > 0.001 ? ` (the scene runs at ${Number(sceneFps.toFixed(3))} fps, the project at ${projectFps})` : "";
      const needs = Number.isFinite(last) ? `scene frames ${start} to ${Number(last.toFixed(3))}` : `${Number(error["frames"])} frames from the scene's first frame (${start})`;
      return (
        `${at}: it needs ${needs}${rate} but scene "${String(error["scene"])}" of ${source} ends at frame ${end} ` +
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
 * this adapter's own choice (ADR 0035), not Remotion's. With `pad` frames (a clip trimmed at the head) that many transparent
 * frames are concatenated before the sequence; with none the command is the plain one.
 */
async function encode(
  ffmpeg: string,
  framesDir: string,
  output: string,
  format: { fps: number; width: number; height: number; pad: number },
  signal: AbortSignal,
): Promise<void> {
  const { fps, width, height, pad } = format;
  const threads = String(Math.min(16, Math.max(1, availableParallelism())));
  const rate = frameRate(fps);
  const frames = ["-framerate", rate, "-start_number", "0", "-i", join(framesDir, "frame_%06d.png")];
  // `d` is half a frame short of `pad` frames: the source then ends after exactly `pad`, whatever the float error of the rate.
  const padded = [
    "-f", "lavfi", "-i", `color=c=black@0.0:s=${width}x${height}:r=${rate}:d=${((pad - 0.5) / fps).toFixed(6)},format=yuva420p`,
    ...frames,
    "-filter_complex", "[1:v]format=yuva420p[body];[0:v][body]concat=n=2:v=1:a=0[padded]", "-map", "[padded]",
  ];
  const args = [
    "-hide_banner", "-loglevel", "error", "-y",
    ...(pad > 0 ? padded : frames),
    "-an","-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-auto-alt-ref", "0", "-b:v", "0", "-crf", "20",
    "-row-mt", "1", "-threads", threads, "-deadline", "good", "-cpu-used", "4",
    // Without these the WebM muxer writes random UIDs: two encodes of the same frames would differ in bytes.
    "-fflags", "+bitexact", "-flags:v", "+bitexact",
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
