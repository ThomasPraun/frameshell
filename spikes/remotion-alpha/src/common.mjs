// PROTOTYPE, throwaway. Shared helpers: Remotion loaded from the Remotion project's node_modules
// (as the adapter would), managed ffmpeg and Chrome from Frameshell's caches.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const SPIKE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const PROJECT = join(SPIKE, "remotion");
export const ENTRY = join(PROJECT, "src", "index.ts");
export const OUT = join(SPIKE, "out");
const REPO = resolve(SPIKE, "..", "..");

export const FFMPEG = process.env.FFMPEG ?? join(REPO, ".cache/test-binaries/binaries/ffmpeg/9.0.2/darwin-arm64/ffmpeg");
export const FFPROBE = process.env.FFPROBE ?? join(REPO, ".cache/test-binaries/binaries/ffmpeg/9.0.2/darwin-arm64/ffprobe");
export const CHROME =
  process.env.CHROME ?? join(homedir(), "Library/Application Support/frameshell/binaries/chrome-headless-shell/154.0.8037.57/darwin-arm64/chrome-headless-shell");

/** Resolves a package the way the adapter will: from the user's Remotion project, never from the plugin. */
const projectRequire = createRequire(join(PROJECT, "package.json"));
export const bundler = () => import(projectRequire.resolve("@remotion/bundler"));
export const renderer = () => import(projectRequire.resolve("@remotion/renderer"));
export const reactDir = dirname(projectRequire.resolve("react/package.json"));
export const reactDomDir = dirname(projectRequire.resolve("react-dom/package.json"));

/** Webpack override: one React (the Remotion project's) for code imported from outside it. */
export const singleReact = (config) => ({
  ...config,
  resolve: { ...config.resolve, alias: { ...(config.resolve?.alias ?? {}), react: reactDir, "react-dom": reactDomDir } },
});

/** sha256 over every file of a directory, path-sorted: equal output = equal hash. */
export async function dirHash(dir) {
  const files = (await readdir(dir, { recursive: true, withFileTypes: true })).filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name)).sort();
  const h = createHash("sha256");
  const perFile = {};
  for (const f of files) {
    const data = await readFile(f);
    const fh = createHash("sha256").update(data).digest("hex").slice(0, 12);
    perFile[f.slice(dir.length + 1)] = fh;
    h.update(f.slice(dir.length + 1)).update(fh);
  }
  return { hash: h.digest("hex").slice(0, 16), files: perFile };
}

/**
 * Pixels checked at t=3 s, in 2560x1440 design coordinates (scaled to the
 * render size). Expected alpha: corner 0, panel ~153 (rgba 0.6), dot 255.
 */
export const SAMPLES = [
  { name: "empty corner", x: 10, y: 10 },
  { name: "panel (rgba 0.6)", x: 1150, y: 750 },
  { name: "dot (opaque)", x: 2130, y: 340 },
];

export function probe(file) {
  const out = execFileSync(FFPROBE, [
    "-v", "error", "-select_streams", "v:0", "-count_packets",
    "-show_entries", "stream=codec_name,pix_fmt,width,height,r_frame_rate,nb_read_packets:stream_tags=alpha_mode:format=duration",
    "-of", "json", file,
  ]);
  const j = JSON.parse(out);
  const s = j.streams[0];
  return {
    codec: s.codec_name,
    pixFmt: s.pix_fmt,
    alphaModeTag: s.tags?.alpha_mode ?? s.tags?.ALPHA_MODE ?? null,
    width: s.width,
    height: s.height,
    fps: s.r_frame_rate,
    frames: Number(s.nb_read_packets),
    duration: Number(j.format?.duration),
    audioStreams: JSON.parse(execFileSync(FFPROBE, ["-v", "error", "-select_streams", "a", "-show_entries", "stream=index", "-of", "json", file])).streams?.length ?? 0,
  };
}

/** Alpha of one pixel at time t, decoded with libvpx (the native vp9 decoder drops alpha, ADR 0002). */
export function alphaAt(file, t, x, y) {
  const buf = execFileSync(FFMPEG, ["-v", "error", "-ss", String(t), "-c:v", "libvpx-vp9", "-i", file, "-frames:v", "1", "-vf", `crop=1:1:${x}:${y},format=rgba`, "-f", "rawvideo", "-"]);
  return buf[3];
}

export function ffmpeg(args) {
  return execFileSync(FFMPEG, ["-hide_banner", "-v", "error", "-y", ...args], { stdio: ["ignore", "inherit", "inherit"] });
}
