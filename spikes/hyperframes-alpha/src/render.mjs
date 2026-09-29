// PROTOTYPE, throwaway (ticket #3). Renders composition/ headlessly via
// @hyperframes/producer, then verifies alpha. No CLI involved.
//
// Usage: node src/render.mjs [mov|webm|png-sequence] [--quality draft|standard|high] [--workers N]
import { createRenderJob, executeRenderJob } from "@hyperframes/producer";
import { copyFileSync, mkdirSync, statSync, readdirSync, existsSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { FFMPEG, FFPROBE, probe, alphaAt, SAMPLES } from "./ff.mjs";

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const projectDir = join(root, "composition");
const outDir = join(root, "out");

const format = process.argv[2] ?? "mov";
const qIdx = process.argv.indexOf("--quality");
const quality = qIdx > 0 ? process.argv[qIdx + 1] : "standard";
const wIdx = process.argv.indexOf("--workers");
const workers = wIdx > 0 ? Number(process.argv[wIdx + 1]) : undefined;

// Producer resolves ffmpeg via these env vars before PATH; point at ffmpeg-static.
process.env.HYPERFRAMES_FFMPEG_PATH = FFMPEG;
process.env.HYPERFRAMES_FFPROBE_PATH = FFPROBE;

// Serve GSAP from disk: render must not depend on a CDN.
copyFileSync(require.resolve("gsap/dist/gsap.min.js"), join(projectDir, "gsap.min.js"));
mkdirSync(outDir, { recursive: true });

const ext = { mov: ".mov", webm: ".webm", "png-sequence": "" }[format];
if (ext === undefined) throw new Error(`unsupported format ${format}`);
const outputPath = join(outDir, `title-card-${quality}${format === "png-sequence" ? "-png" : ext}`);
if (existsSync(outputPath)) rmSync(outputPath, { recursive: true });

const job = createRenderJob({ fps: 30, quality, format, ...(workers ? { workers } : {}) });

let lastPct = -1;
const t0 = performance.now();
await executeRenderJob(job, projectDir, outputPath, (j, msg) => {
  const pct = Math.floor((j.progress ?? 0) / 10) * 10;
  if (pct !== lastPct) {
    lastPct = pct;
    console.error(`  [${pct}%] ${msg ?? ""}`);
  }
});
const seconds = (performance.now() - t0) / 1000;

// Size and the file to probe (first PNG for sequences).
let bytes, probeTarget, frameCount;
if (format === "png-sequence") {
  const pngs = readdirSync(outputPath).filter((f) => f.endsWith(".png")).sort();
  frameCount = pngs.length;
  bytes = pngs.reduce((n, f) => n + statSync(join(outputPath, f)).size, 0);
  probeTarget = join(outputPath, pngs[Math.round(3 * 30)]); // ~t=3s
} else {
  bytes = statSync(outputPath).size;
  probeTarget = outputPath;
}

const info = probe(probeTarget);
const alpha = SAMPLES.map((s) => ({
  ...s,
  alpha: alphaAt(probeTarget, format === "png-sequence" ? null : s.t, s.x, s.y, info.codec),
}));

const result = {
  format,
  quality,
  workers: workers ?? "auto",
  lowMemoryMode: process.env.PRODUCER_LOW_MEMORY_MODE ?? "auto",
  outputPath,
  renderSeconds: +seconds.toFixed(2),
  bytes,
  megabytes: +(bytes / 1024 / 1024).toFixed(1),
  frameCount: frameCount ?? info.frames,
  ...info,
  alphaSamples: alpha,
  // VP9 alpha lives in a side channel: ffprobe says yuv420p, only the alpha_mode tag tells.
  hasAlpha:
    (/yuva|rgba|argb|gbrap|ya/.test(info.pixFmt ?? "") || info.alphaModeTag === "1") &&
    alpha.some((a) => a.alpha < 255),
};
console.log(JSON.stringify(result, null, 2));
// Producer logs to stdout too; bench.mjs greps this one-line marker.
console.log("RESULT " + JSON.stringify(result));
