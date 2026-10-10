// PROTOTYPE, throwaway. Questions 1, 2, 4, 5: render the Card composition to VP9 with alpha
// at a given project format, with the managed Chrome, then probe the file and sample alpha.
// Usage: node src/render.mjs [width height fps] [--chrome=managed|remotion] [--concurrency=N]
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { CHROME, ENTRY, OUT, PROJECT, SAMPLES, alphaAt, bundler, probe, renderer } from "./common.mjs";

const args = process.argv.slice(2);
const flag = (name) => args.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
const [width = 2560, height = 1440, fps = 30] = args.filter((a) => !a.startsWith("--")).map(Number);
const chrome = flag("chrome") ?? "managed";
const concurrency = flag("concurrency") ? Number(flag("concurrency")) : null;
// --fast: multithreaded libvpx (row-mt) at cpu-used 4, injected before the output path.
const fast = args.includes("--fast");
const FAST_VP9 = ["-row-mt", "1", "-threads", "8", "-deadline", "good", "-cpu-used", "4"];
const stitcherArgs = {};

const { bundle } = await bundler();
const { selectComposition, renderMedia } = await renderer();
await mkdir(OUT, { recursive: true });

let t = performance.now();
const serveUrl = await bundle({ entryPoint: ENTRY, rootDir: PROJECT, outDir: join(OUT, "bundles", "render") });
const bundleMs = Math.round(performance.now() - t);

const browserExecutable = chrome === "managed" ? CHROME : null;
const inputProps = { title: "Hola Remotion" };
t = performance.now();
const selected = await selectComposition({ serveUrl, id: "Card", inputProps, browserExecutable, chromeMode: "headless-shell" });
const selectMs = Math.round(performance.now() - t);
// Project format wins over the composition's own (Frameshell renders at project fps/size).
const seconds = selected.durationInFrames / selected.fps;
const composition = { ...selected, width, height, fps, durationInFrames: Math.round(seconds * fps) };

const output = join(OUT, `card-${width}x${height}-${fps}-${chrome}.webm`);
let lastLog = 0;
t = performance.now();
await renderMedia({
  composition,
  serveUrl,
  codec: "vp9",
  imageFormat: "png",
  pixelFormat: "yuva420p",
  outputLocation: output,
  inputProps,
  browserExecutable,
  chromeMode: "headless-shell",
  muted: true,
  overwrite: true,
  ...(concurrency ? { concurrency } : {}),
  ffmpegOverride: ({ type, args: ff }) => {
    stitcherArgs[type] = ff.join(" ");
    return fast ? [...ff.slice(0, -1), ...FAST_VP9, ff.at(-1)] : ff;
  },
  onProgress: ({ progress }) => {
    if (progress - lastLog >= 0.25) {
      lastLog = progress;
      process.stderr.write(`progress ${Math.round(progress * 100)}%\n`);
    }
  },
});
const renderMs = Math.round(performance.now() - t);

const k = width / 2560;
const ky = height / 1440;
const facts = probe(output);
console.log(
  JSON.stringify(
    {
      chrome,
      concurrency,
      fast,
      stitcherArgs,
      composition: { declared: { width: selected.width, height: selected.height, fps: selected.fps, frames: selected.durationInFrames }, rendered: { width, height, fps, frames: composition.durationInFrames } },
      timing: { bundleMs, selectMs, renderMs, realtimeFactor: +(renderMs / 1000 / seconds).toFixed(2) },
      file: output,
      probe: facts,
      alpha: Object.fromEntries(SAMPLES.map((s) => [s.name, alphaAt(output, 3, Math.round(s.x * k), Math.round(s.y * ky))])),
    },
    null,
    2,
  ),
);
