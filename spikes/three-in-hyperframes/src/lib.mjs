// Shared helpers of the spike: project assembly, managed binaries, the plugin's live page server, pixel decoding.
// Uses the BUILT plugin and core (pnpm build) so the spike exercises the same adapter, runtime and Chrome as the app.
import { execFile } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { join, posix, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { checker, glb } from "./fixtures.mjs";

export const execFileAsync = promisify(execFile);
export const spikeRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
export const repoRoot = resolve(spikeRoot, "..", "..");
const pluginDir = join(repoRoot, "plugins", "hyperframes");
export const outRoot = join(spikeRoot, "out");

const pluginRequire = createRequire(join(pluginDir, "package.json"));
export const puppeteer = pluginRequire("puppeteer-core");
const importFrom = (file) => import(pathToFileURL(file).href);
const { createHyperframesAdapter } = await importFrom(join(pluginDir, "dist", "index.js"));
const { MOTION_RUNTIME, MOTION_RUNTIME_FILE } = await importFrom(join(pluginDir, "dist", "motion-runtime.js"));
const { BinaryManager } = await importFrom(join(repoRoot, "packages", "core", "dist", "index.js"));
export { createHyperframesAdapter };

const binariesDir = process.env.FRAMESHELL_TEST_BINARIES_DIR || join(repoRoot, ".cache", "test-binaries");
export const manager = new BinaryManager({ dataDir: binariesDir, configDir: binariesDir });
export const ensureBinary = (name) => manager.ensure(name);

/** Chrome flags of the producer's software mode (engine browserManager getBrowserGpuArgs) plus its colour flags. */
export const SOFTWARE_FLAGS = [
  "--use-gl=angle",
  "--use-angle=swiftshader",
  "--enable-unsafe-swiftshader",
  "--font-render-hinting=none",
  "--force-color-profile=srgb",
  "--force-device-scale-factor=1",
];

export const DEFAULTS = {
  width: 1920,
  height: 1080,
  fps: 30,
  duration: 1,
  msaa: true,
  shadows: "vsm", // vsm (soft) | pcf (hard edges in r187) | off
  shadowRadius: 8,
  shadowBlurSamples: 8,
  shadowMap: 1024,
  pmremSize: 256,
  loadMode: "sync", // sync | late | none
  lateMs: 400,
  finish: true,
  preserveDrawingBuffer: false,
  bundle: "curated-addons",
};

/** Writes a project with one hyperframes composition `three`; returns { dir, clip, config }. */
export function makeProject(name, overrides = {}) {
  const config = { ...DEFAULTS, ...overrides };
  const dir = join(outRoot, "projects", name);
  rmSync(dir, { recursive: true, force: true });
  const comp = join(dir, "compositions", "hyperframes", "three");
  mkdirSync(comp, { recursive: true });
  const html = readFileSync(join(spikeRoot, "composition", config.template ?? "index.html"), "utf8")
    .replaceAll("{{W}}", String(config.width))
    .replaceAll("{{H}}", String(config.height))
    .replaceAll("{{DUR}}", String(config.duration));
  writeFileSync(join(comp, "index.html"), html);
  writeFileSync(join(comp, MOTION_RUNTIME_FILE), MOTION_RUNTIME);
  if (!config.template) cpSync(join(outRoot, "bundles", `${config.bundle}.js`), join(comp, "frameshell-three.js"));
  // GLTFLoader is an addon: the bundle must carry it. checker.png and product.glb stay inside the composition so the cache key hashes them.
  writeFileSync(join(comp, "checker.png"), checker());
  writeFileSync(join(comp, "product.glb"), glb());
  writeFileSync(join(comp, "spike-config.js"), `window.SPIKE = ${JSON.stringify(config)};\n`);
  return { dir, config, clip: { id: `c_${name}`, source: "compositions/hyperframes/three/index.html" }, comp };
}

export function adapterFor(project) {
  return createHyperframesAdapter({ projectDir: project.dir });
}

/** Runs the plugin's own render path (producer in-process) for the project's clip. */
export async function renderClip(project, outDir) {
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const adapter = adapterFor(project);
  const t0 = performance.now();
  const result = await adapter.render(project.clip, {
    projectDir: project.dir,
    outDir,
    fps: project.config.fps,
    width: project.config.width,
    height: project.config.height,
    signal: new AbortController().signal,
    ensureBinary,
    progress: () => {},
  });
  return { file: result.file, seconds: (performance.now() - t0) / 1000 };
}

/**
 * Renders the clip's composition to a lossless PNG sequence with the producer (same engine, Chrome and flags as the adapter's WebM render).
 * Returns the frame files in order. The adapter itself only writes WebM, so this is how the spike reads exact pixels of the real render path.
 */
export async function renderPngSequence(project, outDir, { fps = project.config.fps } = {}) {
  const [ffmpeg, ffprobe, chrome] = await Promise.all([ensureBinary("ffmpeg"), ensureBinary("ffprobe"), ensureBinary("chrome-headless-shell")]);
  process.env.HYPERFRAMES_FFMPEG_PATH = ffmpeg;
  process.env.HYPERFRAMES_FFPROBE_PATH = ffprobe;
  process.env.PRODUCER_HEADLESS_SHELL_PATH = chrome;
  const producer = await importFrom(join(pluginDir, "node_modules", "@hyperframes", "producer", "dist", "index.js"));
  const composition = join(outDir, "composition");
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  cpSync(project.comp, composition, { recursive: true });
  const out = join(outDir, "frames");
  const job = producer.createRenderJob({ fps, quality: "standard", format: "png-sequence", entryFile: "index.html", variables: {} });
  const t0 = performance.now();
  await producer.executeRenderJob(job, composition, out, () => {}, new AbortController().signal);
  const seconds = (performance.now() - t0) / 1000;
  const files = readdirSync(out).filter((f) => f.endsWith(".png")).sort().map((f) => join(out, f));
  return { files, seconds };
}

/** Serves the composition as the app's live scheme does; returns { url, close, live }. */
export async function serveLive(project) {
  const adapter = adapterFor(project);
  const live = await adapter.livePreview(project.clip, { projectDir: project.dir, fps: project.config.fps, width: project.config.width, height: project.config.height, ensureBinary });
  const server = createServer((request, response) => {
    const path = posix.join(live.root, decodeURIComponent(new URL(request.url ?? "/", "http://x").pathname));
    readFile(join(project.dir, ...path.split("/"))).then(
      (body) => {
        const isHtml = path === live.entry;
        const type = path.endsWith(".png") ? "image/png" : path.endsWith(".glb") ? "model/gltf-binary" : isHtml ? "text/html" : "text/javascript";
        response.writeHead(200, { "content-type": type });
        response.end(isHtml ? body.toString("utf8").replace(/<head>/i, () => `<head><script>${live.head}</script>`) : body);
      },
      () => response.writeHead(404).end(),
    );
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}/${posix.basename(live.entry)}`;
  return { url, live, close: () => server.close() };
}

export async function launch(extraArgs = []) {
  const chrome = await ensureBinary("chrome-headless-shell");
  return puppeteer.launch({ executablePath: chrome, args: [...SOFTWARE_FLAGS, ...extraArgs] });
}

export async function openLive(browser, served, project, errors = []) {
  const page = await browser.newPage();
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") errors.push(`${m.type()}: ${m.text()}`);
  });
  await page.setViewport({ width: project.config.width, height: project.config.height });
  await page.goto(served.url);
  await page.evaluate("window.frameshellLive.ready");
  return page;
}

let scratchN = 0;
/** RGBA bytes of a PNG, decoded by the managed ffmpeg. */
export async function pixelsOfPng(file) {
  const ffmpeg = await ensureBinary("ffmpeg");
  const { stdout } = await execFileAsync(ffmpeg, ["-v", "error", "-i", file, "-f", "rawvideo", "-pix_fmt", "rgba", "-"], { encoding: "buffer", maxBuffer: 1 << 28 });
  return stdout;
}

export async function pixelsOfPngBytes(bytes) {
  const file = join(outRoot, `scratch-${process.pid}-${scratchN++}.png`);
  mkdirSync(outRoot, { recursive: true });
  writeFileSync(file, bytes);
  try {
    return await pixelsOfPng(file);
  } finally {
    rmSync(file, { force: true });
  }
}

/** RGBA bytes of the frame at `t` of a VP9 alpha WebM, decoded with libvpx (keeps alpha). */
export async function pixelsOfWebm(file, t) {
  const ffmpeg = await ensureBinary("ffmpeg");
  const { stdout } = await execFileAsync(
    ffmpeg,
    ["-v", "error", "-c:v", "libvpx-vp9", "-ss", String(t), "-i", file, "-frames:v", "1", "-vf", "format=rgba", "-f", "rawvideo", "-"],
    { encoding: "buffer", maxBuffer: 1 << 28 },
  );
  return stdout;
}

export const maxDiff = (a, b) => {
  if (a.length !== b.length) throw new Error(`size mismatch ${a.length} vs ${b.length}`);
  let worst = 0;
  let sum = 0;
  let over = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i] - b[i]);
    if (d > worst) worst = d;
    sum += d;
    if (d > 2) over++;
  }
  return { worst, mean: sum / a.length, over2: over };
};

export const median = (xs) => {
  const s = [...xs].sort((x, y) => x - y);
  return s.length === 0 ? NaN : s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
export const round = (n, d = 1) => Math.round(n * 10 ** d) / 10 ** d;

export const alphaAt = (rgba, width, x, y) => rgba[(y * width + x) * 4 + 3];
export const rgbaAt = (rgba, width, x, y) => Array.from(rgba.subarray((y * width + x) * 4, (y * width + x) * 4 + 4));
export { existsSync };
