// PROTOTYPE, throwaway. Where does render time go? Capture PNG frames with renderFrames(), then
// encode them with the managed ffmpeg (libvpx-vp9, alpha) under different speed settings.
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { CHROME, ENTRY, OUT, PROJECT, SAMPLES, alphaAt, bundler, ffmpeg, probe, renderer } from "./common.mjs";

const { bundle } = await bundler();
const { selectComposition, renderFrames } = await renderer();
const serveUrl = await bundle({ entryPoint: ENTRY, rootDir: PROJECT, outDir: join(OUT, "bundles", "split") });
const inputProps = { title: "Hola Remotion" };
const composition = await selectComposition({ serveUrl, id: "Card", inputProps, browserExecutable: CHROME, chromeMode: "headless-shell" });
const frames = join(OUT, "frames");
await rm(frames, { recursive: true, force: true });
let t = performance.now();
await renderFrames({ composition, serveUrl, inputProps, outputDir: frames, imageFormat: "png", browserExecutable: CHROME, chromeMode: "headless-shell", onStart: () => {}, onFrameUpdate: () => {} });
const captureMs = Math.round(performance.now() - t);

const variants = {
  "libvpx defaults": [],
  "row-mt, threads 8, cpu-used 4, good": ["-row-mt", "1", "-threads", "8", "-deadline", "good", "-cpu-used", "4", "-b:v", "0", "-crf", "30"],
  "row-mt, threads 8, cpu-used 8, realtime": ["-row-mt", "1", "-threads", "8", "-deadline", "realtime", "-cpu-used", "8", "-b:v", "0", "-crf", "30"],
};
const encode = {};
for (const [name, extra] of Object.entries(variants)) {
  const out = join(OUT, `split-${name.replace(/[^a-z0-9]+/gi, "-")}.webm`);
  t = performance.now();
  ffmpeg(["-framerate", "30", "-i", join(frames, "element-%03d.png"), "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", ...extra, "-auto-alt-ref", "0", "-metadata:s:v:0", "alpha_mode=1", out]);
  const ms = Math.round(performance.now() - t);
  const p = probe(out);
  encode[name] = { ms, mb: +(p && (await import("node:fs")).statSync(out).size / 1e6).toFixed(2), alphaModeTag: p.alphaModeTag, alpha: SAMPLES.map((s) => alphaAt(out, 3, s.x, s.y)) };
}
console.log(JSON.stringify({ captureMs, encode }, null, 2));
